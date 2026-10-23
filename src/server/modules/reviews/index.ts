/**
 * 评测模块（工作包 GC · 签名见 已删除的设计稿《模块签名契约》 第 3 节）。
 *
 * 本体只导出服务对象 `reviewsService`，不导出仓储与表定义。
 * 关键不变量（已删除的设计稿《并行工作包》 第 2 节）：
 *  - `save_version` 原子条件更新：`WHERE id = ? AND save_version = ?`，影响行数 0 → version_conflict，保留用户输入；
 *  - 请求去重：`draft_save_receipts(draft_id, request_key)` 同键同摘要 → 返回原回执且**不递增** save_version；同键不同摘要 → request_key_reused；
 *  - 一篇评测只有一份当前草稿（部分唯一索引 `uq_drafts_review`）；
 *  - 时间只用 nowMs()，ID 只用 newId()，写操作走 withTransaction。
 */

import { assertCanWrite, type CallerContext } from '@/server/platform/context';
import { nowMs } from '@/server/platform/time';
import { newId } from '@/server/platform/id';
import { withRead, withTransaction } from '@/server/platform/tx';
import { digest } from '@/server/platform/digest';
import type { SqliteDatabase } from '@/server/platform/db';
import { err } from '@/packages/common/errors';
import type { PageRequest, PageResult } from '@/packages/common/result';
import { buildPage } from '@/packages/common/result';
import { isSha256Hex, isUuidV7, type ContentType, type VersionValue } from '@/packages/common/field-rules';
import { parseEvidenceRefs, parseVerdict, type EvidenceRef, type VerdictKey } from '@/packages/common/verdict';
import { parseOptionalAssessmentLevel, type AssessmentLevel } from '@/packages/common/assessment';

// ============================================================
// 结构：草稿载荷
// ============================================================

/**
 * 草稿载荷（架构第 68.2 节）：
 * 保存允许必填项未完成（标题空、未选插件、版本未填），**但结构必须完整**——
 * 不允许用缺字段静默表达“沿用旧值”。因此下面每个键都要求显式出现。
 */
export interface DraftBodySegment {
  /** 段落标识；保存时客户端必须带上，避免整篇重排丢失锚点。 */
  key: string;
  markdown: string;
}

export interface DraftPayload {
  /** 标题可以为空串（未写完），但必须显式存在。 */
  title: string;
  /** 未选插件用 null 显式表示。 */
  pluginId: string | null;
  /** 版本结构（{kind:'known'|'unknown'}），未填时为 {kind:'unknown'}。 */
  pluginVersion: VersionValue;
  dshVersion: VersionValue;
  /** 正文分段。 */
  body: DraftBodySegment[];
  /**
   * 五状态判定（dsh-bench 规范）：未选为 null，提交时必填。
   * 可选是因为 v1 载荷（本字段之前写入的历史草稿）没有这个键——
   * 运行时由 parseDraftPayload 规范化为 null / []，读取方用「未给出」呈现。
   */
  verdict?: VerdictKey | null;
  /** 证据链（可复核链接）；未填为空数组（v1 载荷缺键，同 verdict 的可选理由）。 */
  evidence?: EvidenceRef[];
  /**
   * 测评档位（dsh-bench 规范）：未选为 null，提交时必填。
   * 可选是因为 v1/v2 载荷没有这个键——运行时按「未标注」读取，不猜成「未测评」。
   */
  assessmentLevel?: AssessmentLevel | null;
}

/**
 * v3：载荷增补 assessmentLevel；v2 增补 verdict/evidence。
 * 解析对旧载荷（缺这些键）向后兼容——缺键视为「未给出」，不报错
 * （历史草稿不因升级而读不出来）。
 */
export const DRAFT_PAYLOAD_SCHEMA_VERSION = 3;

// ============================================================
// 结构：视图
// ============================================================

export interface DraftView {
  draftId: string;
  reviewId: string;
  ownerId: string;
  pluginId: string | null;
  payload: DraftPayload;
  payloadSchemaVersion: number;
  saveVersion: number;
  createdAt: number;
  savedAt: number;
}

/** 公开修订摘要。 */
export interface PublishedRevisionSummary {
  revisionId: string;
  revisionNumber: number;
  pluginId: string;
  title: string;
  bodyMarkdown: string;
  pluginVersion: VersionValue;
  dshVersion: VersionValue;
  submittedAt: number;
  /** 本篇的测评档位；历史修订为 null（未标注）。 */
  assessmentLevel: AssessmentLevel | null;
}

export interface ReviewDetail {
  reviewId: string;
  contentEntityId: string;
  authorId: string;
  contentType: ContentType;
  pluginId: string | null;
  sourceKind: 'community' | 'site';
  publishedRevisionId: string | null;
  latestSubmittedRevisionId: string | null;
  publishedRevision: PublishedRevisionSummary | null;
  createdAt: number;
  firstPublishedAt: number | null;
  publicUpdatedAt: number | null;
  /** 可见性由 content 模块统一解析；这里只报告控制字段原始值，不另存“公开状态”。 */
  withdrawnAt: number | null;
  hiddenAt: number | null;
}

// ============================================================
// 行类型（仅本文件内部使用）
// ============================================================

interface DraftRow {
  id: string;
  owner_id: string;
  draft_type: string;
  review_id: string | null;
  base_review_revision_id: string | null;
  payload: string;
  payload_schema_version: number;
  save_version: number;
  created_at: number;
  saved_at: number;
}

interface ReceiptRow {
  draft_id: string;
  request_key: string;
  expected_version: number;
  payload_digest: string;
  result_version: number;
  saved_at: number;
}

interface ReviewRow {
  id: string;
  plugin_id: string | null;
  source_kind: string;
  published_revision_id: string | null;
  latest_submitted_revision_id: string | null;
}

interface EntityRow {
  id: string;
  content_type: string;
  author_id: string;
  created_at: number;
  first_published_at: number | null;
  public_updated_at: number | null;
  withdrawn_at: number | null;
  hidden_at: number | null;
}

interface RevisionRow {
  id: string;
  review_id: string;
  revision_number: number;
  plugin_id: string;
  title: string;
  body_markdown: string;
  plugin_version: string;
  dsh_version: string;
  submitted_at: number;
  assessment_level: string | null;
}

// ============================================================
// 共享校验与读取助手
// ============================================================

/** 写入前置：登录 + 账户正常。走平台统一实现，保证与接口层的错误码映射一致。 */
function requireActiveUser(ctx: CallerContext): string {
  assertCanWrite(ctx);
  return ctx.userId;
}

export function parseRequestKey(requestKey: string): string {
  if (typeof requestKey !== 'string' || requestKey.trim().length === 0) {
    throw err.input('请求标识不能为空。', [{ path: 'request_key', message: '必填' }]);
  }
  return requestKey;
}

export function parseDraftId(draftId: string): string {
  if (typeof draftId !== 'string' || !isUuidV7(draftId)) {
    throw err.input('草稿标识格式不正确。', [{ path: 'draft_id', message: '必须是规范 UUIDv7' }]);
  }
  return draftId;
}

/** 从数据库行还原草稿，而不是用输入值回显——回显会让“没写进去”也被测试通过。 */
function readDraftRow(db: SqliteDatabase, draftId: string): DraftRow {
  const row = db
    .prepare(
      `SELECT id, owner_id, draft_type, review_id, base_review_revision_id, payload,
              payload_schema_version, save_version, created_at, saved_at
       FROM content_drafts WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(draftId) as DraftRow | undefined;
  if (!row) throw err.unavailable('草稿不存在或已不可访问。');
  return row;
}

function toDraftView(row: DraftRow, pluginId: string | null): DraftView {
  return {
    draftId: row.id,
    reviewId: row.review_id ?? '',
    ownerId: row.owner_id,
    pluginId,
    payload: parseJson<DraftPayload>(row.payload),
    payloadSchemaVersion: row.payload_schema_version,
    saveVersion: row.save_version,
    createdAt: row.created_at,
    savedAt: row.saved_at,
  };
}

/**
 * 读取草稿时顺带取文章当前插件关联。
 * 草稿不缓存 plugin_id：真正生效的关联在 reviews 上，缓存会产生两个真相。
 */
function readReviewPluginId(db: SqliteDatabase, reviewId: string | null): string | null {
  if (!reviewId) return null;
  const row = db.prepare('SELECT plugin_id FROM reviews WHERE id = ?').get(reviewId) as
    | { plugin_id: string | null }
    | undefined;
  return row?.plugin_id ?? null;
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

function toVersionValue(text: string): VersionValue {
  return parseJson<VersionValue>(text);
}

// ============================================================
// 草稿载荷校验
// ============================================================

function parseVersionValue(raw: unknown, path: string): VersionValue {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw err.input('版本结构必须是对象。', [{ path, message: '需要 {kind:"known"|"unknown"}' }]);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.kind === 'unknown') {
    if (obj.reason !== undefined && typeof obj.reason !== 'string') {
      throw err.input('版本未知原因必须是文本。', [{ path: `${path}.reason`, message: '类型不正确' }]);
    }
    if (obj.reason === undefined) return { kind: 'unknown' };
    return { kind: 'unknown', reason: obj.reason };
  }
  if (obj.kind === 'known') {
    if (typeof obj.value !== 'string' || obj.value.trim().length === 0) {
      throw err.input('已知版本必须填写版本值。', [{ path: `${path}.value`, message: '必填' }]);
    }
    if (obj.source !== undefined && typeof obj.source !== 'string') {
      throw err.input('版本来源线索必须是文本。', [{ path: `${path}.source`, message: '类型不正确' }]);
    }
    const out: VersionValue = { kind: 'known', value: obj.value };
    if (obj.source !== undefined) (out as { source?: string }).source = obj.source;
    return out;
  }
  throw err.input('版本 kind 必须是 known 或 unknown。', [{ path: `${path}.kind`, message: '取值不合法' }]);
}

/**
 * 结构完整但允许未完成：标题可为空串、pluginId 可为 null、版本可为 unknown。
 * 不允许的是**缺字段**（那会被静默当成“沿用旧值”）。
 */
export function parseDraftPayload(raw: unknown): DraftPayload {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw err.input('草稿内容结构不完整。', [{ path: 'payload', message: '必须是对象' }]);
  }
  const obj = raw as Record<string, unknown>;

  for (const key of ['title', 'pluginId', 'pluginVersion', 'dshVersion', 'body'] as const) {
    if (!(key in obj)) {
      throw err.input('草稿内容缺少必填结构字段。', [{ path: `payload.${key}`, message: '字段缺失，不能用缺字段表示沿用旧值' }]);
    }
  }

  if (typeof obj.title !== 'string') {
    throw err.input('标题必须是文本。', [{ path: 'payload.title', message: '类型不正确' }]);
  }
  if (obj.pluginId !== null && typeof obj.pluginId !== 'string') {
    throw err.input('插件标识必须是文本或 null。', [{ path: 'payload.pluginId', message: '类型不正确' }]);
  }
  if (typeof obj.pluginId === 'string' && !isUuidV7(obj.pluginId)) {
    throw err.input('插件标识格式不正确。', [{ path: 'payload.pluginId', message: '必须是规范 UUIDv7' }]);
  }
  if (!Array.isArray(obj.body)) {
    throw err.input('正文必须是分段数组。', [{ path: 'payload.body', message: '类型不正确' }]);
  }

  const body: DraftBodySegment[] = obj.body.map((segment, index) => {
    if (segment === null || typeof segment !== 'object' || Array.isArray(segment)) {
      throw err.input('正文分段结构不正确。', [{ path: `payload.body[${index}]`, message: '必须是对象' }]);
    }
    const seg = segment as Record<string, unknown>;
    if (typeof seg.key !== 'string' || seg.key.trim().length === 0) {
      throw err.input('正文分段标识必填。', [{ path: `payload.body[${index}].key`, message: '必填' }]);
    }
    if (typeof seg.markdown !== 'string') {
      throw err.input('正文分段内容必须是文本。', [{ path: `payload.body[${index}].markdown`, message: '类型不正确' }]);
    }
    return { key: seg.key, markdown: seg.markdown };
  });

  // v1 兼容：旧载荷没有 verdict/evidence —— 缺键 = 未给出（null / []）。
  let verdict: VerdictKey | null = null;
  if (obj.verdict !== undefined && obj.verdict !== null) {
    verdict = parseVerdict(obj.verdict, 'payload.verdict');
  }
  const evidence = parseEvidenceRefs(obj.evidence, { required: false, path: 'payload.evidence' });
  // v1/v2 兼容：旧载荷没有 assessmentLevel —— 缺键 = 未标注（null）。
  const assessmentLevel = parseOptionalAssessmentLevel(obj.assessmentLevel, 'payload.assessmentLevel');

  return {
    title: obj.title,
    pluginId: obj.pluginId as string | null,
    pluginVersion: parseVersionValue(obj.pluginVersion, 'payload.pluginVersion'),
    dshVersion: parseVersionValue(obj.dshVersion, 'payload.dshVersion'),
    body,
    verdict,
    evidence,
    assessmentLevel,
  };
}

// ============================================================
// 服务实现
// ============================================================

/** 批量删除一次最多接受的草稿数（防止误操作/滥用）。 */
export const MAX_BATCH_DELETE = 50;

/**
 * 删除单份草稿的事务内实现（单删与批量共用）。
 *
 * 已发布评测先撤回：直接更新 content_entities（与 contentService.withdraw 同一条约束），
 * 撤回原因固定写明来源；已撤回/已隐藏时保持原状（不重复撤回）。
 */
function deleteDraftInTx(
  conn: SqliteDatabase,
  userId: string,
  draftId: string,
): { withdrawn: boolean } {
  const id = parseDraftId(draftId);
  const row = readDraftRow(conn, id);
  if (row.draft_type !== 'review') throw err.unavailable('草稿不存在或已不可访问。');
  if (row.owner_id !== userId) throw err.forbidden('只能删除自己的草稿。');

  // 删除草稿只删草稿：**不撤回、不影响已提交/已发布评测**。
  // 撤回是评测详情页的独立动作（作者操作），两者不再绑定。

  const submitted = conn
    .prepare('SELECT 1 AS x FROM content_submissions WHERE draft_id = ? LIMIT 1')
    .get(id) as { x: number } | undefined;

  conn.prepare('DELETE FROM draft_save_receipts WHERE draft_id = ?').run(id);
  conn.prepare('DELETE FROM draft_attachment_links WHERE draft_id = ?').run(id);

  if (submitted) {
    // 软删除：保留 content_submissions / review_revisions；唯一索引已改为只约束未删除草稿。
    conn.prepare('UPDATE content_drafts SET deleted_at = ? WHERE id = ?').run(nowMs(), id);
  } else {
    conn.prepare('DELETE FROM content_drafts WHERE id = ?').run(id);
    if (row.review_id) {
      const hasRevision = conn
        .prepare('SELECT 1 AS x FROM review_revisions WHERE review_id = ? LIMIT 1')
        .get(row.review_id) as { x: number } | undefined;
      if (!hasRevision) {
        conn.prepare('DELETE FROM reviews WHERE id = ?').run(row.review_id);
        conn.prepare('DELETE FROM content_entities WHERE id = ?').run(row.review_id);
      }
    }
  }

  return { withdrawn: false };
}

export const reviewsService = {
  /**
   * 新建或复用评测草稿。一篇评测只有一份当前草稿（部分唯一索引兜底）。
   *
   * 归属规则：以调用者为作者。同一调用者针对同一插件的“进行中评测”已存在时复用，
   * 避免每次点“写评测”都多出一篇空文章；草稿被显式 `requestKey` 绑定时也复用。
   */
  async createOrGetDraft(
    ctx: CallerContext,
    input: { pluginId: string | null; requestKey: string },
    db?: SqliteDatabase,
  ): Promise<{ draftId: string; reviewId: string; saveVersion: number }> {
    const userId = requireActiveUser(ctx);
    const requestKey = parseRequestKey(input.requestKey);
    const pluginId = input.pluginId ?? null;
    if (pluginId !== null && !isUuidV7(pluginId)) {
      throw err.input('插件标识格式不正确。', [{ path: 'plugin_id', message: '必须是规范 UUIDv7' }]);
    }

    return withTransaction((tx) => {
      const db = tx.db;

      if (pluginId !== null) {
        const plugin = db.prepare('SELECT id FROM plugins WHERE id = ?').get(pluginId) as { id: string } | undefined;
        if (!plugin) throw err.input('所选插件不存在。', [{ path: 'plugin_id', message: '未知插件' }]);
      }

      // 复用：同一作者、同一插件关联的已有草稿即为“进行中的那篇评测”。
      const existing = db
        .prepare(
          `SELECT d.id AS draft_id, d.review_id AS review_id, d.save_version AS save_version
           FROM content_drafts d
           JOIN reviews r ON r.id = d.review_id
           WHERE d.draft_type = 'review' AND d.deleted_at IS NULL AND d.owner_id = ? AND r.plugin_id IS ?
           ORDER BY d.saved_at DESC, d.id DESC
           LIMIT 1`,
        )
        .get(userId, pluginId) as { draft_id: string; review_id: string; save_version: number } | undefined;

      if (existing) {
        // 同一 (draftId, requestKey) 的重复请求不产生新草稿，直接返回当前版本。
        return { draftId: existing.draft_id, reviewId: existing.review_id, saveVersion: existing.save_version };
      }

      const reviewId = newId();
      const draftId = newId();
      const now = nowMs();
      const payload: DraftPayload = {
        title: '',
        pluginId,
        pluginVersion: { kind: 'unknown' },
        dshVersion: { kind: 'unknown' },
        body: [],
        verdict: null,
        evidence: [],
        assessmentLevel: null,
      };

      // 延迟配对：先插公共实体（回指自身），再插具体子表，最后落草稿；全部在同一事务内。
      db.prepare(
        `INSERT INTO content_entities (id, content_type, author_id, review_id, created_at)
         VALUES (?, 'review', ?, ?, ?)`,
      ).run(reviewId, userId, reviewId, now);

      db.prepare(`INSERT INTO reviews (id, plugin_id, source_kind) VALUES (?, ?, 'community')`).run(
        reviewId,
        pluginId,
      );

      db.prepare(
        `INSERT INTO content_drafts
           (id, owner_id, draft_type, review_id, payload, payload_schema_version, save_version, created_at, saved_at)
         VALUES (?, ?, 'review', ?, ?, ?, 0, ?, ?)`,
      ).run(draftId, userId, reviewId, JSON.stringify(payload), DRAFT_PAYLOAD_SCHEMA_VERSION, now, now);

      // requestKey 在此刻没有对应回执可写（回执表要求 result_version = expected_version + 1，
      // 且初建草稿不是一次「保存」）。同键重复调用会命中上面的复用分支，结果一致。
      void requestKey;

      return { draftId, reviewId, saveVersion: 0 };
    }, db);
  },

  /** 读取草稿。只读：不进入写事务，也绝不回显调用方传入的值。 */
  async getDraft(ctx: CallerContext, draftId: string, db?: SqliteDatabase): Promise<DraftView> {
    const userId = requireActiveUser(ctx);
    const id = parseDraftId(draftId);
    return withRead((conn) => {
      const row = readDraftRow(conn, id);
      if (row.draft_type !== 'review') throw err.unavailable('草稿不存在或已不可访问。');
      if (row.owner_id !== userId) throw err.forbidden('只能访问自己的草稿。');
      return toDraftView(row, readReviewPluginId(conn, row.review_id));
    }, db);
  },

  /**
   * 保存草稿。
   *
   * 顺序很重要：
   *  1. 先查 `draft_save_receipts` 回执 —— **重放必须在 CAS 之前判定**，
   *     否则带着旧 expectedVersion 的重放会被误判成 version_conflict，
   *     客户端重试同一请求就会看到假冲突；
   *  2. 再做原子条件更新 —— `WHERE id = ? AND save_version = ?`，
   *     影响行数 0 即表示期间已被别的请求改过 → version_conflict（保留用户输入，不覆盖）；
   *  3. 只有真的更新成功才写回执，回执的 result_version = expected_version + 1 由 CHECK 兜底。
   */
  async saveDraft(
    ctx: CallerContext,
    input: { draftId: string; expectedVersion: number; requestKey: string; payload: DraftPayload },
    db?: SqliteDatabase,
  ): Promise<{ saveVersion: number; savedAt: number; replayed: boolean }> {
    const userId = requireActiveUser(ctx);
    const draftId = parseDraftId(input.draftId);
    const requestKey = parseRequestKey(input.requestKey);

    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw err.input('预期版本必须是非负整数。', [{ path: 'expected_version', message: '取值不合法' }]);
    }

    const payload = parseDraftPayload(input.payload);

    return withTransaction((tx) => {
      const db = tx.db;

      // 1) 回执优先：同键同摘要 → 原结果，不递增 save_version。
      //    必须先读回执再读草稿行：重放请求可能带着已过期的 expectedVersion 与旧结构 payload，
      //    若先读草稿并校验结构，重放会退化成 input_invalid，而不是「返回原结果」。
      //
      //    摘要从**库里存的原回执/原载荷字符串**按同一 canonical 方法计算，
      //    这样即使历史载荷用了别的键序，重放判定也不会误报 keyReused。
      const receipt = db
        .prepare(
          `SELECT draft_id, request_key, expected_version, payload_digest, result_version, saved_at
           FROM draft_save_receipts WHERE draft_id = ? AND request_key = ?`,
        )
        .get(draftId, requestKey) as ReceiptRow | undefined;

      if (receipt) {
        const stored = db.prepare('SELECT payload FROM content_drafts WHERE id = ?').get(draftId) as
          | { payload: string }
          | undefined;
        const storedDigest = stored ? digest(JSON.parse(stored.payload) as unknown) : null;
        if (storedDigest !== receipt.payload_digest) throw err.internal('草稿回执与当前载荷不一致。');
        // 重放：以**本次请求的载荷**与入库载荷的 canonical 摘要比对。
        if (digest(payload) !== receipt.payload_digest) throw err.keyReused();
        return { saveVersion: receipt.result_version, savedAt: receipt.saved_at, replayed: true };
      }

      // 2) 只有非重放请求才需要行存在、归属正确、结构合法。
      const row = readDraftRow(db, draftId);
      if (row.draft_type !== 'review') throw err.unavailable('草稿不存在或已不可访问。');
      if (row.owner_id !== userId) throw err.forbidden('只能保存自己的草稿。');

      const payloadDigest = digest(payload);
      if (!isSha256Hex(payloadDigest)) throw err.internal('摘要计算异常。');

      // 3) 原子条件更新（按预期版本比较，不是按“当前版本 +1”）。
      //    比较的是**提交时请求方所见的版本**，保证并发下只有一个请求能推进。
      const updated = db
        .prepare(
          `UPDATE content_drafts
             SET payload = ?, save_version = save_version + 1, saved_at = ?
           WHERE id = ? AND save_version = ?`,
        )
        .run(JSON.stringify(payload), nowMs(), draftId, input.expectedVersion);

      if (updated.changes === 0) {
        // 版本不符：不写回执、不改 payload，用户输入由调用方保留。
        throw err.conflict('草稿已被其他保存更新，请基于最新版本重试。', {
          current_version: row.save_version,
          expected_version: input.expectedVersion,
        });
      }

      // 4) 成功才写回执；result_version = expected_version + 1。
      const resultVersion = input.expectedVersion + 1;
      const savedAt = nowMs();
      db.prepare(
        `INSERT INTO draft_save_receipts
           (draft_id, request_key, expected_version, payload_digest, result_version, saved_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(draftId, requestKey, input.expectedVersion, payloadDigest, resultVersion, savedAt);

      return { saveVersion: resultVersion, savedAt, replayed: false };
    }, db);
  },

  /** 读取评测详情（公开视图；可见性判定由 content 模块统一解析）。 */
  async getReview(ctx: CallerContext, reviewId: string, db?: SqliteDatabase): Promise<ReviewDetail> {
    void ctx;
    if (typeof reviewId !== 'string' || !isUuidV7(reviewId)) {
      throw err.input('评测标识格式不正确。', [{ path: 'review_id', message: '必须是规范 UUIDv7' }]);
    }
    return withRead((conn) => {
      const review = conn
        .prepare(
          `SELECT id, plugin_id, source_kind, published_revision_id, latest_submitted_revision_id
           FROM reviews WHERE id = ?`,
        )
        .get(reviewId) as ReviewRow | undefined;

      const entity = conn
        .prepare(
          `SELECT id, content_type, author_id, created_at, first_published_at, public_updated_at,
                  withdrawn_at, hidden_at
           FROM content_entities WHERE id = ?`,
        )
        .get(reviewId) as EntityRow | undefined;

      if (!review || !entity) throw err.unavailable('评测不存在或已不可访问。');

      let publishedRevision: PublishedRevisionSummary | null = null;
      if (review.published_revision_id) {
        const rev = conn
          .prepare(
            `SELECT id, review_id, revision_number, plugin_id, title, body_markdown,
                    plugin_version, dsh_version, submitted_at, assessment_level
             FROM review_revisions WHERE id = ?`,
          )
          .get(review.published_revision_id) as RevisionRow | undefined;
        if (rev) {
          publishedRevision = {
            revisionId: rev.id,
            revisionNumber: rev.revision_number,
            pluginId: rev.plugin_id,
            title: rev.title,
            bodyMarkdown: rev.body_markdown,
            pluginVersion: toVersionValue(rev.plugin_version),
            dshVersion: toVersionValue(rev.dsh_version),
            submittedAt: rev.submitted_at,
            assessmentLevel: (rev.assessment_level as AssessmentLevel | null) ?? null,
          };
        }
      }

      return {
        reviewId: review.id,
        contentEntityId: entity.id,
        authorId: entity.author_id,
        contentType: entity.content_type as ContentType,
        pluginId: review.plugin_id,
        sourceKind: review.source_kind as 'community' | 'site',
        publishedRevisionId: review.published_revision_id,
        latestSubmittedRevisionId: review.latest_submitted_revision_id,
        publishedRevision,
        createdAt: entity.created_at,
        firstPublishedAt: entity.first_published_at,
        publicUpdatedAt: entity.public_updated_at,
        withdrawnAt: entity.withdrawn_at,
        hiddenAt: entity.hidden_at,
      };
    }, db);
  },

  /**
   * 删除草稿（仅本人）。
   *
   * 语义：
   *  - 已发布：先在同一个事务里撤回评测（withdrawn_at + 控制版本 +1），再删草稿；
   *  - 已提交过（content_submissions.draft_id 外键 RESTRICT）：软删除
   *    （deleted_at 标记 + review_id 置 NULL 释放唯一索引），保留提交与修订历史；
   *  - 从未提交：物理删除，并清理创建时插入的空壳 reviews / content_entities。
   */
  async deleteDraft(
    ctx: CallerContext,
    draftId: string,
    db?: SqliteDatabase,
  ): Promise<{ withdrawn: boolean }> {
    const userId = requireActiveUser(ctx);
    return withTransaction((tx) => deleteDraftInTx(tx.db, userId, draftId), db);
  },

  /**
   * 批量删除草稿：逐份走与单删相同的语义（已发布的一并撤回）。
   * 全部在同一个事务里完成；任何一份校验失败则整批回滚。
   */
  async deleteDrafts(
    ctx: CallerContext,
    draftIds: string[],
    db?: SqliteDatabase,
  ): Promise<{ deleted: number; withdrawn: number }> {
    const userId = requireActiveUser(ctx);
    if (!Array.isArray(draftIds) || draftIds.length === 0) {
      throw err.input('请选择要删除的草稿。', [{ path: 'draftIds', message: '至少一份' }]);
    }
    if (draftIds.length > MAX_BATCH_DELETE) {
      throw err.input(`一次最多删除 ${MAX_BATCH_DELETE} 份草稿。`, [
        { path: 'draftIds', message: `超过 ${MAX_BATCH_DELETE} 份` },
      ]);
    }
    const unique = [...new Set(draftIds)];
    return withTransaction((tx) => {
      let withdrawn = 0;
      for (const draftId of unique) {
        if (deleteDraftInTx(tx.db, userId, draftId).withdrawn) withdrawn += 1;
      }
      return { deleted: unique.length, withdrawn };
    }, db);
  },

  /**
   * 按评测 ID 删除作者草稿（「撤回并删除草稿」用）。
   *
   * 草稿不存在/已删除时返回 `{ deleted: false }`，不报错——撤回已经发生，
   * 调用方不应因为「没有草稿可删」把撤回结果变成失败。
   * 已撤回的评测在这里不会再次撤回（withdrawn=false），只删除草稿。
   */
  async deleteDraftByReview(
    ctx: CallerContext,
    reviewId: string,
    db?: SqliteDatabase,
  ): Promise<{ deleted: boolean; withdrawn: boolean }> {
    const userId = requireActiveUser(ctx);
    if (typeof reviewId !== 'string' || !isUuidV7(reviewId)) {
      throw err.input('评测标识格式不正确。', [{ path: 'review_id', message: '必须是规范 UUIDv7' }]);
    }
    return withTransaction((tx) => {
      const row = tx.db
        .prepare(
          `SELECT id FROM content_drafts
              WHERE review_id = ? AND owner_id = ? AND draft_type = 'review' AND deleted_at IS NULL
              ORDER BY saved_at DESC, id DESC
              LIMIT 1`,
        )
        .get(reviewId, userId) as { id: string } | undefined;
      if (!row) return { deleted: false, withdrawn: false };
      const result = deleteDraftInTx(tx.db, userId, row.id);
      return { deleted: true, withdrawn: result.withdrawn };
    }, db);
  },

  /**
   * 为已提交/已发布评测创建「修改草稿」。
   *
   * - 只有作者本人可以修改；
   * - 已有未删除草稿 → 直接复用；
   * - 否则把最近一次修订（优先公开修订）的内容复制成新草稿：
   *   title / 正文分段 / 版本 / 判定 / 证据 / 档位。
   *
   * 修改稿提交后仍走原有 submitReview 流程（生成新修订，审核通过后替换公开修订）。
   */
  async createOrGetRevisionDraft(
    ctx: CallerContext,
    reviewId: string,
    db?: SqliteDatabase,
  ): Promise<{ draftId: string }> {
    const userId = requireActiveUser(ctx);
    if (typeof reviewId !== 'string' || !isUuidV7(reviewId)) {
      throw err.input('评测标识格式不正确。', [{ path: 'review_id', message: '必须是规范 UUIDv7' }]);
    }
    return withTransaction((tx) => {
      const conn = tx.db;
      const review = conn
        .prepare(
          `SELECT r.id, r.plugin_id, r.published_revision_id, r.latest_submitted_revision_id,
                  ce.author_id
             FROM reviews r
             JOIN content_entities ce ON ce.id = r.id
            WHERE r.id = ?`,
        )
        .get(reviewId) as
        | {
            id: string;
            plugin_id: string | null;
            published_revision_id: string | null;
            latest_submitted_revision_id: string | null;
            author_id: string;
          }
        | undefined;
      if (!review) throw err.unavailable('评测不存在或已不可访问。');
      if (review.author_id !== userId) throw err.forbidden('只有作者本人可以修改这篇评测。');

      const existing = conn
        .prepare(
          `SELECT id FROM content_drafts
              WHERE review_id = ? AND owner_id = ? AND draft_type = 'review' AND deleted_at IS NULL
              LIMIT 1`,
        )
        .get(reviewId, userId) as { id: string } | undefined;
      if (existing) return { draftId: existing.id };

      const revisionId = review.published_revision_id ?? review.latest_submitted_revision_id;
      const rev = revisionId
        ? (conn
            .prepare(
              `SELECT title, body_markdown, plugin_version, dsh_version, verdict, evidence_refs, assessment_level
                 FROM review_revisions WHERE id = ?`,
            )
            .get(revisionId) as
            | {
                title: string;
                body_markdown: string;
                plugin_version: string;
                dsh_version: string;
                verdict: string | null;
                evidence_refs: string | null;
                assessment_level: string | null;
              }
            | undefined)
        : undefined;
      if (!rev) throw err.conflict('这篇评测还没有可修改的修订。');

      const body = rev.body_markdown
        .split(/\n{2,}/)
        .map((text, index) => ({ key: `p${index}`, markdown: text }));
      const payload: DraftPayload = {
        title: rev.title,
        pluginId: review.plugin_id,
        pluginVersion: JSON.parse(rev.plugin_version) as VersionValue,
        dshVersion: JSON.parse(rev.dsh_version) as VersionValue,
        body,
        verdict: (rev.verdict as VerdictKey | null) ?? null,
        evidence: rev.evidence_refs ? (JSON.parse(rev.evidence_refs) as EvidenceRef[]) : [],
        assessmentLevel: (rev.assessment_level as AssessmentLevel | null) ?? null,
      };
      const draftId = newId();
      const now = nowMs();
      conn
        .prepare(
          `INSERT INTO content_drafts
             (id, owner_id, draft_type, review_id, payload, payload_schema_version, save_version, created_at, saved_at)
           VALUES (?, ?, 'review', ?, ?, ?, 0, ?, ?)`,
        )
        .run(draftId, userId, reviewId, JSON.stringify(payload), DRAFT_PAYLOAD_SCHEMA_VERSION, now, now);
      return { draftId };
    }, db);
  },
};

/** 分页读取某个作者的草稿列表（工作台用；不属于契约必需项，但保持只读语义）。 */
export async function listDrafts(
  ctx: CallerContext,
  req: PageRequest,
  db?: SqliteDatabase,
): Promise<PageResult<DraftView>> {
  const userId = requireActiveUser(ctx);
  return withRead((conn) => {
    const total = (
      conn
        .prepare(`SELECT count(*) AS c FROM content_drafts WHERE owner_id = ? AND draft_type = 'review' AND deleted_at IS NULL`)
        .get(userId) as { c: number }
    ).c;
    const rows = conn
      .prepare(
        `SELECT id, owner_id, draft_type, review_id, base_review_revision_id, payload,
                payload_schema_version, save_version, created_at, saved_at
         FROM content_drafts
         WHERE owner_id = ? AND draft_type = 'review' AND deleted_at IS NULL
         ORDER BY saved_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(userId, req.page_size, (req.page - 1) * req.page_size) as DraftRow[];
    const items = rows.map((row) => toDraftView(row, readReviewPluginId(conn, row.review_id)));
    return buildPage(items, total, req);
  }, db);
}

/** 「我的评测」草稿列表用的摘要：标题取**当前草稿载荷**，不是首次提交的修订标题。 */
export interface DraftSummary {
  draftId: string;
  reviewId: string | null;
  saveVersion: number;
  savedAt: number;
  title: string;
  /** 这篇评测是否已经发布过（有公开修订指针）。 */
  published: boolean;
  /** 是否已撤回（发布过且 withdrawn_at 非空）。 */
  withdrawn: boolean;
  /** 撤回所需的乐观锁版本；未发布/未关联评测时为 null。 */
  controlVersion: number | null;
}

/**
 * 草稿摘要列表（我的评测页）。
 *
 * 这里的 title 必须来自 `content_drafts.payload`：草稿是「可继续改」的，
 * 第一次保存后标题还可能变；如果读 `review_revisions.title`（只在提交时生成），
 * 页面就会永远显示第一次提交/提交前的标题——这是本轮修掉的缺陷。
 *
 * 对坏 JSON 用 json_valid 兜底为 null，调用方显示「(尚未填写标题)」，不抛 500。
 * 已软删除（deleted_at 非空）的草稿不返回。
 */
export async function listDraftSummaries(
  ctx: CallerContext,
  db?: SqliteDatabase,
  q?: string,
): Promise<DraftSummary[]> {
  const userId = requireActiveUser(ctx);
  const keyword = (q ?? '').trim();
  const like = keyword ? `%${keyword.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  return withRead((conn) => {
    const rows = conn
      .prepare(
        `SELECT d.id, d.review_id, d.save_version, d.saved_at,
                CASE WHEN json_valid(d.payload) THEN json_extract(d.payload, '$.title') ELSE NULL END AS title,
                r.published_revision_id,
                ce.withdrawn_at,
                ce.visibility_control_version
           FROM content_drafts d
           LEFT JOIN reviews r ON r.id = d.review_id
           LEFT JOIN content_entities ce ON ce.id = d.review_id
          WHERE d.owner_id = ? AND d.draft_type = 'review' AND d.deleted_at IS NULL
            AND (? IS NULL OR IFNULL(json_extract(d.payload, '$.title'), '') LIKE ? ESCAPE '\\')
          ORDER BY d.saved_at DESC, d.id DESC`,
      )
      .all(userId, like, like) as {
      id: string;
      review_id: string | null;
      save_version: number;
      saved_at: number;
      title: string | null;
      published_revision_id: string | null;
      withdrawn_at: number | null;
      visibility_control_version: number | null;
    }[];
    return rows.map((row) => ({
      draftId: row.id,
      reviewId: row.review_id,
      saveVersion: row.save_version,
      savedAt: row.saved_at,
      title: row.title ?? '',
      published: row.published_revision_id !== null,
      withdrawn: row.withdrawn_at !== null,
      controlVersion: row.visibility_control_version ?? null,
    }));
  }, db);
}

export type ReviewsService = typeof reviewsService;
