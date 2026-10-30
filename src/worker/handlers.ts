/**
 * worker 任务处理器注册表（工作包 GT / task-6）。
 *
 * 职责：把 tasks 队列里的四类任务分发到真实业务动作，打通
 * **提交 → 检查 → 发布** 与 **评论提交 → 检查 → 发布** 两条闭环。
 *
 * ## 为什么 check 通过后要再入队一个 `*_publish`
 *
 * Lead 裁决（2026-10-11）推荐**职责分离**：
 *  - `*_check` 只负责"判定 + 状态转移"，做完就到 approved / needs_changes / manual_review；
 *  - 检查通过时**再 enqueue** 一个 `*_publish` 任务，由它单独负责发布。
 *
 * 这样做的理由：
 *  1. **可重试边界清晰**：发布失败（例如被撤回/被取代）不会连带重跑检查；
 *  2. **幂等容易证明**：发布任务按 `(task_type, deduplication_key)` 天然去重，
 *     且 `publishReview` 自身对 `published` 状态的提交返回 `already_published`；
 *  3. 与 `submit-review.ts` 已有的"提交后入队 review_check"模式一致，不引入第二套机制。
 *
 * ## 幂等
 *
 * 队列层面：`UNIQUE(task_type, deduplication_key)`，重复 enqueue 复用同一任务。
 * 业务层面：`publishReview*` 在事务内重新核验状态，已 `published` 直接返回
 * `{published:false, reason:'already_published'}`，**不重复切换修订指针**。
 *
 * ## 失败语义
 *
 * - **可重试**（外部依赖抖动、DB busy）：返回 `{outcome:'error', errorCode}` →
 *   队列记 attempt，按 [30s,120s] 重试，3 次后 failed。
 * - **不可重试**（数据缺失、状态不允许、参数非法）：返回 `{outcome:'skipped'}`，
 *   写明确 errorCode 并终结，避免把注定失败的活重试三次。
 */

import type { SqliteDatabase } from '@/server/platform/db';
import { nowMs } from '@/server/platform/time';
import { log } from '@/server/platform/log';
import { isDomainError } from '@/packages/common/errors';
import type { TaskType } from '@/packages/common/field-rules';
import { isVersionResolved } from '@/server/modules/moderation';
import { createModerationService } from '@/server/modules/moderation';
import { publishReview } from '@/server/workflows/publish-review';
import { publishComment } from '@/server/workflows/publish-comment';
import { createTasksService } from '@/server/modules/tasks/service';
import { createGithubCatalogProbe } from '@/server/adapters/catalog/github-probe';
import { createGithubPluginDiscovery, type PluginDiscoveryPort } from '@/server/adapters/catalog/github-discovery';
import type { CatalogProbe } from '@/server/modules/catalog/types';
import { createPluginDiscoveryService, discoveryDailyKey, DISCOVERY_DEFAULTS } from '@/server/modules/catalog/discovery';
import { recordOperationInTx } from '@/server/modules/operations';
import type { HandlerResult, TaskHandler } from './main';
import { basicScreenEnabled, createBasicContentScreen } from './content-screen';

// ============================================================
// 任务 payload 形状
// ============================================================

/** `*_check` / `*_publish` 的 payload：至少要有 submission_id。 */
export interface SubmissionTaskPayload {
  submission_id?: string;
  submissionId?: string;
}

/**
 * 从 payload 提取 submissionId，兼容 snake_case 与 camelCase。
 *
 * 为什么两者都收：`submit-review.ts` 用 `submission_id`，
 * `comments/index.ts` 用 `submissionId`。两个 Workflow 分属不同作者，
 * worker 不能假设统一命名，否则一组任务会静默取不到 ID。
 */
export function extractSubmissionId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as SubmissionTaskPayload;
  const raw = p.submission_id ?? p.submissionId;
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

// ============================================================
// 处理器工厂
// ============================================================

export interface HandlerDeps {
  db: SqliteDatabase;
  /** 内容筛查开关：默认读环境变量（未设 basic 即保守地不自动放行）。 */
  contentScreenEnabled?: boolean;
  /** 显式注入的筛查函数（测试用；优先级高于 env 开关）。 */
  contentScreen?: (input: { submissionId: string; snapshot: unknown }) => Promise<'pass' | 'violation' | 'inconclusive'>;
  /** 自动发现的上游适配器（测试注入；默认按环境变量造 GitHub 实现）。 */
  discovery?: PluginDiscoveryPort;
  /** 自动发现用的收录探针（测试注入；默认 GitHub 实现）。 */
  probe?: CatalogProbe;
}

/** 不可重试：写明确 errorCode 并终结任务（skipped），不浪费重试预算。 */
function terminal(errorCode: string, errorSummary: string): HandlerResult {
  return { outcome: 'skipped', errorCode, errorSummary };
}

/**
 * 构造 check 处理器（评测 / 评论共用编排，只有 snapshot 读取方式不同）。
 *
 * 实际判定与状态转移**全部复用** `moderation.runRuleCheck` ——
 * 不在这里重写一套规则（task-6 硬要求）。本工厂只负责：
 *  1. 从 payload 取 submissionId；
 *  2. 按开关决定是否注入 contentScreen；
 *  3. 检查通过（approved）后再入队 `*_publish`。
 */
function makeCheckHandler(deps: HandlerDeps, publishTaskType: TaskType): TaskHandler {
  const { db } = deps;

  return async (task) => {
    const submissionId = extractSubmissionId(task.payload);
    if (!submissionId) {
      // payload 缺 ID 是**数据问题**，重试也不会变好 → 终结。
      return terminal('payload_missing_submission_id', '任务 payload 缺少 submission_id，无法定位提交。');
    }

    // 筛查开关：显式注入优先；否则看环境变量。
    // 未启用 → **不注入** contentScreen → moderation 落 not_configured → manual_review。
    const enabled = deps.contentScreenEnabled ?? basicScreenEnabled();
    // 注意把 db 传进去：moderation 传给 screen 的 snapshot **不含正文**
    // （那是字段校验视图），基础筛查必须自己按 submissionId 读正文。
    const screen = deps.contentScreen ?? (enabled ? createBasicContentScreen(db) : undefined);

    const moderation = createModerationService(db, screen ? { contentScreen: screen } : {});

    await moderation.runRuleCheck(submissionId, task.taskId);

    const state = (
      db.prepare('SELECT processing_state FROM content_submissions WHERE id = ?').get(submissionId) as
        | { processing_state: string }
        | undefined
    )?.processing_state;

    log.info('检查任务完成', {
      task_id: task.taskId,
      submission_id: submissionId,
      submission_state: state ?? 'unknown',
      screen_enabled: enabled,
    });

    if (state === 'approved') {
      // 检查通过 → 再入队发布任务（职责分离，见文件头说明）。
      // 幂等：deduplicationKey 绑定提交，重复入队复用同一任务。
      const tasks = createTasksService(db);
      const res = await tasks.enqueue({
        taskType: publishTaskType,
        deduplicationKey: `${publishTaskType}:${submissionId}`,
        requestedBy: null,
        payload: { submission_id: submissionId },
        schedulingGroup: publishTaskType,
        availableAt: nowMs(),
        tx: db,
      });
      log.info('已入队发布任务', {
        task_id: task.taskId,
        submission_id: submissionId,
        publish_task_id: res.taskId,
        created: res.created,
      });
    }

    return { outcome: 'success' };
  };
}

/**
 * 评测发布处理器。
 *
 * 复用 `publishReview`（Lead 拥有，只调用不改）。它的返回值语义：
 *  - `published: true` → 真的发布了；
 *  - `published: false, reason: 'already_published'` → **幂等命中**，不是错误；
 *  - 其他 reason（not_approved / withdrawn / hidden / superseded / revision_missing）
 *    → 资格不满足。这些**不应重试**（重试也不会变好），记明确 errorCode 后终结。
 */
function makeReviewPublishHandler(deps: HandlerDeps): TaskHandler {
  const { db } = deps;

  return async (task) => {
    const submissionId = extractSubmissionId(task.payload);
    if (!submissionId) {
      return terminal('payload_missing_submission_id', '任务 payload 缺少 submission_id，无法定位提交。');
    }

    // 提交不存在属于**不可重试**的数据问题：重试三次也不会让行出现。
    // 在这里先判掉，避免白烧重试预算（publishReview 会抛 target_unavailable）。
    const exists = db.prepare('SELECT 1 AS ok FROM content_submissions WHERE id = ?').get(submissionId) as
      | { ok: number }
      | undefined;
    if (!exists) {
      return terminal('submission_missing', '提交不存在，无法发布。');
    }

    const outcome = publishReview(submissionId, db, { taskId: task.taskId });

    if (outcome.published) {
      log.info('评测已发布', {
        task_id: task.taskId,
        submission_id: submissionId,
        review_id: outcome.reviewId,
        revision_id: outcome.revisionId,
      });
      return { outcome: 'success' };
    }

    // 幂等：已发布过就当成功结束，不重复发布、也不报错。
    if (outcome.reason === 'already_published') {
      log.info('发布任务幂等命中：该提交已发布', { task_id: task.taskId, submission_id: submissionId });
      return { outcome: 'success' };
    }

    // 其余都是"资格不满足"的终态：重试无意义，明确记录后终结。
    log.warn('发布未执行：资格不满足', {
      task_id: task.taskId,
      submission_id: submissionId,
      reason: outcome.reason ?? 'unknown',
    });
    return terminal(`publish_${outcome.reason ?? 'ineligible'}`, `发布未执行：${outcome.reason ?? '资格不满足'}`);
  };
}

/**
 * 评论发布处理器。
 *
 * 发布逻辑**不在本文件**：它已迁移到 `src/server/workflows/publish-comment.ts`。
 *
 * 迁移原因（Lead 裁决 2026-10-11）：本文件最初内联实现了评论发布，但那段实现
 * **先读后写、读在事务外** —— 资格核验与写入之间若有并发删除，已删除的评论
 * 仍会被公开。`publishReview` 用「在事务内重新核验」避免这类问题，
 * 评论必须遵守同一条规矩。同一不变式有两份实现迟早漂移，因此统一收口到 workflows。
 *
 * 本处理器只负责：定位提交 → 调 workflow → 把结果翻译成队列语义。
 */
function makeCommentPublishHandler(deps: HandlerDeps): TaskHandler {
  const { db } = deps;

  return async (task) => {
    const submissionId = extractSubmissionId(task.payload);
    if (!submissionId) {
      return terminal('payload_missing_submission_id', '任务 payload 缺少 submission_id，无法定位提交。');
    }

    const exists = db.prepare('SELECT 1 AS ok FROM content_submissions WHERE id = ?').get(submissionId) as
      | { ok: number }
      | undefined;
    if (!exists) {
      return terminal('submission_missing', '提交不存在，无法发布。');
    }

    const outcome = publishComment(submissionId, db, { taskId: task.taskId });

    if (outcome.published) {
      log.info('评论已发布', {
        task_id: task.taskId,
        submission_id: submissionId,
        comment_id: outcome.commentId,
        revision_id: outcome.revisionId,
      });
      return { outcome: 'success' };
    }

    // 幂等：已发布过就当成功结束，不重复发布、也不报错。
    if (outcome.reason === 'already_published') {
      log.info('发布任务幂等命中：该提交已发布', { task_id: task.taskId, submission_id: submissionId });
      return { outcome: 'success' };
    }

    log.warn('评论发布未执行：资格不满足', {
      task_id: task.taskId,
      submission_id: submissionId,
      reason: outcome.reason ?? 'unknown',
    });
    return terminal(`comment_publish_${outcome.reason ?? 'ineligible'}`, `评论发布未执行：${outcome.reason ?? '资格不满足'}`);
  };
}

/**
 * 构造**插件目录自动发现**处理器（任务类型 `plugin_discovery`，迁移 0007 引入）。
 *
 * 业务全在 `modules/catalog/discovery.ts`；这里只负责：
 *  1. 从 payload 取本轮参数（缺省用 DISCOVERY_DEFAULTS，payload 里不许塞任意大的数）；
 *  2. 造适配器与探针（默认 GitHub 实现；离线闸门由适配器自己抛 not_configured）；
 *  3. 把**本轮汇总写进任务 progress**（后台页要看得见），并按失败性质给出重试语义。
 *
 * 失败语义：
 *   * `provider_not_configured`（显式离线）→ **skipped**：重试一万次也不会变好；
 *   * 其余（网络抖动、上游限流、DB busy）→ **error**：交给队列按 30s/120s 重试。
 */
function makePluginDiscoveryHandler(deps: HandlerDeps): TaskHandler {
  return async (task) => {
    const payload = (task.payload ?? {}) as Record<string, unknown>;
    const readStr = (v: unknown) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined);
    const readNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);

    const runKey = readStr(payload.run_key) ?? discoveryDailyKey(nowMs());
    /** payload 里的数字参数：snake_case 为主，同时容忍 camelCase（历史/手写 payload）。 */
    const readNumEither = (...keys: string[]): number | undefined => {
      for (const k of keys) {
        const v = readNum(payload[k]);
        if (v !== undefined) return v;
      }
      return undefined;
    };
    const discovery = deps.discovery ?? createGithubPluginDiscovery();
    const probe = deps.probe ?? createGithubCatalogProbe();
    const service = createPluginDiscoveryService({ db: deps.db, discovery, probe });

    try {
      const summary = await service.run({
        runKey,
        taskId: task.taskId,
        query: readStr(payload.query) ?? DISCOVERY_DEFAULTS.query,
        searchPages: readNumEither('search_pages', 'searchPages'),
        perPage: readNumEither('per_page', 'perPage'),
        maxCandidates: readNumEither('max_candidates', 'maxCandidates'),
        maxPlugins: readNumEither('max_plugins', 'maxPlugins'),
        maxRequests: readNumEither('max_requests', 'maxRequests'),
      });
      // 审计：自动发现是系统动作，管理员在操作记录里要能看到"这一轮扫了什么、收了多少"。
      // 写失败**不能**让任务变成 error（发现本身已经成功），所以单独 try。
      try {
        recordOperationInTx(
          deps.db,
          {
            actionType: 'plugin.discovery.run',
            // 每轮一个键：同一个任务重试是两次真实运行，各自留一条（不比"去重"更假）。
            operationKey: `discovery:${task.taskId}:${nowMs()}`,
            actorKind: 'system',
            actorUserId: null,
            targetType: 'catalog',
            targetId: runKey,
            targetSnapshot: {
              query: summary.query,
              searched_repos: summary.searchedRepos,
              truncated: summary.truncated,
            },
            changes: {
              created: summary.created,
              refreshed: summary.refreshed,
              accepted: summary.accepted,
              skipped: summary.skipped.length,
              requests_used: summary.requestsUsed,
            },
            reason: '系统任务：插件目录自动发现',
            taskId: task.taskId,
          },
          nowMs(),
        );
      } catch (e) {
        log.warn('自动发现审计写入失败', {
          task_id: task.taskId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      return { outcome: 'success', progress: summary };
    } catch (e) {
      const code = isDomainError(e) ? e.code : 'discovery_failed';
      const message = e instanceof Error ? e.message : '自动发现失败。';
      if (code === 'provider_not_configured') {
        return terminal('discovery_disabled', message);
      }
      return { outcome: 'error', errorCode: code, errorSummary: message };
    }
  };
}

/**
 * 构造全部处理器。
 *
 * `*_check` 复用 `moderation.runRuleCheck`；不注入筛查时保守落 manual_review。
 */
export function createHandlers(deps: HandlerDeps): Partial<Record<TaskType, TaskHandler>> {
  return {
    review_check: makeCheckHandler(deps, 'review_publish'),
    review_publish: makeReviewPublishHandler(deps),
    comment_check: makeCheckHandler(deps, 'comment_publish'),
    comment_publish: makeCommentPublishHandler(deps),
    plugin_discovery: makePluginDiscoveryHandler(deps),
  };
}

/** 单测辅助：确认判定函数可复用（避免测试直接依赖 service.ts 内部）。 */
export { isVersionResolved };
