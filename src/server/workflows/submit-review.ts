/**
 * 评测提交流程（架构第 68.2 节 + 第 38.1 节）。
 *
 * 职责：把「作者确认的草稿版本 → 不可变修订快照 → 提交记录 → 首个检查任务」
 * 协调成**一次短事务**。外部拉取与耗时计算一律在事务之外。
 *
 * 本文件由主控（GX）拥有；只做协调，不重复实现各模块的业务规则。
 */

import { withTransaction, type Tx } from '@/server/platform/tx';
import { nowMs } from '@/server/platform/time';
import { newId } from '@/server/platform/id';
import { digest } from '@/server/platform/digest';
import type { SqliteDatabase } from '@/server/platform/db';
import { getDb } from '@/server/platform/db';
import type { CallerContext } from '@/server/platform/context';
import { assertCanWrite } from '@/server/platform/context';
import { err } from '@/packages/common/errors';
import type { VersionValue } from '@/packages/common/field-rules';
import { parseEvidenceRefs, parseVerdict, verdictDef, type EvidenceRef, type VerdictKey } from '@/packages/common/verdict';

// ============================================================
// 完整发布校验（架构第 66.2 节）
// ============================================================

export interface PublishValidation {
  fields: { path: string; message: string }[];
}

export interface PublishCheckInput {
  title: string;
  pluginId: string | null;
  pluginVersion: VersionValue | null | undefined;
  dshVersion: VersionValue | null | undefined;
}

function isVersionResolvedShape(v: VersionValue | null | undefined): boolean {
  if (!v || typeof v !== 'object') return false;
  if (v.kind === 'unknown') return true;
  if (v.kind === 'known') return typeof v.value === 'string' && v.value.trim().length > 0;
  return false;
}

/**
 * 正式提交前的完整条件检查。
 *
 * **明确不是退回理由**：未知版本、负面评价、未使用参考模板、未实测
 * （需求第 4、5 节；架构第 66.2、84.2 节）。这里只查"填了没有、指向对不对"。
 */
export function validateForPublish(input: PublishCheckInput): PublishValidation {
  const fields: { path: string; message: string }[] = [];
  if (!input.title || input.title.trim() === '') {
    fields.push({ path: 'title', message: '请填写评测标题。' });
  }
  if (!input.pluginId) {
    fields.push({ path: 'plugin_id', message: '请选择插件，或先保存为草稿。' });
  }
  if (!isVersionResolvedShape(input.pluginVersion)) {
    fields.push({ path: 'plugin_version', message: '插件版本请填写，或明确选择“未知”。' });
  }
  if (!isVersionResolvedShape(input.dshVersion)) {
    fields.push({ path: 'dsh_version', message: 'DSH 版本请填写，或明确选择“未知”。' });
  }
  return { fields };
}

// ============================================================
// 提交流程
// ============================================================

export interface SubmitReviewInput {
  draftId: string;
  /** 作者确认的保存版本（必须与草稿当前 save_version 一致）。 */
  expectedSaveVersion: number;
  requestKey: string;
  publishIntent: 'publish' | 'draft_only';
  /** 正文（已由草稿保存；这里取确认时的快照）。 */
  title: string;
  bodyMarkdown: string;
  pluginVersion: VersionValue;
  dshVersion: VersionValue;
  /**
   * 五状态判定（dsh-bench 规范）。`publish` 意图必填；`draft_only` 可为 null。
   * 校验与规范化在本函数内完成（parseVerdict/parseEvidenceRefs fail-closed）。
   */
  verdict?: string | null;
  /** 证据链（[{url, note?}]）。有结论的判定至少一条；draft_only 不收。 */
  evidenceRefs?: unknown;
}

export interface SubmitReviewResult {
  submissionId: string;
  reviewRevisionId: string;
  reviewId: string;
  processingState: 'pending';
  /** 首个检查任务；任务入队失败时为 null（提交仍在，可由重试补）。 */
  taskId: string | null;
}

/** 提交请求的规范化摘要，用于同 request_key 的重复判定。 */
export function submissionDigest(input: {
  draftId: string;
  expectedSaveVersion: number;
  title: string;
  bodyMarkdown: string;
  verdict: string | null;
  evidenceRefs: EvidenceRef[];
}): string {
  return digest(input);
}

interface DraftRow {
  id: string;
  owner_id: string;
  review_id: string | null;
  save_version: number;
  payload: string;
}

/**
 * 执行一次评测提交。
 *
 * 顺序（全部在一个短事务内）：
 *  1. 核验草稿归属与作者身份；
 *  2. 核验草稿当前 save_version == 作者确认版本（否则 409，保留用户输入）；
 *  3. 分配 revision_number 并写入**不可变** review_revisions 快照；
 *  4. 写入 content_submissions（处理状态从 pending 起）；
 *  5. 更新 reviews.latest_submitted_revision_id（草稿自动保存不改这个引用）。
 *
 * 任务入队放在事务提交之后（见 已删除的设计稿《模块签名契约》 §9.2 的已知偏离）：
 * better-sqlite3 的事务回调必须同步，而 tasks 的加载是异步的。
 * 入队失败会向上抛错让调用方重试，**不静默吞掉**。
 */
export async function submitReview(
  ctx: CallerContext,
  input: SubmitReviewInput,
  db: SqliteDatabase = getDb(),
): Promise<SubmitReviewResult> {
  assertCanWrite(ctx);

  // 同 request_key 重复提交：先查既有提交，返回原结果（不重复建快照）。
  const existing = db
    .prepare('SELECT id, request_digest, review_revision_id FROM content_submissions WHERE submitted_by = ? AND request_key = ?')
    .get(ctx.userId, input.requestKey) as
    | { id: string; request_digest: string; review_revision_id: string | null }
    | undefined;

  // 五状态判定与证据链（dsh-bench 规范）：publish 意图必须给出；draft_only 不收。
  // 校验放在事务外：非法输入不进入任何写路径（fail-closed）。
  const verdict: VerdictKey | null =
    input.publishIntent === 'publish' ? parseVerdict(input.verdict) : null;
  const evidenceRefs: EvidenceRef[] =
    verdict === null
      ? []
      : parseEvidenceRefs(input.evidenceRefs, { required: verdictDef(verdict).conclusive });

  const wantDigest = submissionDigest({
    draftId: input.draftId,
    expectedSaveVersion: input.expectedSaveVersion,
    title: input.title,
    bodyMarkdown: input.bodyMarkdown,
    verdict,
    evidenceRefs,
  });

  if (existing) {
    if (existing.request_digest !== wantDigest) {
      throw err.keyReused('同一请求标识不能对应不同的评测内容。');
    }
    const rev = db
      .prepare('SELECT review_id FROM review_revisions WHERE id = ?')
      .get(existing.review_revision_id) as { review_id: string } | undefined;
    return {
      submissionId: existing.id,
      reviewRevisionId: existing.review_revision_id ?? '',
      reviewId: rev?.review_id ?? '',
      processingState: 'pending',
      taskId: null,
    };
  }

  const created = withTransaction((tx: Tx) => {
    const draft = tx.db
      .prepare('SELECT id, owner_id, review_id, save_version, payload FROM content_drafts WHERE id = ?')
      .get(input.draftId) as DraftRow | undefined;

    if (!draft) throw err.unavailable('草稿不存在或不可访问。');
    if (draft.owner_id !== ctx.userId) throw err.forbidden('只能提交自己的评测草稿。');
    if (!draft.review_id) throw err.input('草稿尚未关联评测文章。', [{ path: 'draft_id', message: '缺少文章关联。' }]);

    // 2) 版本核验：不读取并发布另一窗口后来保存的版本。
    if (draft.save_version !== input.expectedSaveVersion) {
      throw err.conflict('草稿已被其他窗口修改，请读取当前内容后重新确认。', {
        current_save_version: draft.save_version,
        expected_save_version: input.expectedSaveVersion,
      });
    }

    // 3) 快照：从草稿关联的插件读出 must-have 外键。
    const pluginRow = tx.db
      .prepare('SELECT plugin_id FROM reviews WHERE id = ?')
      .get(draft.review_id) as { plugin_id: string | null } | undefined;
    const pluginId = pluginRow?.plugin_id ?? null;
    if (!pluginId) {
      throw err.input('评测尚未选择插件，无法提交。', [{ path: 'plugin_id', message: '请选择插件。' }]);
    }

    const nextNumber = (tx.db
      .prepare('SELECT COALESCE(MAX(revision_number), 0) AS n FROM review_revisions WHERE review_id = ?')
      .get(draft.review_id) as { n: number }).n + 1;

    const revisionId = newId();
    const now = nowMs();
    tx.db
      .prepare(
        `INSERT INTO review_revisions
           (id, review_id, revision_number, plugin_id, title, body_markdown, plugin_version, dsh_version, verdict, evidence_refs, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        revisionId,
        draft.review_id,
        nextNumber,
        pluginId,
        input.title,
        input.bodyMarkdown,
        JSON.stringify(input.pluginVersion),
        JSON.stringify(input.dshVersion),
        verdict,
        evidenceRefs.length > 0 ? JSON.stringify(evidenceRefs) : null,
        now,
      );

    // 4) 提交记录。
    const submissionId = newId();
    tx.db
      .prepare(
        `INSERT INTO content_submissions
           (id, submitted_by, submission_type, review_revision_id, comment_revision_id, draft_id,
            draft_save_version, request_key, request_digest, processing_state, state_version,
            publication_context, submitted_at, updated_at)
         VALUES (?, ?, 'review_revision', ?, NULL, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      )
      .run(
        submissionId,
        ctx.userId,
        revisionId,
        draft.id,
        input.expectedSaveVersion,
        input.requestKey,
        wantDigest,
        JSON.stringify({ publish_intent: input.publishIntent, expected_public_revision: null }),
        now,
        now,
      );

    // 5) 最近提交引用（草稿自动保存不改它）。
    tx.db
      .prepare('UPDATE reviews SET latest_submitted_revision_id = ? WHERE id = ?')
      .run(revisionId, draft.review_id);

    return { submissionId, revisionId, reviewId: draft.review_id };
  }, db);

  // 事务外入队（见本文件顶部说明）。
  let taskId: string | null = null;
  const tasks = await loadTasks(db);
  if (tasks) {
    const res = await tasks.enqueue({
      taskType: 'review_check',
      deduplicationKey: `review_check:${created.submissionId}`,
      requestedBy: ctx.userId,
      payload: { submission_id: created.submissionId },
      schedulingGroup: `author:${ctx.userId}`,
      availableAt: nowMs(),
      tx: db,
    });
    taskId = res.taskId;
  }

  return {
    submissionId: created.submissionId,
    reviewRevisionId: created.revisionId,
    reviewId: created.reviewId,
    processingState: 'pending',
    taskId,
  };
}

// ============================================================
// tasks 装配（静态形状，动态加载只为避免模块环）
// ============================================================

interface EnqueueFn {
  (input: {
    taskType: string;
    deduplicationKey: string;
    requestedBy: string | null;
    payload: unknown;
    schedulingGroup: string;
    availableAt: number;
    tx?: unknown;
  }): Promise<{ taskId: string; created: boolean }>;
}

interface TasksModule {
  createTasksService?: (db: SqliteDatabase) => { enqueue?: EnqueueFn };
  tasksService?: () => { enqueue?: EnqueueFn };
}

let cached: TasksModule | null = null;

/**
 * 取得 enqueue，并**绑定到同一条连接**。
 *
 * 这一点很关键：若任务落到 `getDb()` 单例而业务写在注入连接上，
 * 会写出指向别处数据库的任务 —— 看着成功、实际对不上。
 */
export async function loadTasks(db: SqliteDatabase): Promise<{ enqueue: EnqueueFn } | null> {
  try {
    cached ??= (await import('@/server/modules/tasks')) as TasksModule;
  } catch {
    return null;
  }
  const mod = cached;
  if (typeof mod.createTasksService === 'function') {
    const svc = mod.createTasksService(db);
    if (svc.enqueue) return { enqueue: svc.enqueue };
  }
  if (typeof mod.tasksService === 'function') {
    const svc = mod.tasksService();
    if (svc.enqueue) return { enqueue: svc.enqueue };
  }
  return null;
}
