/**
 * 整合包（`idea.md` §26/§27；`架构设计.md` §15/§35/§36/§58/§88；决策记录 11/12）。
 *
 * 三条不可让的不变量：
 *  1. **发布即冻结**：`plugin_pack_releases` 一旦拿到 `release_number`，名称/用途/说明/
 *     DSH 版本/配置模板/实测声明/条目全部不再原位修改；改内容只能发新版。
 *  2. **版本是公共内容对象**：`release.id` 同时是 `content_entities.id`（`pack_release`），
 *     评论与举报绑定具体版本；可见性只由公共表 + 发布序号共同决定（不另存"公开"列）。
 *  3. **命令是派生物**：条目只存结构化 `install_target`，命令由 `pack-install` 适配器生成；
 *     目标不确认就没有命令（`pendingReason` 说明原因），绝不猜。
 */

import type { SqliteDatabase } from '@/server/platform/db';
import { getDb } from '@/server/platform/db';
import { withRead, withTransaction } from '@/server/platform/tx';
import { newId } from '@/server/platform/id';
import { nowMs } from '@/server/platform/time';
import { err } from '@/packages/common/errors';
import { assertCanWrite, isAdmin, type CallerContext } from '@/server/platform/context';
import { deliverModerationResultNotification } from '@/server/modules/notifications';
import { verifyInstallTarget } from './verify';
import { recordOperationInTx } from '@/server/modules/operations';
import { createHash } from 'node:crypto';
import type { VersionValue } from '@/packages/common/field-rules';
import { buildPage, type PageRequest, type PageResult } from '@/packages/common/result';
import {
  buildInstallCommands,
  normalizeInstallTarget,
  describeInstallTarget,
  type CommandBundle,
  type CommandOutputItem,
  type InstallTarget,
} from '@/packages/common/pack-install';

/**
 * 系统账号（固定 id，按需创建；见 ensureSystemUser）。
 *
 * 自动流程（自动检查通过 / 需补充 / 安装资料核验结果）没有真人触发者，但处理结果通知必须有
 * 一个 actor，且数据库 CHECK 要求 `recipient_id <> actor_id`。用这条固定用户当触发者，
 * 语义上就是「系统告诉作者结果」。它永远登录不了（没有外部身份）。
 */
export const SYSTEM_USER_ID = '00000000-0000-7000-8000-000000000000';

/** 确保系统账号存在（幂等，只在真正要发系统通知时调用）。 */
function ensureSystemUser(conn: SqliteDatabase): void {
  // 不写进迁移：系统账号是**运行时行为**的产物，写进迁移会让所有「用户总数 / 第一条用户」
  // 的口径凭空多一行（登录、用户管理等既有行为与测试都会被它带偏）。
  conn
    .prepare(
      `INSERT INTO users (id, nickname, avatar_url, role, account_status, created_at, updated_at)
       VALUES (?, '系统', NULL, 'user', 'active', 0, 0)
       ON CONFLICT (id) DO NOTHING`,
    )
    .run(SYSTEM_USER_ID);
}

/**
 * 给整合包作者发一条「系统」处理结果通知（自动分支用）。
 *
 * 去重键由调用方给（内含提交时间或申诉 id）：同一版本反复提交 → 每次结果各一条通知；
 * 同一次提交重复跑核验 → 不会刷屏。
 */
function notifyPackAuthorBySystem(
  conn: SqliteDatabase,
  input: { releaseId: string; detail: string; deduplicationKey: string },
): void {
  const author = conn
    .prepare(
      `SELECT p.author_id FROM plugin_packs p
         JOIN plugin_pack_releases rel ON rel.pack_id = p.id
        WHERE rel.id = ?`,
    )
    .get(input.releaseId) as { author_id: string } | undefined;
  if (!author) return;
  ensureSystemUser(conn);
  deliverModerationResultNotification(conn, {
    recipientId: author.author_id,
    actorId: SYSTEM_USER_ID,
    contentEntityId: input.releaseId,
    detail: input.detail,
    deduplicationKey: input.deduplicationKey,
    now: nowMs(),
  });
}

const TITLE_MAX = 80;
const PURPOSE_MAX = 2000;
const BODY_MAX = 200_000;
const CONFIG_MAX = 20_000;
const ITEM_PURPOSE_MAX = 200;
const MAX_ITEMS = 50;

export interface PackItemInput {
  pluginId: string;
  purpose?: string | null;
  pluginVersion: VersionValue;
  installTarget: InstallTarget | null;
  sourceUrl?: string | null;
}

export interface ReleaseInput {
  title: string;
  purpose: string;
  bodyMarkdown: string;
  dshVersion: VersionValue;
  configTemplate?: string | null;
  testStatus: 'untested' | 'tested';
  testTask?: string | null;
  testResult?: string | null;
  items: PackItemInput[];
}

export interface PackSummaryView {
  packId: string;
  authorNickname: string;
  title: string;
  purpose: string;
  releaseNumber: number | null;
  releaseId: string;
  pluginCount: number;
  favoriteCount: number;
  publishedAt: number;
  /** 仅「我的整合包」使用：最近版本当前是否仍公开。 */
  withdrawn?: boolean;
  hidden?: boolean;
  /** 版本生命周期：draft（未提交）/ pending（转人工）/ published / rejected（含需补充）。 */
  reviewStatus?: 'draft' | 'pending' | 'published' | 'rejected';
  reviewNote?: string | null;
  /** 自动检查结果：pass / needs_info / manual。 */
  autoCheckResult?: 'pass' | 'needs_info' | 'manual' | null;
  /** 仅「我收藏的」：当前是否有可公开版本（全部撤回时为 false）。 */
  hasPublicRelease?: boolean;
}

export interface PackReleaseSummary {
  releaseId: string;
  releaseNumber: number | null;
  title: string;
  submittedAt: number;
  withdrawn: boolean;
  hidden: boolean;
}

export interface PackItemView extends CommandOutputItem {
  position: number;
  pluginId: string;
  purpose: string | null;
  sourceUrl: string | null;
  pluginPath: string | null;
  repositoryFullName: string | null;
  /** 结构化目标的展示摘要（无目标时为空）。 */
  targetLabel: string | null;
  displaySnapshot: { displayName: string | null; repositoryFullName: string | null; pluginPath: string | null };
}

export interface PackReleaseDetail {
  releaseId: string;
  releaseNumber: number;
  title: string;
  purpose: string;
  bodyMarkdown: string;
  dshVersion: VersionValue;
  configTemplate: string | null;
  testStatus: 'untested' | 'tested';
  testTask: string | null;
  testResult: string | null;
  publishedAt: number;
  withdrawn: boolean;
  hidden: boolean;
  items: PackItemView[];
  commands: CommandBundle;
}

export interface PackDetailView {
  packId: string;
  authorId: string;
  authorNickname: string;
  favoriteCount: number;
  favoritedByMe: boolean;
  releases: PackReleaseSummary[];
  /** 默认入口选中的版本；全部版本都不公开时为 null。 */
  selected: PackReleaseDetail | null;
  /** 请求了指定版本但它不公开 —— 页面要显示状态，而不是悄悄换成别的版本（§88.2）。 */
  requestedUnavailable: boolean;
  /** 默认入口发生了回退（最近版本被撤回/隐藏，展示的是更早的版本）。 */
  fellBack: boolean;
}

/** 版本结构校验：允许明确未知，但已知值必须是有内容的短文本。 */
function parseVersionValue(raw: unknown, field: string): VersionValue {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw err.input(`${field} 必须是版本对象。`, [{ path: field, message: '格式不合法' }]);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.kind === 'unknown') return { kind: 'unknown' };
  const value = typeof obj.value === 'string' ? obj.value.trim() : '';
  if (obj.kind !== 'known' || value.length === 0 || value.length > 100) {
    throw err.input(`${field} 的版本值需为 1–100 个字符。`, [{ path: field, message: '长度不合法' }]);
  }
  const source = typeof obj.source === 'string' && obj.source.trim().length > 0 ? obj.source.trim() : undefined;
  return source ? { kind: 'known', value, source } : { kind: 'known', value };
}

function requireText(value: unknown, field: string, label: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0 || text.length > max) {
    throw err.input(`${label}需为 1–${max} 个字符。`, [{ path: field, message: `1–${max} 个字符` }]);
  }
  return text;
}

/** 解析并校验整份版本输入（创建与发新版共用）。 */
function parseReleaseInput(
  conn: SqliteDatabase,
  input: ReleaseInput,
): {
  title: string;
  purpose: string;
  bodyMarkdown: string;
  dshVersion: VersionValue;
  configTemplate: string | null;
  testStatus: 'untested' | 'tested';
  testTask: string | null;
  testResult: string | null;
  items: Array<{
    pluginId: string;
    position: number;
    purpose: string | null;
    displaySnapshot: string;
    pluginVersion: VersionValue;
    installTarget: InstallTarget | null;
    sourceUrl: string | null;
  }>;
} {
  const title = requireText(input.title, 'title', '整合包名称', TITLE_MAX);
  const purpose = requireText(input.purpose, 'purpose', '用途说明', PURPOSE_MAX);
  const bodyMarkdown = typeof input.bodyMarkdown === 'string' ? input.bodyMarkdown.trim() : '';
  if (bodyMarkdown.length === 0 || bodyMarkdown.length > BODY_MAX) {
    throw err.input(`组合使用说明需为 1–${BODY_MAX} 个字符。`, [{ path: 'bodyMarkdown', message: '长度不合法' }]);
  }
  const dshVersion = parseVersionValue(input.dshVersion, 'dshVersion');

  let configTemplate: string | null = null;
  if (typeof input.configTemplate === 'string' && input.configTemplate.trim().length > 0) {
    const value = input.configTemplate.trim();
    if (value.length > CONFIG_MAX) {
      throw err.input(`配置模板最多 ${CONFIG_MAX} 个字符。`, [{ path: 'configTemplate', message: '过长' }]);
    }
    configTemplate = value;
  }

  const testStatus = input.testStatus === 'tested' ? 'tested' : 'untested';
  let testTask: string | null = null;
  let testResult: string | null = null;
  if (testStatus === 'tested') {
    testTask = requireText(input.testTask, 'testTask', '测试任务', 2000);
    testResult = requireText(input.testResult, 'testResult', '测试结果', 2000);
  }

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw err.input('整合包至少要有一个插件。', [{ path: 'items', message: '不能为空' }]);
  }
  if (input.items.length > MAX_ITEMS) {
    throw err.input(`整合包最多 ${MAX_ITEMS} 个插件。`, [{ path: 'items', message: '过多' }]);
  }

  const seen = new Set<string>();
  const items = input.items.map((raw, index) => {
    const pluginId = typeof raw.pluginId === 'string' ? raw.pluginId.trim() : '';
    if (pluginId.length === 0) {
      throw err.input(`第 ${index + 1} 个条目缺少插件。`, [{ path: `items[${index}].pluginId`, message: '必填' }]);
    }
    if (seen.has(pluginId)) {
      throw err.input('同一个插件在清单里只能出现一次。', [{ path: `items[${index}].pluginId`, message: '重复' }]);
    }
    seen.add(pluginId);

    const plugin = conn
      .prepare(
        `SELECT p.id, p.plugin_path, r.full_name
           FROM plugins p JOIN repositories r ON r.id = p.repository_id
          WHERE p.id = ?`,
      )
      .get(pluginId) as { id: string; plugin_path: string; full_name: string } | undefined;
    if (!plugin) throw err.unavailable(`第 ${index + 1} 个条目的插件不存在。`);

    let itemPurpose: string | null = null;
    if (typeof raw.purpose === 'string' && raw.purpose.trim().length > 0) {
      itemPurpose = raw.purpose.trim();
      if (itemPurpose.length > ITEM_PURPOSE_MAX) {
        throw err.input(`每个插件的作用说明最多 ${ITEM_PURPOSE_MAX} 个字符。`, [
          { path: `items[${index}].purpose`, message: '过长' },
        ]);
      }
    }

    let sourceUrl: string | null = null;
    if (typeof raw.sourceUrl === 'string' && raw.sourceUrl.trim().length > 0) {
      sourceUrl = raw.sourceUrl.trim();
      if (sourceUrl.length > 500 || !/^https?:\/\//i.test(sourceUrl)) {
        throw err.input('来源链接必须是 http(s) 地址（≤500 字）。', [
          { path: `items[${index}].sourceUrl`, message: '格式不合法' },
        ]);
      }
    }

    let installTarget: InstallTarget | null = null;
    if (raw.installTarget !== null && raw.installTarget !== undefined) {
      installTarget = normalizeInstallTarget(raw.installTarget);
      if (installTarget === null) {
        throw err.input('安装目标的资料不完整或格式不合法；无法确认时请留空（会显示「待核实」）。', [
          { path: `items[${index}].installTarget`, message: '格式不合法' },
        ]);
      }
    }

    return {
      pluginId,
      position: index,
      purpose: itemPurpose,
      displaySnapshot: JSON.stringify({
        displayName: null,
        repositoryFullName: plugin.full_name,
        pluginPath: plugin.plugin_path,
      }),
      pluginVersion: parseVersionValue(raw.pluginVersion, `items[${index}].pluginVersion`),
      installTarget,
      sourceUrl,
    };
  });

  return {
    title,
    purpose,
    bodyMarkdown,
    dshVersion,
    configTemplate,
    testStatus,
    testTask,
    testResult,
    items,
  };
}

interface ReleaseRow {
  id: string;
  pack_id: string;
  release_number: number | null;
  title: string;
  purpose: string;
  body_markdown: string;
  dsh_version: string;
  config_template: string | null;
  test_status: 'untested' | 'tested';
  test_task: string | null;
  test_result: string | null;
  submitted_at: number;
  withdrawn_at: number | null;
  hidden_at: number | null;
}

/** 公共表的可见性字段（与 content 模块同一判据的读取侧）。 */
function readReleaseRow(conn: SqliteDatabase, releaseId: string): ReleaseRow | undefined {
  return conn
    .prepare(
      `SELECT rel.id, rel.pack_id, rel.release_number, rel.title, rel.purpose, rel.body_markdown,
              rel.dsh_version, rel.config_template, rel.test_status, rel.test_task, rel.test_result,
              rel.submitted_at, ce.withdrawn_at, ce.hidden_at
         FROM plugin_pack_releases rel
         JOIN content_entities ce ON ce.id = rel.id
        WHERE rel.id = ?`,
    )
    .get(releaseId) as ReleaseRow | undefined;
}

function isPublicRelease(row: ReleaseRow): boolean {
  return row.release_number !== null && row.withdrawn_at === null && row.hidden_at === null;
}

/**
 * 整合包提交时的自动检查（统一流程：草稿 → 提交 → 自动检查 → 发布/提示补充/转人工）。
 *
 * 规则保持保守：确定缺资料才提示补充，有外部链接等可疑内容转人工，其余自动发布。
 */
function runPackAutoCheck(
  conn: SqliteDatabase,
  releaseId: string,
): { outcome: 'pass' | 'needs_info' | 'manual'; note?: string } {
  const rel = conn
    .prepare(
      'SELECT title, purpose, body_markdown, config_template FROM plugin_pack_releases WHERE id = ?',
    )
    .get(releaseId) as
    | { title: string; purpose: string; body_markdown: string; config_template: string | null }
    | undefined;
  if (!rel) return { outcome: 'needs_info', note: '版本快照不存在，请重新保存。' };

  const itemCount = (
    conn
      .prepare('SELECT COUNT(*) AS c FROM plugin_pack_release_items WHERE release_id = ?')
      .get(releaseId) as { c: number }
  ).c;
  if (Number(itemCount) === 0) {
    return { outcome: 'needs_info', note: '插件清单为空，请至少加入一个插件。' };
  }
  if (rel.purpose.trim().length < 5) {
    return { outcome: 'needs_info', note: '用途说明太短，请补充清楚。' };
  }
  if (rel.body_markdown.trim().length < 20) {
    return { outcome: 'needs_info', note: '组合使用说明太短（至少 20 字），请补充。' };
  }
  if (
    rel.config_template &&
    /(api[_-]?key|password|secret|token)\s*[:=]\s*[^\s<{]/.test(rel.config_template)
  ) {
    return { outcome: 'needs_info', note: '配置模板可能含明文密钥，请改用占位符。' };
  }
  if (/(https?:\/\/|www\.)/i.test(rel.body_markdown) || /(https?:\/\/|www\.)/i.test(rel.purpose)) {
    return { outcome: 'manual', note: '说明中带有外部链接，转人工复核。' };
  }
  return { outcome: 'pass' };
}

/** 提交时写入待核验记录（异步核验完成后再更新 state）。 */
function recordInstallChecks(conn: SqliteDatabase, releaseId: string, now: number): void {
  const items = conn
    .prepare('SELECT id, install_target FROM plugin_pack_release_items WHERE release_id = ?')
    .all(releaseId) as Array<{ id: string; install_target: string | null }>;
  for (const item of items) {
    const seq =
      Number(
        (
          conn
            .prepare(
              'SELECT COALESCE(MAX(check_sequence), 0) AS m FROM plugin_install_checks WHERE release_item_id = ?',
            )
            .get(item.id) as { m: number }
        ).m,
      ) + 1;
    const fingerprint = createHash('sha256')
      .update(item.install_target ?? 'null')
      .digest('hex');
    const kind = item.install_target === null ? 'none' : (JSON.parse(item.install_target) as { kind: string }).kind;
    conn
      .prepare(
        `INSERT INTO plugin_install_checks
           (id, release_item_id, target_fingerprint, check_sequence, target_kind, state, detail, requested_at, completed_at)
         VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
      )
      .run(newId(now), item.id, fingerprint, seq, kind === 'npm' ? 'npm' : kind === 'github' ? 'github' : 'none', now);
  }
}

/** 发布版本：分配序号 + 公开（自动通过与管理員审核共用）。 */
function publishReleaseInTx(conn: SqliteDatabase, releaseId: string): { releaseNumber: number } {
  const rel = conn
    .prepare('SELECT id, pack_id FROM plugin_pack_releases WHERE id = ?')
    .get(releaseId) as { id: string; pack_id: string } | undefined;
  if (!rel) throw err.unavailable('整合包版本不存在。');
  const pack = conn
    .prepare('SELECT last_release_number FROM plugin_packs WHERE id = ?')
    .get(rel.pack_id) as { last_release_number: number } | undefined;
  if (!pack) throw err.unavailable('整合包不存在。');

  const releaseNumber = Number(pack.last_release_number) + 1;
  const now = nowMs();
  conn
    .prepare(
      `UPDATE plugin_pack_releases
          SET release_number = ?, review_status = 'published', review_note = NULL,
              auto_check_result = 'pass'
        WHERE id = ?`,
    )
    .run(releaseNumber, releaseId);
  conn
    .prepare(
      `UPDATE content_entities
          SET first_published_at = COALESCE(first_published_at, ?), public_updated_at = ?
        WHERE id = ?`,
    )
    .run(now, now, releaseId);
  conn.prepare('UPDATE plugin_packs SET last_release_number = ? WHERE id = ?').run(releaseNumber, rel.pack_id);
  return { releaseNumber };
}

export function createPacksService(deps: { db?: SqliteDatabase } = {}) {
  const db = deps.db ?? getDb();

  /** 生成一条条目视图（含命令与展示资料快照）。 */
  function toItemView(row: {
    id: string;
    plugin_id: string;
    position: number;
    purpose: string | null;
    display_snapshot: string;
    plugin_version: string;
    install_target: string | null;
    source_url: string | null;
    plugin_path: string | null;
    full_name: string | null;
  }): CommandOutputItem & {
    position: number;
    pluginId: string;
    purpose: string | null;
    sourceUrl: string | null;
    pluginPath: string | null;
    repositoryFullName: string | null;
    targetLabel: string | null;
    displaySnapshot: PackItemView['displaySnapshot'];
  } {
    const snapshot = JSON.parse(row.display_snapshot) as PackItemView['displaySnapshot'];
    const version = JSON.parse(row.plugin_version) as VersionValue;
    const rawTarget = row.install_target === null ? null : (JSON.parse(row.install_target) as unknown);
    const target = normalizeInstallTarget(rawTarget);
    const bundle = buildInstallCommands([
      // 传 `kind: 'unknown'` 的 displayName 由快照决定，这里只借它算命令
      {
        pluginId: row.plugin_id,
        displayName: snapshot.displayName ?? snapshot.repositoryFullName ?? row.plugin_id,
        pluginVersion: version,
        installTarget: target,
        sourceUrl: row.source_url,
      },
    ]);
    const computed = bundle.items[0]!;
    return {
      ...computed,
      position: row.position,
      pluginId: row.plugin_id,
      purpose: row.purpose,
      sourceUrl: row.source_url,
      pluginPath: snapshot.pluginPath ?? row.plugin_path,
      repositoryFullName: snapshot.repositoryFullName ?? row.full_name,
      targetLabel: target === null ? null : describeInstallTarget(target),
      displaySnapshot: snapshot,
    };
  }

  return {
    /**
     * 创建整合包并立即发布第 1 版。
     *
     * 序号分配与内容写入在**同一个事务**里：`last_release_number` 与 `release_number`
     * 必须同时成立（架构 §58；事务回滚不消耗序号）。
     */
    async createPackWithFirstRelease(
      ctx: CallerContext,
      input: ReleaseInput,
      injectedDb?: SqliteDatabase,
    ): Promise<{ packId: string; releaseId: string; releaseNumber: number }> {
      assertCanWrite(ctx);
      const authorId = ctx.userId;
      return withTransaction((tx) => {
        const conn = tx.db;
        const parsed = parseReleaseInput(conn, input);
        const now = nowMs();
        const packId = newId(now);
        const releaseId = newId(now);

        conn.prepare('INSERT INTO plugin_packs (id, author_id, last_release_number, created_at) VALUES (?, ?, 0, ?)').run(
          packId,
          authorId,
          now,
        );
        conn
          .prepare(
            `INSERT INTO content_entities
               (id, content_type, author_id, review_id, pack_release_id, created_at,
                first_published_at, public_updated_at, visibility_control_version)
             VALUES (?, 'pack_release', ?, NULL, ?, ?, ?, ?, 0)`,
          )
          .run(releaseId, authorId, releaseId, now, now, now);
        conn
          .prepare(
            `INSERT INTO plugin_pack_releases
               (id, pack_id, release_number, title, purpose, body_markdown, dsh_version,
                config_template, test_status, test_task, test_result, submitted_at, review_status)
             VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published')`,
          )
          .run(
            releaseId,
            packId,
            parsed.title,
            parsed.purpose,
            parsed.bodyMarkdown,
            JSON.stringify(parsed.dshVersion),
            parsed.configTemplate,
            parsed.testStatus,
            parsed.testTask,
            parsed.testResult,
            now,
          );
        const insertItem = conn.prepare(
          `INSERT INTO plugin_pack_release_items
             (id, release_id, plugin_id, position, purpose, display_snapshot, plugin_version,
              install_target, source_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const item of parsed.items) {
          insertItem.run(
            newId(now),
            releaseId,
            item.pluginId,
            item.position,
            item.purpose,
            item.displaySnapshot,
            JSON.stringify(item.pluginVersion),
            item.installTarget === null ? null : JSON.stringify(item.installTarget),
            item.sourceUrl,
          );
        }
        conn.prepare('UPDATE plugin_packs SET last_release_number = 1 WHERE id = ?').run(packId);
        return { packId, releaseId, releaseNumber: 1 };
      }, injectedDb ?? db);
    },

    /**
     * 创建整合包草稿（不分配发布序号、不公开）。
     *
     * 作者上传整合包文件后才进入待审核；审核通过才分配「第 N 版」并公开。
     */
    async createPackDraft(
      ctx: CallerContext,
      input: ReleaseInput,
      injectedDb?: SqliteDatabase,
    ): Promise<{ packId: string; releaseId: string }> {
      assertCanWrite(ctx);
      const authorId = ctx.userId;
      return withTransaction((tx) => {
        const conn = tx.db;
        const parsed = parseReleaseInput(conn, input);
        const now = nowMs();
        const packId = newId(now);
        const releaseId = newId(now);

        conn
          .prepare('INSERT INTO plugin_packs (id, author_id, last_release_number, created_at) VALUES (?, ?, 0, ?)')
          .run(packId, authorId, now);
        conn
          .prepare(
            `INSERT INTO content_entities
               (id, content_type, author_id, review_id, pack_release_id, created_at,
                first_published_at, public_updated_at, visibility_control_version)
             VALUES (?, 'pack_release', ?, NULL, ?, ?, NULL, NULL, 0)`,
          )
          .run(releaseId, authorId, releaseId, now);
        conn
          .prepare(
            `INSERT INTO plugin_pack_releases
               (id, pack_id, release_number, title, purpose, body_markdown, dsh_version,
                config_template, test_status, test_task, test_result, submitted_at, review_status)
             VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
          )
          .run(
            releaseId,
            packId,
            parsed.title,
            parsed.purpose,
            parsed.bodyMarkdown,
            JSON.stringify(parsed.dshVersion),
            parsed.configTemplate,
            parsed.testStatus,
            parsed.testTask,
            parsed.testResult,
            now,
          );
        const insertItem = conn.prepare(
          `INSERT INTO plugin_pack_release_items
             (id, release_id, plugin_id, position, purpose, display_snapshot, plugin_version,
              install_target, source_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const item of parsed.items) {
          insertItem.run(
            newId(now),
            releaseId,
            item.pluginId,
            item.position,
            item.purpose,
            item.displaySnapshot,
            JSON.stringify(item.pluginVersion),
            item.installTarget === null ? null : JSON.stringify(item.installTarget),
            item.sourceUrl,
          );
        }
        return { packId, releaseId };
      }, injectedDb ?? db);
    },

    /**
     * 统一发布流程：保存草稿 → 提交 → 自动检查 → 发布 / 提示补充 / 转人工。
     *
     * 整合包不打包分发，安装资料由条目的 install_target（npm / GitHub）生成命令。
     */
    async submitReleaseForReview(
      ctx: CallerContext,
      releaseId: string,
      injectedDb?: SqliteDatabase,
    ): Promise<{
      outcome: 'pass' | 'needs_info' | 'manual' | 'verifying';
      reviewStatus: 'published' | 'rejected' | 'pending';
      releaseNumber?: number;
      note?: string;
    }> {
      assertCanWrite(ctx);
      const userId = ctx.userId;
      return withTransaction((tx) => {
        const conn = tx.db;
        const rel = conn
          .prepare(
            `SELECT rel.id, rel.review_status, p.author_id
               FROM plugin_pack_releases rel
               JOIN plugin_packs p ON p.id = rel.pack_id
              WHERE rel.id = ?`,
          )
          .get(releaseId) as
          | { id: string; review_status: string; author_id: string }
          | undefined;
        if (!rel) throw err.unavailable('整合包版本不存在。');
        if (rel.author_id !== userId) throw err.forbidden('只有作者可以提交审核。');
        if (rel.review_status === 'published') {
          throw err.conflict('这个版本已经发布，不能重复提交；修改请发布新版本。', { releaseId });
        }
        if (rel.review_status === 'pending') {
          throw err.conflict('这个版本已在审核中，请等待审核结果。', { releaseId });
        }

        const check = runPackAutoCheck(conn, releaseId);
        const now = nowMs();
        recordInstallChecks(conn, releaseId, now);
        if (check.outcome === 'pass') {
          // 有结构化安装目标 → 先待核验（异步核验完成后再发布/提示补充）
          const targetCount = (
            conn
              .prepare(
                'SELECT COUNT(*) AS c FROM plugin_pack_release_items WHERE release_id = ? AND install_target IS NOT NULL',
              )
              .get(releaseId) as { c: number }
          ).c;
          if (Number(targetCount) > 0) {
            conn
              .prepare(
                `UPDATE plugin_pack_releases
                    SET review_status = 'pending', review_note = NULL, auto_check_result = 'verifying',
                        submitted_at = ?
                  WHERE id = ?`,
              )
              .run(now, releaseId);
            notifyPackAuthorBySystem(conn, {
              releaseId,
              detail:
                '你的整合包版本已提交，自动检查通过，正在核验安装资料（npm / GitHub），完成后会再次通知你。',
              deduplicationKey: `pack_verifying:${releaseId}:${now}`,
            });
            return { outcome: 'verifying' as const, reviewStatus: 'pending' as const };
          }
          const published = publishReleaseInTx(conn, releaseId);
          return {
            outcome: 'pass' as const,
            reviewStatus: 'published' as const,
            releaseNumber: published.releaseNumber,
          };
        }
        if (check.outcome === 'needs_info') {
          conn
            .prepare(
              `UPDATE plugin_pack_releases
                  SET review_status = 'rejected', review_note = ?, auto_check_result = 'needs_info',
                      submitted_at = ?
                WHERE id = ?`,
            )
            .run(check.note ?? '请补充资料。', now, releaseId);
          notifyPackAuthorBySystem(conn, {
            releaseId,
            detail: `你的整合包版本未通过自动检查：${check.note ?? '请补充资料。'}`,
            deduplicationKey: `pack_auto_needs_info:${releaseId}:${now}`,
          });
          return {
            outcome: 'needs_info' as const,
            reviewStatus: 'rejected' as const,
            note: check.note,
          };
        }
        conn
          .prepare(
            `UPDATE plugin_pack_releases
                SET review_status = 'pending', review_note = ?, auto_check_result = 'manual',
                    submitted_at = ?
              WHERE id = ?`,
          )
          .run(check.note ?? null, now, releaseId);
        notifyPackAuthorBySystem(conn, {
          releaseId,
          detail: `你的整合包版本已提交，需要人工审核（${check.note ?? '含外部链接或需人工确认'}），请耐心等待。`,
          deduplicationKey: `pack_auto_manual:${releaseId}:${now}`,
        });
        return { outcome: 'manual' as const, reviewStatus: 'pending' as const, note: check.note };
      }, injectedDb ?? db);
    },

    /**
     * 异步核验待检条目：网络访问在事务外完成，写回与判定在一个事务里。
     *
     * 判定：任一关键目标 failed → 提示补充；仍有 pending（网络错误）→ 保持待审核（转人工）；
     * 全部 ok/skipped → 发布。只处理「自动核验中」的版本，不碰人工审核中的版本。
     */
    async verifyPendingChecks(
      releaseId: string,
      injectedDb?: SqliteDatabase,
      fetchJson?: Parameters<typeof verifyInstallTarget>[1],
    ): Promise<{ outcome: 'pass' | 'needs_info' | 'manual' | 'ignored'; releaseNumber?: number }> {
      const conn0 = injectedDb ?? db;
      const rows = conn0
        .prepare(
          `SELECT ic.id, ic.release_item_id, i.install_target
             FROM plugin_install_checks ic
             JOIN plugin_pack_release_items i ON i.id = ic.release_item_id
            WHERE i.release_id = ? AND ic.state = 'pending'
              AND ic.check_sequence = (
                SELECT MAX(x.check_sequence) FROM plugin_install_checks x
                 WHERE x.release_item_id = ic.release_item_id
              )`,
        )
        .all(releaseId) as Array<{ id: string; release_item_id: string; install_target: string | null }>;

      const results: Array<{ id: string; state: string; detail: string }> = [];
      for (const row of rows) {
        if (row.install_target === null) {
          results.push({ id: row.id, state: 'skipped', detail: '没有结构化安装目标，按待核实处理。' });
          continue;
        }
        const target = JSON.parse(row.install_target) as Parameters<typeof verifyInstallTarget>[0];
        const outcome = await verifyInstallTarget(target, fetchJson);
        results.push({ id: row.id, state: outcome.state, detail: outcome.detail });
      }

      return withTransaction((tx) => {
        const conn = tx.db;
        const now = nowMs();
        for (const r of results) {
          conn
            .prepare('UPDATE plugin_install_checks SET state = ?, detail = ?, completed_at = ? WHERE id = ?')
            .run(r.state, r.detail, now, r.id);
        }

        const rel = conn
          .prepare('SELECT review_status, auto_check_result FROM plugin_pack_releases WHERE id = ?')
          .get(releaseId) as { review_status: string; auto_check_result: string | null } | undefined;
        if (!rel || rel.review_status !== 'pending' || rel.auto_check_result !== 'verifying') {
          return { outcome: 'ignored' as const };
        }

        const latestState = (state: string): number =>
          Number(
            (
              conn
                .prepare(
                  `SELECT COUNT(*) AS c FROM plugin_install_checks ic
                     JOIN plugin_pack_release_items i ON i.id = ic.release_item_id
                    WHERE i.release_id = ? AND ic.state = ?
                      AND ic.check_sequence = (
                        SELECT MAX(x.check_sequence) FROM plugin_install_checks x
                         WHERE x.release_item_id = ic.release_item_id
                      )`,
                )
                .get(releaseId, state) as { c: number }
            ).c,
          );

        const failed = latestState('failed');
        const pendingLeft = latestState('pending');

        if (failed > 0) {
          const detail = conn
            .prepare(
              `SELECT ic.detail FROM plugin_install_checks ic
                 JOIN plugin_pack_release_items i ON i.id = ic.release_item_id
                WHERE i.release_id = ? AND ic.state = 'failed'
                ORDER BY ic.check_sequence DESC LIMIT 1`,
            )
            .get(releaseId) as { detail: string | null } | undefined;
          conn
            .prepare(
              `UPDATE plugin_pack_releases
                  SET review_status = 'rejected', review_note = ?, auto_check_result = 'needs_info'
                WHERE id = ?`,
            )
            .run(`安装资料核验未通过：${detail?.detail ?? '无法确认安装目标'}`, releaseId);
          notifyPackAuthorBySystem(conn, {
            releaseId,
            detail: `你的整合包版本未通过安装资料核验：${detail?.detail ?? '无法确认安装目标'}。请修正安装目标后重新提交。`,
            deduplicationKey: `pack_verify_failed:${releaseId}:${now}`,
          });
          return { outcome: 'needs_info' as const };
        }

        if (pendingLeft > 0) {
          notifyPackAuthorBySystem(conn, {
            releaseId,
            detail: '你的整合包版本部分安装资料未能自动核验（网络异常），已转为人工审核，请耐心等待。',
            deduplicationKey: `pack_verify_manual:${releaseId}:${now}`,
          });
          return { outcome: 'manual' as const };
        }

        const published = publishReleaseInTx(conn, releaseId);
        notifyPackAuthorBySystem(conn, {
          releaseId,
          detail: `你的整合包版本安装资料核验通过，已发布（第 ${published.releaseNumber} 版）。`,
          deduplicationKey: `pack_verified_published:${releaseId}`,
        });
        return { outcome: 'pass' as const, releaseNumber: published.releaseNumber };
      }, injectedDb ?? db);
    },

    /** 管理员审核通过：分配发布序号并公开（同一事务，§58）。 */
    async approveRelease(
      ctx: CallerContext,
      releaseId: string,
      injectedDb?: SqliteDatabase,
    ): Promise<{ releaseNumber: number }> {
      if (!isAdmin(ctx)) throw err.forbidden('只有管理员可以审核整合包。');
      return withTransaction((tx) => {
        const conn = tx.db;
        const rel = conn
          .prepare('SELECT id, pack_id, review_status FROM plugin_pack_releases WHERE id = ?')
          .get(releaseId) as { id: string; pack_id: string; review_status: string } | undefined;
        if (!rel) throw err.unavailable('整合包版本不存在。');
        if (rel.review_status !== 'pending') {
          throw err.conflict('只有待审核版本可以通过审核。', { releaseId });
        }
        const actorId = ctx.userId;
        if (!actorId) throw err.forbidden('只有管理员可以审核整合包。');
        const published = publishReleaseInTx(conn, releaseId);
        // 审计：审核决定是管理员对内容做的判断，必须在操作记录里留痕（此前只发通知）。
        recordOperationInTx(
          conn,
          {
            actionType: 'pack.release.approve',
            operationKey: `pack_approve:${releaseId}`,
            actorKind: 'admin',
            actorUserId: actorId,
            targetType: 'pack_release',
            targetId: releaseId,
            targetSnapshot: { review_status: 'published', release_number: published.releaseNumber },
            changes: { release_number: published.releaseNumber },
            reason: '管理员审核通过并发布整合包版本',
          },
          nowMs(),
        );
        const author = conn
          .prepare(
            `SELECT p.author_id FROM plugin_packs p
               JOIN plugin_pack_releases rel ON rel.pack_id = p.id
              WHERE rel.id = ?`,
          )
          .get(releaseId) as { author_id: string } | undefined;
        if (author) {
          deliverModerationResultNotification(conn, {
            recipientId: author.author_id,
            actorId,
            contentEntityId: releaseId,
            detail: `你的整合包版本已通过审核并发布（第 ${published.releaseNumber} 版）。`,
            deduplicationKey: `pack_approved:${releaseId}`,
            now: nowMs(),
          });
        }
        return published;
      }, injectedDb ?? db);
    },

    /** 管理员审核拒绝：记录原因，作者可修改后重新上传。 */
    async rejectRelease(
      ctx: CallerContext,
      releaseId: string,
      note: string | null,
      injectedDb?: SqliteDatabase,
    ): Promise<{ ok: true }> {
      if (!isAdmin(ctx)) throw err.forbidden('只有管理员可以审核整合包。');
      return withTransaction((tx) => {
        const conn = tx.db;
        const rel = conn
          .prepare('SELECT id, review_status FROM plugin_pack_releases WHERE id = ?')
          .get(releaseId) as { id: string; review_status: string } | undefined;
        if (!rel) throw err.unavailable('整合包版本不存在。');
        if (rel.review_status !== 'pending') {
          throw err.conflict('只有待审核版本可以拒绝。', { releaseId });
        }
        const actorId = ctx.userId;
        if (!actorId) throw err.forbidden('只有管理员可以审核整合包。');
        conn
          .prepare(`UPDATE plugin_pack_releases SET review_status = 'rejected', review_note = ? WHERE id = ?`)
          .run((note ?? '').trim() || null, releaseId);
        recordOperationInTx(
          conn,
          {
            actionType: 'pack.release.reject',
            operationKey: `pack_reject:${releaseId}:${newId()}`,
            actorKind: 'admin',
            actorUserId: actorId,
            targetType: 'pack_release',
            targetId: releaseId,
            targetSnapshot: { review_status: 'rejected' },
            changes: { review_note: (note ?? '').trim() || null },
            reason: (note ?? '').trim() || '管理员拒绝整合包版本，未填写具体原因',
          },
          nowMs(),
        );
        const author = conn
          .prepare(
            `SELECT p.author_id FROM plugin_packs p
               JOIN plugin_pack_releases rel ON rel.pack_id = p.id
              WHERE rel.id = ?`,
          )
          .get(releaseId) as { author_id: string } | undefined;
        if (author) {
          deliverModerationResultNotification(conn, {
            recipientId: author.author_id,
            actorId,
            contentEntityId: releaseId,
            detail: `你的整合包版本未通过审核：${(note ?? '').trim() || '请补充资料后重新提交。'}`,
            deduplicationKey: `pack_rejected:${releaseId}:${nowMs()}`,
            now: nowMs(),
          });
        }
        return { ok: true as const };
      }, injectedDb ?? db);
    },

    /** 作者编辑草稿/被拒版本（已发布版本不可改，需发新版）。 */
    async updateDraftRelease(
      ctx: CallerContext,
      releaseId: string,
      input: ReleaseInput,
      injectedDb?: SqliteDatabase,
    ): Promise<{ releaseId: string }> {
      assertCanWrite(ctx);
      const userId = ctx.userId;
      return withTransaction((tx) => {
        const conn = tx.db;
        const rel = conn
          .prepare(
            `SELECT rel.id, rel.pack_id, rel.review_status, p.author_id
               FROM plugin_pack_releases rel
               JOIN plugin_packs p ON p.id = rel.pack_id
              WHERE rel.id = ?`,
          )
          .get(releaseId) as
          | { id: string; pack_id: string; review_status: string; author_id: string }
          | undefined;
        if (!rel) throw err.unavailable('整合包版本不存在。');
        if (rel.author_id !== userId) throw err.forbidden('只有作者可以编辑整合包。');
        if (rel.review_status === 'published') {
          throw err.conflict('已发布版本不可原地修改；请发布新版本。', { releaseId });
        }
        if (rel.review_status === 'pending') {
          throw err.conflict('版本正在审核中，不能编辑。', { releaseId });
        }

        const parsed = parseReleaseInput(conn, input);
        const now = nowMs();
        conn
          .prepare(
            `UPDATE plugin_pack_releases
                SET title = ?, purpose = ?, body_markdown = ?, dsh_version = ?,
                    config_template = ?, test_status = ?, test_task = ?, test_result = ?,
                    submitted_at = ?
              WHERE id = ?`,
          )
          .run(
            parsed.title,
            parsed.purpose,
            parsed.bodyMarkdown,
            JSON.stringify(parsed.dshVersion),
            parsed.configTemplate,
            parsed.testStatus,
            parsed.testTask,
            parsed.testResult,
            now,
            releaseId,
          );
        conn.prepare('DELETE FROM plugin_pack_release_items WHERE release_id = ?').run(releaseId);
        const insertItem = conn.prepare(
          `INSERT INTO plugin_pack_release_items
             (id, release_id, plugin_id, position, purpose, display_snapshot, plugin_version,
              install_target, source_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const item of parsed.items) {
          insertItem.run(
            newId(now),
            releaseId,
            item.pluginId,
            item.position,
            item.purpose,
            item.displaySnapshot,
            JSON.stringify(item.pluginVersion),
            item.installTarget === null ? null : JSON.stringify(item.installTarget),
            item.sourceUrl,
          );
        }
        return { releaseId };
      }, injectedDb ?? db);
    },

    /** 作者删除未发布版本（草稿/待审/被拒）；已发布版本只能撤回。 */
    async deleteDraftRelease(
      ctx: CallerContext,
      releaseId: string,
      injectedDb?: SqliteDatabase,
    ): Promise<{ deleted: true }> {
      assertCanWrite(ctx);
      const userId = ctx.userId;
      return withTransaction((tx) => {
        const conn = tx.db;
        const rel = conn
          .prepare(
            `SELECT rel.id, rel.pack_id, rel.review_status, rel.release_number, p.author_id
               FROM plugin_pack_releases rel
               JOIN plugin_packs p ON p.id = rel.pack_id
              WHERE rel.id = ?`,
          )
          .get(releaseId) as
          | {
              id: string;
              pack_id: string;
              review_status: string;
              release_number: number | null;
              author_id: string;
            }
          | undefined;
        if (!rel) throw err.unavailable('整合包版本不存在。');
        if (rel.author_id !== userId) throw err.forbidden('只有作者可以删除整合包。');
        if (rel.review_status === 'published' || rel.release_number !== null) {
          throw err.conflict('已发布版本只能撤回，不能删除。', { releaseId });
        }
        // 先删版本（引用公共内容），再删公共内容行；items/files 随版本级联。
        conn.prepare('DELETE FROM plugin_pack_releases WHERE id = ?').run(releaseId);
        conn.prepare('DELETE FROM content_entities WHERE id = ?').run(releaseId);
        const rest = conn.prepare('SELECT COUNT(*) AS c FROM plugin_pack_releases WHERE pack_id = ?').get(rel.pack_id) as { c: number };
        if (Number(rest.c) === 0) {
          conn.prepare('DELETE FROM plugin_packs WHERE id = ?').run(rel.pack_id);
        }
        return { deleted: true as const };
      }, injectedDb ?? db);
    },

    /** 作者发布新版本：序号原子 +1，内容整份冻结；旧版本保持原样（§35.2/§58）。 */
    async addRelease(
      ctx: CallerContext,
      packId: string,
      input: ReleaseInput,
      injectedDb?: SqliteDatabase,
    ): Promise<{ releaseId: string; releaseNumber: number }> {
      assertCanWrite(ctx);
      const userId = ctx.userId;
      return withTransaction((tx) => {
        const conn = tx.db;
        const pack = conn.prepare('SELECT author_id, last_release_number FROM plugin_packs WHERE id = ?').get(packId) as
          | { author_id: string; last_release_number: number }
          | undefined;
        if (!pack) throw err.unavailable('整合包不存在。');
        if (pack.author_id !== userId) throw err.forbidden('只有作者可以发布新版本。');

        const parsed = parseReleaseInput(conn, input);
        const now = nowMs();
        const releaseNumber = Number(pack.last_release_number) + 1;
        const releaseId = newId(now);

        conn
          .prepare(
            `INSERT INTO content_entities
               (id, content_type, author_id, review_id, pack_release_id, created_at,
                first_published_at, public_updated_at, visibility_control_version)
             VALUES (?, 'pack_release', ?, NULL, ?, ?, ?, ?, 0)`,
          )
          .run(releaseId, userId, releaseId, now, now, now);
        conn
          .prepare(
            `INSERT INTO plugin_pack_releases
               (id, pack_id, release_number, title, purpose, body_markdown, dsh_version,
                config_template, test_status, test_task, test_result, submitted_at, review_status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published')`,
          )
          .run(
            releaseId,
            packId,
            releaseNumber,
            parsed.title,
            parsed.purpose,
            parsed.bodyMarkdown,
            JSON.stringify(parsed.dshVersion),
            parsed.configTemplate,
            parsed.testStatus,
            parsed.testTask,
            parsed.testResult,
            now,
          );
        const insertItem = conn.prepare(
          `INSERT INTO plugin_pack_release_items
             (id, release_id, plugin_id, position, purpose, display_snapshot, plugin_version,
              install_target, source_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const item of parsed.items) {
          insertItem.run(
            newId(now),
            releaseId,
            item.pluginId,
            item.position,
            item.purpose,
            item.displaySnapshot,
            JSON.stringify(item.pluginVersion),
            item.installTarget === null ? null : JSON.stringify(item.installTarget),
            item.sourceUrl,
          );
        }
        conn.prepare('UPDATE plugin_packs SET last_release_number = ? WHERE id = ?').run(releaseNumber, packId);
        return { releaseId, releaseNumber };
      }, injectedDb ?? db);
    },

    /** 作者撤回某个版本（按版本撤回，不动其它版本；§26）。 */
    async withdrawRelease(
      ctx: CallerContext,
      packId: string,
      releaseId: string,
      reason: string | null,
      injectedDb?: SqliteDatabase,
    ): Promise<{ withdrawnAt: number }> {
      assertCanWrite(ctx);
      const userId = ctx.userId;
      return withTransaction((tx) => {
        const conn = tx.db;
        const pack = conn.prepare('SELECT author_id FROM plugin_packs WHERE id = ?').get(packId) as
          | { author_id: string }
          | undefined;
        if (!pack) throw err.unavailable('整合包不存在。');
        if (pack.author_id !== userId) throw err.forbidden('只有作者可以撤回版本。');
        const release = readReleaseRow(conn, releaseId);
        if (!release || release.pack_id !== packId) throw err.unavailable('版本不存在或不属于该整合包。');
        if (release.release_number === null) throw err.unavailable('这个版本还没有发布。');
        const now = nowMs();
        const changed = conn
          .prepare(
            `UPDATE content_entities
                SET withdrawn_at = ?, withdrawal_reason = ?,
                    visibility_control_version = visibility_control_version + 1
              WHERE id = ? AND withdrawn_at IS NULL AND hidden_at IS NULL`,
          )
          .run(now, (reason ?? '').trim() || '作者撤回（未填写原因）', releaseId);
        if (changed.changes === 0) throw err.conflict('这个版本已经不可公开了。', { releaseId });
        return { withdrawnAt: now };
      }, injectedDb ?? db);
    },

    /** 广场：一包一项，取「最近仍公开的版本」作为展示内容（§27/§88）。 */
    async listPublicPacks(
      req: Partial<PageRequest> & { q?: string } = {},
      injectedDb?: SqliteDatabase,
    ): Promise<PageResult<PackSummaryView>> {
      const pageRaw = req.page;
      const page = typeof pageRaw === 'number' && Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
      const sizeRaw = req.page_size;
      const pageSize = typeof sizeRaw === 'number' ? Math.min(Math.max(sizeRaw, 1), 50) : 20;
      const q = (req.q ?? '').trim().slice(0, 100);
      return withRead((conn) => {
        const like = q.length === 0 ? null : `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
        const where = like === null ? '' : `WHERE (l.title LIKE ? ESCAPE '\\' OR l.purpose LIKE ? ESCAPE '\\')`;
        const params: unknown[] = like === null ? [] : [like, like];

        const total = (conn
          .prepare(
            `WITH latest AS (
               SELECT rel.*, ROW_NUMBER() OVER (PARTITION BY rel.pack_id ORDER BY rel.release_number DESC) AS rn
                 FROM plugin_pack_releases rel
                 JOIN content_entities ce ON ce.id = rel.id
                WHERE rel.release_number IS NOT NULL AND rel.review_status = 'published'
                   AND ce.withdrawn_at IS NULL AND ce.hidden_at IS NULL
             )
             SELECT COUNT(*) AS c FROM plugin_packs p JOIN latest l ON l.pack_id = p.id AND l.rn = 1 ${where}`,
          )
          .get(...params) as { c: number }).c;

        const rows = conn
          .prepare(
            `WITH latest AS (
               SELECT rel.*, ROW_NUMBER() OVER (PARTITION BY rel.pack_id ORDER BY rel.release_number DESC) AS rn
                 FROM plugin_pack_releases rel
                 JOIN content_entities ce ON ce.id = rel.id
                WHERE rel.release_number IS NOT NULL AND rel.review_status = 'published'
                   AND ce.withdrawn_at IS NULL AND ce.hidden_at IS NULL
             )
             SELECT p.id AS pack_id, p.author_id, u.nickname, l.id AS release_id, l.release_number,
                    l.title, l.purpose, l.submitted_at,
                    (SELECT COUNT(*) FROM plugin_pack_release_items i WHERE i.release_id = l.id) AS item_count,
                    (SELECT COUNT(*) FROM plugin_pack_favorites f WHERE f.pack_id = p.id) AS favorite_count
               FROM plugin_packs p
               JOIN latest l ON l.pack_id = p.id AND l.rn = 1
               JOIN users u ON u.id = p.author_id
               ${where}
              ORDER BY l.submitted_at DESC, p.id ASC
              LIMIT ? OFFSET ?`,
          )
          .all(...params, pageSize, (page - 1) * pageSize) as Array<{
          pack_id: string;
          author_id: string;
          nickname: string;
          release_id: string;
          release_number: number;
          title: string;
          purpose: string;
          submitted_at: number;
          item_count: number;
          favorite_count: number;
        }>;

        return buildPage(
          rows.map((r) => ({
            packId: r.pack_id,
            authorNickname: r.nickname,
            title: r.title,
            purpose: r.purpose,
            releaseNumber: Number(r.release_number),
            releaseId: r.release_id,
            pluginCount: Number(r.item_count),
            favoriteCount: Number(r.favorite_count),
            publishedAt: r.submitted_at,
          })),
          total,
          { page, page_size: pageSize },
        );
      }, injectedDb ?? db);
    },

    /** 我的整合包：按包展示，带最近版本与其状态（§26 个人中心）。 */
    async listMyPacks(ctx: CallerContext, injectedDb?: SqliteDatabase): Promise<PackSummaryView[]> {
      if (ctx.userId === null) throw err.unauthenticated();
      const userId = ctx.userId;
      return withRead((conn) => {
        const rows = conn
          .prepare(
            `WITH latest AS (
               SELECT rel.*, ROW_NUMBER() OVER (
                 PARTITION BY rel.pack_id ORDER BY rel.submitted_at DESC, rel.id DESC
               ) AS rn
                 FROM plugin_pack_releases rel
             )
             SELECT p.id AS pack_id, p.author_id, u.nickname, l.id AS release_id, l.release_number,
                    l.review_status, l.review_note, l.auto_check_result, l.title, l.purpose, l.submitted_at,
                    (SELECT COUNT(*) FROM plugin_pack_release_items i WHERE i.release_id = l.id) AS item_count,
                    (SELECT COUNT(*) FROM plugin_pack_favorites f WHERE f.pack_id = p.id) AS favorite_count,
                    ce.withdrawn_at, ce.hidden_at
               FROM plugin_packs p
               JOIN latest l ON l.pack_id = p.id AND l.rn = 1
               JOIN content_entities ce ON ce.id = l.id
               JOIN users u ON u.id = p.author_id
              WHERE p.author_id = ?
              ORDER BY p.created_at DESC, p.id ASC`,
          )
          .all(userId) as Array<{
          pack_id: string;
          author_id: string;
          nickname: string;
          release_id: string;
          release_number: number | null;
          review_status: 'draft' | 'pending' | 'published' | 'rejected';
          review_note: string | null;
          auto_check_result: 'pass' | 'needs_info' | 'manual' | null;
          title: string;
          purpose: string;
          submitted_at: number;
          item_count: number;
          favorite_count: number;
          withdrawn_at: number | null;
          hidden_at: number | null;
        }>;
        return rows.map((r) => ({
          packId: r.pack_id,
          authorNickname: r.nickname,
          title: r.title,
          purpose: r.purpose,
          releaseNumber: r.release_number === null ? null : Number(r.release_number),
          releaseId: r.release_id,
          pluginCount: Number(r.item_count),
          favoriteCount: Number(r.favorite_count),
          publishedAt: r.submitted_at,
          reviewStatus: r.review_status,
          reviewNote: r.review_note,
          autoCheckResult: r.auto_check_result,
          // 作者要看得到"这个版本当前是否还公开"
          withdrawn: r.withdrawn_at !== null,
          hidden: r.hidden_at !== null,
        }));
      }, injectedDb ?? db);
    },

    /**
     * 详情：默认取最近**仍公开**的版本；指定版本不公开时如实返回状态，
     * 不悄悄换成别的版本（§88.2）。
     */
    async getPack(
      ctx: CallerContext,
      packId: string,
      options: { releaseNumber?: number } = {},
      injectedDb?: SqliteDatabase,
    ): Promise<PackDetailView> {
      return withRead((conn) => {
        const pack = conn
          .prepare(
            `SELECT p.id, p.author_id, u.nickname FROM plugin_packs p
               JOIN users u ON u.id = p.author_id WHERE p.id = ?`,
          )
          .get(packId) as { id: string; author_id: string; nickname: string } | undefined;
        if (!pack) throw err.unavailable('整合包不存在。');

        const releaseRows = conn
          .prepare(
            `SELECT rel.id, rel.release_number, rel.title, rel.submitted_at, ce.withdrawn_at, ce.hidden_at
               FROM plugin_pack_releases rel JOIN content_entities ce ON ce.id = rel.id
              WHERE rel.pack_id = ? AND rel.release_number IS NOT NULL AND rel.review_status = 'published'
              ORDER BY rel.release_number DESC`,
          )
          .all(packId) as Array<{
          id: string;
          release_number: number;
          title: string;
          submitted_at: number;
          withdrawn_at: number | null;
          hidden_at: number | null;
        }>;

        const releases: PackReleaseSummary[] = releaseRows.map((r) => ({
          releaseId: r.id,
          releaseNumber: Number(r.release_number),
          title: r.title,
          submittedAt: r.submitted_at,
          withdrawn: r.withdrawn_at !== null,
          hidden: r.hidden_at !== null,
        }));

        const isAuthor = ctx.userId !== null && ctx.userId === pack.author_id;
        const anyAdmin = isAdmin(ctx);

        let target: ReleaseRow | undefined;
        let requestedUnavailable = false;
        if (options.releaseNumber !== undefined) {
          const found = releaseRows.find((r) => Number(r.release_number) === options.releaseNumber);
          if (found) target = readReleaseRow(conn, found.id);
          requestedUnavailable = target !== undefined && !isPublicRelease(target);
        }
        if (target === undefined) {
          for (const row of releaseRows) {
            const full = readReleaseRow(conn, row.id);
            if (full && isPublicRelease(full)) {
              target = full;
              break;
            }
          }
        }

        const favoriteCount = (conn
          .prepare('SELECT COUNT(*) AS c FROM plugin_pack_favorites WHERE pack_id = ?')
          .get(packId) as { c: number }).c;
        const favoritedByMe =
          ctx.userId === null
            ? false
            : conn.prepare('SELECT 1 AS x FROM plugin_pack_favorites WHERE pack_id = ? AND user_id = ?').get(packId, ctx.userId) !==
              undefined;

        let selected: PackReleaseDetail | null = null;
        if (target) {
          // 非作者、非管理员看不到已撤回/隐藏版本的内容（但看得到"该版本已撤回"的状态）
          const visible = isPublicRelease(target) || isAuthor || anyAdmin;
          if (visible) {
            const itemRows = conn
              .prepare(
                `SELECT i.id, i.plugin_id, i.position, i.purpose, i.display_snapshot, i.plugin_version,
                        i.install_target, i.source_url, p.plugin_path, r.full_name
                   FROM plugin_pack_release_items i
                   LEFT JOIN plugins p ON p.id = i.plugin_id
                   LEFT JOIN repositories r ON r.id = p.repository_id
                  WHERE i.release_id = ? ORDER BY i.position ASC`,
              )
              .all(target.id) as Array<{
              id: string;
              plugin_id: string;
              position: number;
              purpose: string | null;
              display_snapshot: string;
              plugin_version: string;
              install_target: string | null;
              source_url: string | null;
              plugin_path: string | null;
              full_name: string | null;
            }>;
            const items: PackItemView[] = itemRows.map((row) => toItemView(row));
            const commands = buildInstallCommands(
              items.map((i) => ({
                pluginId: i.pluginId,
                displayName: i.displayName,
                pluginVersion: i.pluginVersion,
                installTarget: i.installTarget,
                sourceUrl: i.sourceUrl ?? null,
              })),
            );
            selected = {
              releaseId: target.id,
              releaseNumber: Number(target.release_number),
              title: target.title,
              purpose: target.purpose,
              bodyMarkdown: target.body_markdown,
              dshVersion: JSON.parse(target.dsh_version) as VersionValue,
              configTemplate: target.config_template,
              testStatus: target.test_status,
              testTask: target.test_task,
              testResult: target.test_result,
              publishedAt: target.submitted_at,
              withdrawn: target.withdrawn_at !== null,
              hidden: target.hidden_at !== null,
              items,
              commands,
            };
          }
        }

        return {
          packId: pack.id,
          authorId: pack.author_id,
          authorNickname: pack.nickname,
          favoriteCount: Number(favoriteCount),
          favoritedByMe,
          releases,
          selected,
          requestedUnavailable,
          fellBack:
            options.releaseNumber === undefined &&
            releases.length > 0 &&
            selected !== null &&
            Number(selected.releaseNumber) !== Number(releases[0]!.releaseNumber),
        };
      }, injectedDb ?? db);
    },

    /** 收藏切换（关联包本身；没有公开版本的包不允许收藏）。 */
    async togglePackFavorite(
      ctx: CallerContext,
      packId: string,
      injectedDb?: SqliteDatabase,
    ): Promise<{ favorited: boolean }> {
      assertCanWrite(ctx);
      const userId = ctx.userId;
      return withTransaction((tx) => {
        const conn = tx.db;
        const exists = conn.prepare('SELECT 1 AS x FROM plugin_packs WHERE id = ?').get(packId);
        if (!exists) throw err.unavailable('整合包不存在。');
        const publicCount = (conn
          .prepare(
            `SELECT COUNT(*) AS c FROM plugin_pack_releases rel
               JOIN content_entities ce ON ce.id = rel.id
              WHERE rel.pack_id = ? AND rel.release_number IS NOT NULL AND rel.review_status = 'published'
                AND ce.withdrawn_at IS NULL AND ce.hidden_at IS NULL`,
          )
          .get(packId) as { c: number }).c;
        if (Number(publicCount) === 0) throw err.unavailable('这个整合包当前没有公开版本，无法收藏。');

        const current = conn
          .prepare('SELECT 1 AS x FROM plugin_pack_favorites WHERE pack_id = ? AND user_id = ?')
          .get(packId, userId);
        if (current) {
          conn.prepare('DELETE FROM plugin_pack_favorites WHERE pack_id = ? AND user_id = ?').run(packId, userId);
          return { favorited: false };
        }
        conn
          .prepare('INSERT INTO plugin_pack_favorites (user_id, pack_id, created_at) VALUES (?, ?, ?)')
          .run(userId, packId, nowMs());
        return { favorited: true };
      }, injectedDb ?? db);
    },

    /** 整合包版本的有帮助状态（匿名只给总数）。 */
    async helpfulStateForRelease(
      releaseId: string,
      userId: string | null,
      injectedDb?: SqliteDatabase,
    ): Promise<{ helpful: boolean; count: number }> {
      return withRead((conn) => {
        const count = (
          conn
            .prepare('SELECT COUNT(*) AS c FROM pack_release_helpful_votes WHERE release_id = ?')
            .get(releaseId) as { c: number }
        ).c;
        const helpful =
          userId === null
            ? false
            : conn
                .prepare('SELECT 1 AS x FROM pack_release_helpful_votes WHERE user_id = ? AND release_id = ?')
                .get(userId, releaseId) !== undefined;
        return { helpful, count: Number(count) };
      }, injectedDb ?? db);
    },

    /** 有帮助投票切换（登录用户；只对公开版本开放）。 */
    async toggleHelpfulForRelease(
      ctx: CallerContext,
      releaseId: string,
      injectedDb?: SqliteDatabase,
    ): Promise<{ helpful: boolean; count: number }> {
      assertCanWrite(ctx);
      const userId = ctx.userId;
      return withTransaction((tx) => {
        const conn = tx.db;
        const rel = conn
          .prepare(
            `SELECT rel.release_number, ce.withdrawn_at, ce.hidden_at
               FROM plugin_pack_releases rel
               JOIN content_entities ce ON ce.id = rel.id
              WHERE rel.id = ?`,
          )
          .get(releaseId) as
          | { release_number: number | null; withdrawn_at: number | null; hidden_at: number | null }
          | undefined;
        if (
          !rel ||
          rel.release_number === null ||
          rel.withdrawn_at !== null ||
          rel.hidden_at !== null
        ) {
          throw err.unavailable('整合包版本不存在或已不可访问。');
        }

        const current = conn
          .prepare('SELECT 1 AS x FROM pack_release_helpful_votes WHERE user_id = ? AND release_id = ?')
          .get(userId, releaseId);
        if (current) {
          conn
            .prepare('DELETE FROM pack_release_helpful_votes WHERE user_id = ? AND release_id = ?')
            .run(userId, releaseId);
        } else {
          conn
            .prepare('INSERT INTO pack_release_helpful_votes (user_id, release_id, created_at) VALUES (?, ?, ?)')
            .run(userId, releaseId, nowMs());
        }
        const count = (
          conn
            .prepare('SELECT COUNT(*) AS c FROM pack_release_helpful_votes WHERE release_id = ?')
            .get(releaseId) as { c: number }
        ).c;
        return { helpful: !current, count: Number(count) };
      }, injectedDb ?? db);
    },

    /**
     * 我收藏的整合包（分页；收藏绑定包本身，全部版本撤回时保留并显示状态）。
     */
    async listFavoritePacks(
      ctx: CallerContext,
      req: Partial<PageRequest> = {},
      injectedDb?: SqliteDatabase,
    ): Promise<PageResult<PackSummaryView>> {
      if (ctx.userId === null) throw err.unauthenticated();
      const userId = ctx.userId;
      const pageRaw = req.page;
      const page = typeof pageRaw === 'number' && Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
      const sizeRaw = req.page_size;
      const pageSize = typeof sizeRaw === 'number' ? Math.min(Math.max(sizeRaw, 1), 50) : 20;
      return withRead((conn) => {
        const total = (
          conn
            .prepare('SELECT COUNT(*) AS c FROM plugin_pack_favorites WHERE user_id = ?')
            .get(userId) as { c: number }
        ).c;
        const rows = conn
          .prepare(
            `WITH latest AS (
               SELECT rel.*, ROW_NUMBER() OVER (
                 PARTITION BY rel.pack_id ORDER BY rel.release_number DESC, rel.submitted_at DESC
               ) AS rn
                 FROM plugin_pack_releases rel
             )
             SELECT p.id AS pack_id, u.nickname, l.id AS release_id, l.release_number, l.review_status,
                    l.title, l.purpose, l.submitted_at,
                    (SELECT COUNT(*) FROM plugin_pack_release_items i WHERE i.release_id = l.id) AS item_count,
                    (SELECT COUNT(*) FROM plugin_pack_favorites f2 WHERE f2.pack_id = p.id) AS favorite_count,
                    ce.withdrawn_at, ce.hidden_at
               FROM plugin_pack_favorites f
               JOIN plugin_packs p ON p.id = f.pack_id
               LEFT JOIN latest l ON l.pack_id = p.id AND l.rn = 1
               LEFT JOIN content_entities ce ON ce.id = l.id
               JOIN users u ON u.id = p.author_id
              WHERE f.user_id = ?
              ORDER BY f.created_at DESC, p.id ASC
              LIMIT ? OFFSET ?`,
          )
          .all(userId, pageSize, (page - 1) * pageSize) as Array<{
          pack_id: string;
          nickname: string;
          release_id: string | null;
          release_number: number | null;
          review_status: string | null;
          title: string | null;
          purpose: string | null;
          submitted_at: number | null;
          item_count: number;
          favorite_count: number;
          withdrawn_at: number | null;
          hidden_at: number | null;
        }>;

        const items = rows.map((r) => ({
          packId: r.pack_id,
          authorNickname: r.nickname,
          title: r.title ?? '（整合包暂无可公开版本）',
          purpose: r.purpose ?? '',
          releaseNumber: r.release_number === null ? null : Number(r.release_number),
          releaseId: r.release_id ?? '',
          pluginCount: Number(r.item_count),
          favoriteCount: Number(r.favorite_count),
          publishedAt: r.submitted_at ?? 0,
          withdrawn: r.withdrawn_at !== null,
          hidden: r.hidden_at !== null,
          hasPublicRelease:
            r.release_number !== null &&
            r.review_status === 'published' &&
            r.withdrawn_at === null &&
            r.hidden_at === null,
        }));
        return buildPage(items, total, { page, page_size: pageSize });
      }, injectedDb ?? db);
    },

    /**
     * 作者提交复核申请（申诉）。
     *
     * 只允许对「不是已发布」且「提交过」的版本申诉（rejected / 转人工 pending）。
     * 同一版本同时只能有一条待处理申诉（数据库部分唯一索引兜底），重复提交返回冲突。
     */
    async submitAppeal(
      ctx: CallerContext,
      releaseId: string,
      message: string,
      injectedDb?: SqliteDatabase,
    ): Promise<{ appealId: string }> {
      assertCanWrite(ctx);
      const userId = ctx.userId;
      const text = message.trim();
      if (text.length < 5) throw err.input('请写清楚为什么认为这次判定有误（至少 5 个字）。');
      if (text.length > 2000) throw err.input('申诉说明最多 2000 字。');

      return withTransaction((tx) => {
        const conn = tx.db;
        const rel = conn
          .prepare(
            `SELECT rel.id, rel.review_status, rel.auto_check_result, rel.review_note, p.author_id
               FROM plugin_pack_releases rel
               JOIN plugin_packs p ON p.id = rel.pack_id
              WHERE rel.id = ?`,
          )
          .get(releaseId) as
          | {
              id: string;
              review_status: string;
              auto_check_result: string | null;
              review_note: string | null;
              author_id: string;
            }
          | undefined;
        if (!rel) throw err.unavailable('整合包版本不存在。');
        if (rel.author_id !== userId) throw err.forbidden('只有作者可以申请复核。');
        if (rel.review_status === 'published') {
          throw err.conflict('已发布的版本没有可申诉的判定；如有问题请修改后发布新版本。', { releaseId });
        }
        if (rel.review_status === 'draft') {
          throw err.conflict('这个版本还没提交过，不需要申诉。', { releaseId });
        }

        const existing = conn
          .prepare("SELECT id FROM plugin_pack_appeals WHERE release_id = ? AND state = 'pending'")
          .get(releaseId) as { id: string } | undefined;
        if (existing) {
          throw err.conflict('这个版本已有一条待处理的复核申请，请等待管理员处理。', {
            releaseId,
            appealId: existing.id,
          });
        }

        const now = nowMs();
        const appealId = newId(now);
        conn
          .prepare(
            `INSERT INTO plugin_pack_appeals
               (id, release_id, author_id, message, snapshot_auto_check, snapshot_note, state, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
          )
          .run(appealId, releaseId, userId, text, rel.auto_check_result, rel.review_note, now);
        return { appealId };
      }, injectedDb ?? db);
    },

    /** 作者查看自己某版本的复核申请历史（最新在前）。 */
    async listAppealsForRelease(
      ctx: CallerContext,
      releaseId: string,
      injectedDb?: SqliteDatabase,
    ): Promise<
      Array<{
        appealId: string;
        message: string;
        state: 'pending' | 'upheld' | 'overturned';
        resolutionNote: string | null;
        createdAt: number;
        resolvedAt: number | null;
      }>
    > {
      const conn = injectedDb ?? db;
      const rel = conn
        .prepare(
          `SELECT p.author_id FROM plugin_pack_releases rel
             JOIN plugin_packs p ON p.id = rel.pack_id
            WHERE rel.id = ?`,
        )
        .get(releaseId) as { author_id: string } | undefined;
      if (!rel) throw err.unavailable('整合包版本不存在。');
      if (rel.author_id !== ctx.userId && !isAdmin(ctx)) {
        throw err.forbidden('只能查看自己版本的复核记录。');
      }
      const rows = conn
        .prepare(
          `SELECT id, message, state, resolution_note, created_at, resolved_at
             FROM plugin_pack_appeals
            WHERE release_id = ?
            ORDER BY created_at DESC, id DESC`,
        )
        .all(releaseId) as Array<{
        id: string;
        message: string;
        state: 'pending' | 'upheld' | 'overturned';
        resolution_note: string | null;
        created_at: number;
        resolved_at: number | null;
      }>;
      return rows.map((r) => ({
        appealId: r.id,
        message: r.message,
        state: r.state,
        resolutionNote: r.resolution_note,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at,
      }));
    },

    /** 管理员：待处理的复核申请队列（含申诉时的判定快照）。 */
    async listPendingAppeals(injectedDb?: SqliteDatabase): Promise<
      Array<{
        appealId: string;
        releaseId: string;
        packId: string;
        title: string;
        authorNickname: string;
        message: string;
        snapshotAutoCheck: string | null;
        snapshotNote: string | null;
        createdAt: number;
      }>
    > {
      const conn = injectedDb ?? db;
      const rows = conn
        .prepare(
          `SELECT a.id, a.release_id, rel.pack_id, rel.title, u.nickname, a.message,
                  a.snapshot_auto_check, a.snapshot_note, a.created_at
             FROM plugin_pack_appeals a
             JOIN plugin_pack_releases rel ON rel.id = a.release_id
             JOIN plugin_packs p ON p.id = rel.pack_id
             JOIN users u ON u.id = a.author_id
            WHERE a.state = 'pending'
            ORDER BY a.created_at ASC, a.id ASC`,
        )
        .all() as Array<{
        id: string;
        release_id: string;
        pack_id: string;
        title: string;
        nickname: string;
        message: string;
        snapshot_auto_check: string | null;
        snapshot_note: string | null;
        created_at: number;
      }>;
      return rows.map((r) => ({
        appealId: r.id,
        releaseId: r.release_id,
        packId: r.pack_id,
        title: r.title,
        authorNickname: r.nickname,
        message: r.message,
        snapshotAutoCheck: r.snapshot_auto_check,
        snapshotNote: r.snapshot_note,
        createdAt: r.created_at,
      }));
    },

    /**
     * 管理员处理复核申请。
     *
     * - decision='overturn' → 改判：发布该版本（分配序号），申诉记 overturned；
     * - decision='uphold'  → 维持原判：版本保持被退回，申诉记 upheld，结果连理由一起通知作者。
     *
     * 两种结果都发一条处理结果通知（去重键带 appealId：一次申诉只通知一次）。
     */
    async resolveAppeal(
      ctx: CallerContext,
      appealId: string,
      decision: 'overturn' | 'uphold',
      note: string | null,
      injectedDb?: SqliteDatabase,
    ): Promise<{ state: 'upheld' | 'overturned'; releaseNumber?: number }> {
      if (!isAdmin(ctx)) throw err.forbidden('只有管理员可以处理复核申请。');
      const adminId = ctx.userId;
      if (!adminId) throw err.forbidden('只有管理员可以处理复核申请。');
      const trimmed = (note ?? '').trim();
      if (decision === 'uphold' && trimmed.length === 0) {
        throw err.input('维持原判需要写明理由，作者才知道问题出在哪。');
      }

      return withTransaction((tx) => {
        const conn = tx.db;
        const appeal = conn
          .prepare(
            `SELECT a.id, a.release_id, a.author_id, a.state, rel.review_status
               FROM plugin_pack_appeals a
               JOIN plugin_pack_releases rel ON rel.id = a.release_id
              WHERE a.id = ?`,
          )
          .get(appealId) as
          | {
              id: string;
              release_id: string;
              author_id: string;
              state: string;
              review_status: string;
            }
          | undefined;
        if (!appeal) throw err.unavailable('复核申请不存在。');
        if (appeal.state !== 'pending') throw err.conflict('这条复核申请已处理过了。', { appealId });

        const now = nowMs();

        if (decision === 'overturn') {
          if (appeal.review_status !== 'rejected' && appeal.review_status !== 'pending') {
            throw err.conflict('这个版本的当前状态无法改判发布。', { releaseId: appeal.release_id });
          }
          // 改判即发布：先回到可发布态并清掉退回原因，再走统一发布路径
          conn
            .prepare(
              `UPDATE plugin_pack_releases
                  SET review_status = 'draft', review_note = NULL
                WHERE id = ? AND review_status IN ('rejected','pending')`,
            )
            .run(appeal.release_id);
          const published = publishReleaseInTx(conn, appeal.release_id);
          conn
            .prepare(
              `UPDATE plugin_pack_appeals
                  SET state = 'overturned', resolution_note = ?, resolved_by = ?, resolved_at = ?
                WHERE id = ?`,
            )
            .run(trimmed || null, adminId, now, appealId);
          recordOperationInTx(
            conn,
            {
              actionType: 'pack.appeal.resolve',
              operationKey: `pack_appeal:${appealId}`,
              actorKind: 'admin',
              actorUserId: adminId,
              targetType: 'pack_appeal',
              targetId: appealId,
              targetSnapshot: { state: 'overturned', release_id: appeal.release_id },
              changes: { release_number: published.releaseNumber, note: trimmed || null },
              reason: trimmed || '管理员改判：申诉成立，版本已发布',
            },
            now,
          );
          deliverModerationResultNotification(conn, {
            recipientId: appeal.author_id,
            actorId: adminId,
            contentEntityId: appeal.release_id,
            detail: `复核结果：改判成立，版本已发布（第 ${published.releaseNumber} 版）。${trimmed ? `说明：${trimmed}` : ''}`,
            deduplicationKey: `pack_appeal_overturned:${appealId}`,
            now,
          });
          return { state: 'overturned' as const, releaseNumber: published.releaseNumber };
        }

        conn
          .prepare(
            `UPDATE plugin_pack_appeals
                SET state = 'upheld', resolution_note = ?, resolved_by = ?, resolved_at = ?
              WHERE id = ?`,
          )
          .run(trimmed, adminId, now, appealId);
        recordOperationInTx(
          conn,
          {
            actionType: 'pack.appeal.resolve',
            operationKey: `pack_appeal:${appealId}`,
            actorKind: 'admin',
            actorUserId: adminId,
            targetType: 'pack_appeal',
            targetId: appealId,
            targetSnapshot: { state: 'upheld', release_id: appeal.release_id },
            changes: { note: trimmed },
            reason: trimmed,
          },
          now,
        );
        deliverModerationResultNotification(conn, {
          recipientId: appeal.author_id,
          actorId: adminId,
          contentEntityId: appeal.release_id,
          detail: `复核结果：维持原判。${trimmed}`,
          deduplicationKey: `pack_appeal_upheld:${appealId}`,
          now,
        });
        return { state: 'upheld' as const };
      }, injectedDb ?? db);
    },
  };
}

export type PacksService = ReturnType<typeof createPacksService>;

export function packsService(): PacksService {
  return createPacksService({ db: getDb() });
}
