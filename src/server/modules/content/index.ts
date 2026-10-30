/**
 * 内容可见性与控制模块（工作包 GC · 签名见 已删除的设计稿《模块签名契约》 第 4 节）。
 *
 * 唯一真相（已删除的设计稿《并行工作包》 不变量 7）：
 *   公开 = 存在有效公开修订 且 `withdrawn_at IS NULL` 且 `hidden_at IS NULL`
 * **不得**在业务表另存“公开状态”字段；本模块只做**解析**，不缓存、不复制。
 *
 * 控制版本：
 *   `content_entities.visibility_control_version` 是撤回／隐藏的乐观锁。
 *   写值由本模块负责，触发器 `trg_content_entities_visibility_version`
 *   兜底拒绝“改了 withdrawn_at/hidden_at 却没递增版本”的更新。
 */

import { assertCanAdmin, assertCanWrite, type CallerContext } from '@/server/platform/context';
import { nowMs } from '@/server/platform/time';
import { newId } from '@/server/platform/id';
import { withRead, withTransaction } from '@/server/platform/tx';
import { recordOperationInTx } from '@/server/modules/operations';
import type { SqliteDatabase } from '@/server/platform/db';
import { err } from '@/packages/common/errors';
import { isUuidV7 } from '@/packages/common/field-rules';

export interface VisibilityResolution {
  publiclyVisible: boolean;
  hasPublishedRevision: boolean;
  withdrawn: boolean;
  hidden: boolean;
  controlVersion: number;
}

export interface VisibilityInput {
  entityId: string;
}

interface EntityControlRow {
  id: string;
  author_id: string;
  withdrawn_at: number | null;
  hidden_at: number | null;
  visibility_control_version: number;
}

/** 写入前置：登录 + 账户正常。走平台统一实现，保证错误码与接口层映射一致。 */
function requireActiveUser(ctx: CallerContext): string {
  assertCanWrite(ctx);
  return ctx.userId;
}

/** 管理员前置：走平台统一实现。 */
function requireAdmin(ctx: CallerContext): string {
  assertCanAdmin(ctx);
  return ctx.userId;
}

function parseEntityId(entityId: string): string {
  if (typeof entityId !== 'string' || !isUuidV7(entityId)) {
    throw err.input('内容标识格式不正确。', [{ path: 'entity_id', message: '必须是规范 UUIDv7' }]);
  }
  return entityId;
}

/**
 * 校验操作原因。
 *
 * `allowNull` 决定“可空”是**业务允许**还是“必须填写”：
 *  - `withdraw` 的撤回原因可空（表上 withdrawn_at 与 withdrawal_reason 成对约束允许同空）；
 *  - `hide/unhide` 的原因必填（管理操作必须留下理由）。
 *
 * 用重载表达，避免调用方拿到 `string | null` 再手动断言 —— 那正是类型错误的来源。
 */
function parseReason(reason: string, path: string): string;
function parseReason(reason: string | null, path: string, allowNull: true): string | null;
function parseReason(reason: string | null, path: string, allowNull = false): string | null {
  if (reason === null) {
    if (allowNull) return null;
    throw err.input('原因不能为空。', [{ path, message: '必填' }]);
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw err.input('原因不能为空。', [{ path, message: '必填' }]);
  }
  return reason;
}

function parseRequestKey(requestKey: string): string {
  if (typeof requestKey !== 'string' || requestKey.trim().length === 0) {
    throw err.input('请求标识不能为空。', [{ path: 'request_key', message: '必填' }]);
  }
  return requestKey;
}

function readControlRow(db: SqliteDatabase, entityId: string): EntityControlRow {
  const row = db
    .prepare(
      `SELECT id, author_id, withdrawn_at, hidden_at, visibility_control_version
       FROM content_entities WHERE id = ?`,
    )
    .get(entityId) as EntityControlRow | undefined;
  if (!row) throw err.unavailable('内容不存在或已不可访问。');
  return row;
}

/**
 * 是否存在**有效**公开修订。
 * 判定放在同一条 SELECT 里，避免“先查 reviews 再查 revisions”出现两个时间点的拼接结果。
 */
function hasPublishedRevision(db: SqliteDatabase, entityId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok
       FROM reviews r
       JOIN review_revisions rev ON rev.id = r.published_revision_id
       WHERE r.id = ? AND r.published_revision_id IS NOT NULL AND rev.review_id = r.id
       LIMIT 1`,
    )
    .get(entityId) as { ok: number } | undefined;
  if (row !== undefined) return true;

  // 整合包版本：公开指针就是「已分配发布序号」（架构 §58）。
  // 旧库还没跑 0020 时表不存在，按“没有公开版本”处理，而不是让查询炸掉。
  const hasPacks = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'plugin_pack_releases'")
    .get() as { ok: number } | undefined;
  if (!hasPacks) return false;
  const packRow = db
    .prepare(
      `SELECT 1 AS ok
         FROM plugin_pack_releases rel
         JOIN plugin_packs p ON p.id = rel.pack_id
        WHERE rel.id = ? AND rel.release_number IS NOT NULL
        LIMIT 1`,
    )
    .get(entityId) as { ok: number } | undefined;
  if (packRow !== undefined) return true;

  // 整合包测评：公开指针在 pack_reviews，修订在 pack_review_revisions。
  // 旧库还没跑 0022 时表不存在，按「没有公开修订」处理。
  const hasPackReviews = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'pack_reviews'")
    .get() as { ok: number } | undefined;
  if (!hasPackReviews) return false;
  const reviewRow = db
    .prepare(
      `SELECT 1 AS ok
         FROM pack_reviews pr
         JOIN pack_review_revisions rev ON rev.id = pr.published_revision_id
        WHERE pr.id = ? AND pr.published_revision_id IS NOT NULL AND rev.review_id = pr.id
        LIMIT 1`,
    )
    .get(entityId) as { ok: number } | undefined;
  return reviewRow !== undefined;
}

function resolve(db: SqliteDatabase, entityId: string): VisibilityResolution {
  const control = readControlRow(db, entityId);
  const published = hasPublishedRevision(db, entityId);
  const withdrawn = control.withdrawn_at !== null;
  const hidden = control.hidden_at !== null;
  return {
    // 三个条件必须**同时**满足；少任何一个都不算公开。
    publiclyVisible: published && !withdrawn && !hidden,
    hasPublishedRevision: published,
    withdrawn,
    hidden,
    controlVersion: control.visibility_control_version,
  };
}

/** 作者撤回但未填写原因时的占位文案（表要求撤回时间与原因成对，不能留空）。 */
export const DEFAULT_WITHDRAWAL_REASON = '作者撤回（未填写原因）';

export const contentService = {
  /** 公开资格：存在有效公开修订 + 未撤回 + 未隐藏。匿名可调用（公开读取）。 */
  async resolveVisibility(entityId: string, db?: SqliteDatabase): Promise<VisibilityResolution> {
    const id = parseEntityId(entityId);
    return withRead((conn) => resolve(conn, id), db);
  },

  /**
   * 作者撤回。需要预期控制版本；成功后 `visibility_control_version` 必须递增
   * （触发器兜底，本模块显式 +1，不依赖兜底）。
   *
   * 关于 `reason: string | null`：契约允许作者不填原因，但表上有
   * `CHECK ((withdrawn_at IS NULL) = (withdrawal_reason IS NULL))` ——
   * 撤回时间与原因必须**同生共死**。所以 null 不能原样写进去（会被 CHECK 拒绝并
   * 冒出一个裸 SqliteError）。这里把“未填写”落成一个明确的默认文案，
   * 既不丢事实（作者没写原因），也不破坏成对约束。
   */
  async withdraw(
    ctx: CallerContext,
    input: { reviewId: string; expectedControlVersion: number; reason: string | null; requestKey: string },
    db?: SqliteDatabase,
  ): Promise<{ withdrawnAt: number }> {
    const userId = requireActiveUser(ctx);
    const reviewId = parseEntityId(input.reviewId);
    const parsedReason = parseReason(input.reason, 'reason', true);
    // 未填写原因时的占位文案：与「撤回时间非空」成对存在。
    const reason = parsedReason ?? DEFAULT_WITHDRAWAL_REASON;
    const requestKey = parseRequestKey(input.requestKey);

    if (!Number.isInteger(input.expectedControlVersion) || input.expectedControlVersion < 0) {
      throw err.input('预期控制版本必须是非负整数。', [{ path: 'expected_control_version', message: '取值不合法' }]);
    }

    return withTransaction((tx) => {
      const conn = tx.db;
      const row = readControlRow(conn, reviewId); // 不存在的评测直接 target_unavailable

      // 只有作者本人可撤回自己的文章；管理员走 hide/unhide，不走 withdraw。
      if (row.author_id !== userId) throw err.forbidden('只有作者本人可以撤回自己的评测。');

      if (row.withdrawn_at !== null) throw err.conflict('该评测已经撤回。', { current_version: row.visibility_control_version });

      const now = nowMs();
      // 原子条件更新：撤回时间与被撤前的控制字段状态一起比较，
      // 保证「先读后写」之间被别的请求改过时不会写进过期判断。
      const updated = conn
        .prepare(
          `UPDATE content_entities
             SET withdrawn_at = ?, withdrawal_reason = ?, visibility_control_version = visibility_control_version + 1
           WHERE id = ? AND visibility_control_version = ? AND withdrawn_at IS NULL AND hidden_at IS NULL`,
        )
        .run(now, reason, reviewId, input.expectedControlVersion);

      if (updated.changes === 0) {
        throw err.conflict('可见性状态已被其他操作改变，请刷新后重试。', {
          current_version: row.visibility_control_version,
          expected_version: input.expectedControlVersion,
        });
      }

      // 撤回即失去公开资格：不清除 published_revision_id（历史仍在），
      // 公开与否完全由 resolveVisibility 计算 —— 不另存"公开状态"字段。
      //
      // 审计：撤回是作者对自己内容的处置，后台也该能回答"这篇是谁什么时候撤的、为什么"。
      // 与管理员 hide/unhide 分属不同动作名，便于按动作筛选时区分"作者撤回"与"被隐藏"。
      recordOperationInTx(
        conn,
        {
          actionType: 'content.withdraw',
          operationKey: requestKey,
          actorKind: 'user',
          actorUserId: userId,
          targetType: 'content_entity',
          targetId: reviewId,
          targetSnapshot: { withdrawn_at: now, visibility_control_version: input.expectedControlVersion + 1 },
          changes: { withdrawn: true, reason },
          reason,
        },
        now,
      );
      return { withdrawnAt: now };
    }, db);
  },

  /** 管理员隐藏。 */
  async hide(
    ctx: CallerContext,
    input: { entityId: string; reason: string; requestKey: string },
    db?: SqliteDatabase,
  ): Promise<{ hiddenAt: number }> {
    const adminId = requireAdmin(ctx);
    const entityId = parseEntityId(input.entityId);
    const reason = parseReason(input.reason, 'reason');
    const requestKey = parseRequestKey(input.requestKey);

    return withTransaction((tx) => {
      const conn = tx.db;
      const row = readControlRow(conn, entityId);

      if (row.hidden_at !== null) throw err.conflict('该内容已处于隐藏状态。', { current_version: row.visibility_control_version });

      const now = nowMs();
      const updated = conn
        .prepare(
          `UPDATE content_entities
             SET hidden_at = ?, hidden_by = ?, hidden_reason = ?, visibility_control_version = visibility_control_version + 1
           WHERE id = ? AND hidden_at IS NULL`,
        )
        .run(now, adminId, reason, entityId);

      if (updated.changes === 0) {
        throw err.conflict('可见性状态已被其他操作改变，请刷新后重试。', {
          current_version: row.visibility_control_version,
        });
      }

      // 审计：隐藏是"谁在什么时候因为什么把什么下线"，必须能查。
      // 此前 hide/unhide 只写业务列、不写 operation_records，管理员在后台查不到这类动作。
      // operationKey 直接用请求的 requestKey —— 同一次操作重试不会记两条。
      recordOperationInTx(
        conn,
        {
          actionType: 'content.hide',
          operationKey: requestKey,
          actorKind: 'admin',
          actorUserId: adminId,
          targetType: 'content_entity',
          targetId: entityId,
          targetSnapshot: { hidden_at: now, hidden_by: adminId, visibility_control_version: row.visibility_control_version + 1 },
          changes: { hidden: true },
          reason,
        },
        now,
      );
      return { hiddenAt: now };
    }, db);
  },

  /** 管理员解除隐藏。 */
  async unhide(
    ctx: CallerContext,
    input: { entityId: string; reason: string; requestKey: string },
    db?: SqliteDatabase,
  ): Promise<{ hiddenAt: null }> {
    const adminId = requireAdmin(ctx);
    const entityId = parseEntityId(input.entityId);
    const reason = parseReason(input.reason, 'reason');
    const requestKey = parseRequestKey(input.requestKey);

    return withTransaction((tx) => {
      const conn = tx.db;
      const row = readControlRow(conn, entityId);

      if (row.hidden_at === null) throw err.conflict('该内容当前未被隐藏。', { current_version: row.visibility_control_version });

      // 三个隐藏字段必须同生共死：表上有
      // CHECK ((hidden_at IS NULL) = (hidden_by IS NULL AND hidden_reason IS NULL)) 形状的约束，
      // 所以一起置空。visibility_control_version 同样必须递增（触发器兜底）。
      const updated = conn
        .prepare(
          `UPDATE content_entities
             SET hidden_at = NULL, hidden_by = NULL, hidden_reason = NULL,
                 visibility_control_version = visibility_control_version + 1
           WHERE id = ? AND hidden_at IS NOT NULL`,
        )
        .run(entityId);

      if (updated.changes === 0) {
        throw err.conflict('可见性状态已被其他操作改变，请刷新后重试。', {
          current_version: row.visibility_control_version,
        });
      }

      // 解除隐藏只是恢复"可公开"，并不等于恢复公开：撤回状态仍独立生效。
      recordOperationInTx(
        conn,
        {
          actionType: 'content.unhide',
          operationKey: requestKey,
          actorKind: 'admin',
          actorUserId: adminId,
          targetType: 'content_entity',
          targetId: entityId,
          targetSnapshot: { hidden_at: row.hidden_at, visibility_control_version: row.visibility_control_version + 1 },
          changes: { hidden: false },
          reason,
        },
        nowMs(),
      );
      void reason;
      return { hiddenAt: null };
    }, db);
  },
};

/** 供其他模块（如 moderation 发布前复核）在同一事务内复用同一套可见性判定。 */
export function resolveVisibilityInTx(db: SqliteDatabase, entityId: string): VisibilityResolution {
  return resolve(db, entityId);
}

/** 生成一次操作的幂等键（调用方负责持久化语义）。 */
export function newOperationKey(prefix: string): string {
  return `${prefix}:${newId()}`;
}

export type ContentService = typeof contentService;
