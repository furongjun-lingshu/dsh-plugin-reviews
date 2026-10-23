/**
 * 互动三件套：有帮助 / 收藏 / 举报（`idea.md §13`、§15、§20；`idea.md §23` 的举报处理）。
 *
 * 三条共同的设计纪律：
 *  1. **写入之前先确认目标公开且存在**：对一篇未公开（待审/草稿/已撤回/已隐藏）的评测投票或
 *     举报没有意义，也会泄露"存在这样一篇文章"；所以先用 `resolveVisibilityInTx` 判可见性。
 *  2. **计数不落冗余列**：有帮助数永远 `COUNT(*)` 现算。这个量级（单篇几千）COUNT 很便宜，
 *     而冗余计数列一旦漂移就要写修复脚本。
 *  3. **处理必须留记录**：`reports` 只存当前状态，每一次处理动作（隐藏/驳回/要求补证据）
 *     都写进 `report_handling_records`，并把结果以 `moderation_result` 通知发给相关的人。
 *
 * "隐藏评论"用的是迁移 0012 新增的 `comments.hidden_*` 三列，**不复用 `deleted_at`**：
 * 作者删除是"本人撤下"，管理员隐藏是"违规处理"，页面文案、审计与申诉路径都不同。
 */

import type { SqliteDatabase } from '@/server/platform/db';
import { getDb } from '@/server/platform/db';
import { withRead, withTransaction } from '@/server/platform/tx';
import { newId } from '@/server/platform/id';
import { nowMs } from '@/server/platform/time';
import { err } from '@/packages/common/errors';
import { assertCanWrite, isAdmin, type CallerContext } from '@/server/platform/context';
import { resolveVisibilityInTx } from '@/server/modules/content';
import { deliverModerationResultNotification } from '@/server/modules/notifications';

export type ReportTargetKind = 'review' | 'comment' | 'pack_release';
export type ReportReason = 'spam' | 'abuse' | 'misinformation' | 'copyright' | 'other';
export type ReportAction = 'hide' | 'dismiss' | 'request_evidence';
export type ReportState = 'open' | 'resolved' | 'dismissed';

/** 举报原因的中文口径（前后端共用一份，避免两处各写一套）。 */
export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  spam: '垃圾广告',
  abuse: '辱骂或人身攻击',
  misinformation: '错误信息（含误导性实测结论）',
  copyright: '版权或抄袭',
  other: '其他（请补充说明）',
};

export const REPORT_TARGET_LABELS: Record<ReportTargetKind, string> = {
  review: '评测',
  comment: '评论',
  pack_release: '整合包版本',
};

export interface HelpfulState {
  helpful: boolean;
  count: number;
}

export interface FavoritePluginView {
  pluginId: string;
  displayName: string | null;
  repositoryFullName: string;
  pluginPath: string;
  isArchived: boolean;
  createdAt: number;
  folderId: string;
  folderName: string;
}

export interface FavoriteFolderView {
  folderId: string;
  name: string;
  isDefault: boolean;
  count: number;
  createdAt: number;
}

export interface ReportView {
  reportId: string;
  targetKind: ReportTargetKind;
  contentEntityId: string;
  commentId: string | null;
  reason: ReportReason;
  detail: string | null;
  state: ReportState;
  reporterNickname: string;
  createdAt: number;
  /** 被举报对象的一句话摘要（页面直接展示，不用再点进去才知道是什么）。 */
  targetExcerpt: string;
  /** 站内跳转地址（评测 → /reviews/<id>；评论 → 其所属评测）。 */
  targetHref: string;
}

export interface HandleReportResult {
  reportId: string;
  state: ReportState;
  action: ReportAction;
  /** 实际投递出去的通知条数（自己通知自己会被跳过）。 */
  notified: number;
}

const EXCERPT_MAX = 120;

/** 默认收藏夹的固定名称（服务端创建，唯一）。 */
export const DEFAULT_FAVORITE_FOLDER_NAME = '默认收藏夹';

/**
 * 确保用户存在默认收藏夹；历史收藏（folder_id IS NULL）回填进来。
 * 必须在事务内调用（会写库）。
 */
function ensureDefaultFolderInTx(conn: SqliteDatabase, userId: string): { id: string } {
  const existing = conn
    .prepare('SELECT id FROM favorite_folders WHERE user_id = ? AND is_default = 1')
    .get(userId) as { id: string } | undefined;
  if (existing) {
    conn
      .prepare('UPDATE plugin_favorites SET folder_id = ? WHERE user_id = ? AND folder_id IS NULL')
      .run(existing.id, userId);
    return existing;
  }
  const id = newId();
  const now = nowMs();
  conn
    .prepare(
      `INSERT INTO favorite_folders (id, user_id, name, is_default, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    )
    .run(id, userId, DEFAULT_FAVORITE_FOLDER_NAME, now, now);
  conn
    .prepare('UPDATE plugin_favorites SET folder_id = ? WHERE user_id = ? AND folder_id IS NULL')
    .run(id, userId);
  return { id };
}

/** 目标是否存在且"当前公开"——决定能不能投票/举报。 */
function assertTargetPublic(db: SqliteDatabase, target: { kind: ReportTargetKind; id: string }): string {
  if (target.kind === 'pack_release') {
    // 整合包版本在 P4 才放开 content_type 闸门；现在遇到就直接拒绝，别留下指向空气的举报。
    throw err.input('整合包版本的举报将在整合包上线后开放。', [{ path: 'targetId', message: '暂不支持' }]);
  }

  if (target.kind === 'review') {
    const row = db.prepare("SELECT id, content_type FROM content_entities WHERE id = ?").get(target.id) as
      | { id: string; content_type: string }
      | undefined;
    if (!row || row.content_type !== 'review') throw err.unavailable('要举报的评测不存在。');
    if (!resolveVisibilityInTx(db, target.id).publiclyVisible) {
      throw err.unavailable('该评测当前不可见，无法举报。');
    }
    return target.id;
  }

  // comment：举报的是评论，但"可见性"按它所属的内容实体判（内容不可见时评论也看不到）
  const comment = db
    .prepare('SELECT id, content_entity_id, deleted_at, hidden_at FROM comments WHERE id = ?')
    .get(target.id) as
    | { id: string; content_entity_id: string; deleted_at: number | null; hidden_at: number | null }
    | undefined;
  if (!comment) throw err.unavailable('要举报的评论不存在。');
  if (comment.deleted_at !== null) throw err.unavailable('该评论已被作者删除。');
  if (comment.hidden_at !== null) throw err.unavailable('该评论已被隐藏。');
  if (!resolveVisibilityInTx(db, comment.content_entity_id).publiclyVisible) {
    throw err.unavailable('该评论所属内容当前不可见，无法举报。');
  }
  return comment.content_entity_id;
}

/** 评测/评论的一句话摘要（后台队列与通知里用）。 */
function describeTarget(
  db: SqliteDatabase,
  target: { kind: ReportTargetKind; id: string; contentEntityId: string; commentId: string | null },
): { excerpt: string; href: string } {
  if (target.kind === 'review') {
    const row = db
      .prepare(
        `SELECT rev.title AS title FROM reviews r
           JOIN review_revisions rev ON rev.id = r.published_revision_id
          WHERE r.id = ?`,
      )
      .get(target.id) as { title: string } | undefined;
    return {
      excerpt: (row?.title ?? '（评测）').slice(0, EXCERPT_MAX),
      href: `/reviews/${target.id}`,
    };
  }
  if (target.kind === 'comment') {
    const row = db
      .prepare(
        `SELECT rev.body AS body FROM comments c
           JOIN comment_revisions rev ON rev.id = c.published_revision_id
          WHERE c.id = ?`,
      )
      .get(target.commentId) as { body: string } | undefined;
    return {
      excerpt: (row?.body ?? '（评论）').replace(/\s+/g, ' ').slice(0, EXCERPT_MAX),
      href: `/reviews/${target.contentEntityId}`,
    };
  }
  return { excerpt: '（整合包版本）', href: '/' };
}

export function createInteractionsService(deps: { db: SqliteDatabase }) {
  const { db } = deps;

  function helpfulCountFor(conn: SqliteDatabase, reviewId: string): number {
    return (conn.prepare('SELECT COUNT(*) AS c FROM review_helpful_votes WHERE review_id = ?').get(reviewId) as {
      c: number;
    }).c;
  }

  return {
    /** 某篇评测的有帮助状态（`userId` 为空表示匿名，只返回总数）。 */
    async helpfulState(reviewId: string, userId: string | null, injectedDb?: SqliteDatabase): Promise<HelpfulState> {
      return withRead((conn) => {
        const count = helpfulCountFor(conn, reviewId);
        if (userId === null) return { helpful: false, count };
        const row = conn
          .prepare('SELECT 1 AS x FROM review_helpful_votes WHERE review_id = ? AND user_id = ?')
          .get(reviewId, userId);
        return { helpful: row !== undefined, count };
      }, injectedDb ?? db);
    },

    /** 切换"有帮助"（登录、公开评测；一人一票，再点取消）。 */
    async toggleHelpful(ctx: CallerContext, reviewId: string, injectedDb?: SqliteDatabase): Promise<HelpfulState> {
      assertCanWrite(ctx);
      const userId = ctx.userId;
      return withTransaction((tx) => {
        const conn = tx.db;
        if (!resolveVisibilityInTx(conn, reviewId).publiclyVisible) {
          throw err.unavailable('只能对当前公开的评测表达"有帮助"。');
        }
        const existing = conn
          .prepare('SELECT 1 AS x FROM review_helpful_votes WHERE review_id = ? AND user_id = ?')
          .get(reviewId, userId);
        if (existing) {
          conn.prepare('DELETE FROM review_helpful_votes WHERE review_id = ? AND user_id = ?').run(reviewId, userId);
        } else {
          conn
            .prepare('INSERT INTO review_helpful_votes (user_id, review_id, created_at) VALUES (?, ?, ?)')
            .run(userId, reviewId, nowMs());
        }
        return { helpful: !existing, count: helpfulCountFor(conn, reviewId) };
      }, injectedDb ?? db);
    },

    /** 批量取多篇评测的有帮助数（列表用；一条 SQL 避免 N+1）。 */
    async helpfulCounts(reviewIds: string[], injectedDb?: SqliteDatabase): Promise<Map<string, number>> {
      const out = new Map<string, number>();
      if (reviewIds.length === 0) return out;
      return withRead((conn) => {
        const placeholders = reviewIds.map(() => '?').join(', ');
        const rows = conn
          .prepare(
            `SELECT review_id, COUNT(*) AS c FROM review_helpful_votes
              WHERE review_id IN (${placeholders}) GROUP BY review_id`,
          )
          .all(...reviewIds) as Array<{ review_id: string; c: number }>;
        for (const row of rows) out.set(row.review_id, row.c);
        return out;
      }, injectedDb ?? db);
    },

    /** 收藏/取消收藏插件（P1 只支持插件；整合包等 P4）。 */
    async toggleFavorite(
      ctx: CallerContext,
      input: { kind: 'plugin' | 'pack'; targetId: string },
      injectedDb?: SqliteDatabase,
    ): Promise<{ favorited: boolean }> {
      assertCanWrite(ctx);
      const userId = ctx.userId;
      if (input.kind === 'pack') {
        throw err.input('整合包收藏将在整合包上线后开放。', [{ path: 'kind', message: '暂不支持' }]);
      }
      return withTransaction((tx) => {
        const conn = tx.db;
        const exists = conn.prepare('SELECT 1 AS x FROM plugins WHERE id = ?').get(input.targetId);
        if (!exists) throw err.unavailable('要收藏的插件不存在。');

        const current = conn
          .prepare('SELECT 1 AS x FROM plugin_favorites WHERE user_id = ? AND plugin_id = ?')
          .get(userId, input.targetId);
        if (current) {
          conn.prepare('DELETE FROM plugin_favorites WHERE user_id = ? AND plugin_id = ?').run(userId, input.targetId);
          return { favorited: false };
        }
        const folder = ensureDefaultFolderInTx(conn, userId);
        conn
          .prepare(
            'INSERT INTO plugin_favorites (user_id, plugin_id, folder_id, created_at) VALUES (?, ?, ?, ?)',
          )
          .run(userId, input.targetId, folder.id, nowMs());
        return { favorited: true };
      }, injectedDb ?? db);
    },

    /** 收藏到指定收藏夹（未指定则默认夹）；已收藏则移动。 */
    async setFavorite(
      ctx: CallerContext,
      input: { pluginId: string; folderId?: string | null },
      injectedDb?: SqliteDatabase,
    ): Promise<{ favorited: true; folderId: string }> {
      assertCanWrite(ctx);
      const userId = ctx.userId;
      return withTransaction((tx) => {
        const conn = tx.db;
        const plugin = conn.prepare('SELECT id FROM plugins WHERE id = ?').get(input.pluginId);
        if (!plugin) throw err.unavailable('要收藏的插件不存在。');

        const defaultFolder = ensureDefaultFolderInTx(conn, userId);
        const folderId = input.folderId ?? defaultFolder.id;
        const folder = conn
          .prepare('SELECT id FROM favorite_folders WHERE id = ? AND user_id = ?')
          .get(folderId, userId);
        if (!folder) throw err.input('收藏夹不存在。', [{ path: 'folderId', message: '未知收藏夹' }]);

        conn
          .prepare(
            `INSERT INTO plugin_favorites (user_id, plugin_id, folder_id, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id, plugin_id)
             DO UPDATE SET folder_id = excluded.folder_id, created_at = excluded.created_at`,
          )
          .run(userId, input.pluginId, folderId, nowMs());
        return { favorited: true as const, folderId };
      }, injectedDb ?? db);
    },

    /** 取消收藏（不关心在哪个收藏夹）。 */
    async removeFavorite(
      ctx: CallerContext,
      pluginId: string,
      injectedDb?: SqliteDatabase,
    ): Promise<{ favorited: false }> {
      assertCanWrite(ctx);
      const userId = ctx.userId;
      return withTransaction((tx) => {
        tx.db.prepare('DELETE FROM plugin_favorites WHERE user_id = ? AND plugin_id = ?').run(userId, pluginId);
        return { favorited: false as const };
      }, injectedDb ?? db);
    },

    /** 收藏夹列表（含每夹收藏数）；首次访问时创建默认夹。 */
    async listFavoriteFolders(
      ctx: CallerContext,
      injectedDb?: SqliteDatabase,
    ): Promise<FavoriteFolderView[]> {
      if (ctx.userId === null) throw err.unauthenticated();
      const userId = ctx.userId;
      return withTransaction((tx) => {
        ensureDefaultFolderInTx(tx.db, userId);
        const rows = tx.db
          .prepare(
            `SELECT f.id, f.name, f.is_default, f.created_at,
                    (SELECT COUNT(*) FROM plugin_favorites pf WHERE pf.folder_id = f.id) AS c
               FROM favorite_folders f
              WHERE f.user_id = ?
              ORDER BY f.is_default DESC, f.created_at ASC, f.id ASC`,
          )
          .all(userId) as Array<{
          id: string;
          name: string;
          is_default: number;
          created_at: number;
          c: number;
        }>;
        return rows.map((r) => ({
          folderId: r.id,
          name: r.name,
          isDefault: r.is_default === 1,
          count: Number(r.c),
          createdAt: r.created_at,
        }));
      }, injectedDb ?? db);
    },

    /** 新建收藏夹（不能重名；1-40 字）。 */
    async createFavoriteFolder(
      ctx: CallerContext,
      name: string,
      injectedDb?: SqliteDatabase,
    ): Promise<FavoriteFolderView> {
      assertCanWrite(ctx);
      const userId = ctx.userId;
      const trimmed = typeof name === 'string' ? name.trim() : '';
      if (trimmed.length === 0 || trimmed.length > 40) {
        throw err.input('收藏夹名称需为 1-40 个字。', [{ path: 'name', message: '长度不合法' }]);
      }
      return withTransaction((tx) => {
        const conn = tx.db;
        ensureDefaultFolderInTx(conn, userId);
        const existing = conn
          .prepare('SELECT 1 AS x FROM favorite_folders WHERE user_id = ? AND name = ?')
          .get(userId, trimmed);
        if (existing) throw err.input('同名收藏夹已存在。', [{ path: 'name', message: '重名' }]);
        const id = newId();
        const now = nowMs();
        conn
          .prepare(
            `INSERT INTO favorite_folders (id, user_id, name, is_default, created_at, updated_at)
             VALUES (?, ?, ?, 0, ?, ?)`,
          )
          .run(id, userId, trimmed, now, now);
        return { folderId: id, name: trimmed, isDefault: false, count: 0, createdAt: now };
      }, injectedDb ?? db);
    },

    /** 某个收藏夹的内容（校验归属）。 */
    async getFavoriteFolder(
      ctx: CallerContext,
      folderId: string,
      injectedDb?: SqliteDatabase,
    ): Promise<{ folder: FavoriteFolderView; plugins: FavoritePluginView[] }> {
      if (ctx.userId === null) throw err.unauthenticated();
      const userId = ctx.userId;
      return withRead((conn) => {
        const folder = conn
          .prepare(
            'SELECT id, name, is_default, created_at FROM favorite_folders WHERE id = ? AND user_id = ?',
          )
          .get(folderId, userId) as
          | { id: string; name: string; is_default: number; created_at: number }
          | undefined;
        if (!folder) throw err.unavailable('收藏夹不存在或不可访问。');

        const rows = conn
          .prepare(
            `SELECT f.plugin_id, f.created_at, f.folder_id, p.display_name, p.plugin_path,
                    r.full_name, r.is_archived
               FROM plugin_favorites f
               JOIN plugins p ON p.id = f.plugin_id
               JOIN repositories r ON r.id = p.repository_id
              WHERE f.user_id = ? AND f.folder_id = ?
              ORDER BY f.created_at DESC, f.plugin_id ASC`,
          )
          .all(userId, folderId) as Array<{
          plugin_id: string;
          created_at: number;
          folder_id: string;
          display_name: string | null;
          plugin_path: string;
          full_name: string;
          is_archived: number;
        }>;

        return {
          folder: {
            folderId: folder.id,
            name: folder.name,
            isDefault: folder.is_default === 1,
            count: rows.length,
            createdAt: folder.created_at,
          },
          plugins: rows.map((r) => ({
            pluginId: r.plugin_id,
            displayName: r.display_name,
            repositoryFullName: r.full_name,
            pluginPath: r.plugin_path,
            isArchived: r.is_archived === 1,
            createdAt: r.created_at,
            folderId: folder.id,
            folderName: folder.name,
          })),
        };
      }, injectedDb ?? db);
    },

    /** 收藏页标题搜索：跨收藏夹匹配插件名/仓库名，结果带所在收藏夹。 */
    async searchFavorites(
      ctx: CallerContext,
      q: string,
      injectedDb?: SqliteDatabase,
    ): Promise<FavoritePluginView[]> {
      if (ctx.userId === null) throw err.unauthenticated();
      const userId = ctx.userId;
      const keyword = (q ?? '').trim();
      if (!keyword) return [];
      const like = `%${keyword.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      return withRead((conn) => {
        const rows = conn
          .prepare(
            `SELECT f.plugin_id, f.created_at, f.folder_id, ff.name AS folder_name,
                    p.display_name, p.plugin_path, r.full_name, r.is_archived
               FROM plugin_favorites f
               JOIN plugins p ON p.id = f.plugin_id
               JOIN repositories r ON r.id = p.repository_id
               LEFT JOIN favorite_folders ff ON ff.id = f.folder_id
              WHERE f.user_id = ?
                AND (IFNULL(p.display_name, '') LIKE ? ESCAPE '\\'
                     OR r.full_name LIKE ? ESCAPE '\\')
              ORDER BY f.created_at DESC, f.plugin_id ASC`,
          )
          .all(userId, like, like) as Array<{
          plugin_id: string;
          created_at: number;
          folder_id: string | null;
          folder_name: string | null;
          display_name: string | null;
          plugin_path: string;
          full_name: string;
          is_archived: number;
        }>;
        return rows.map((r) => ({
          pluginId: r.plugin_id,
          displayName: r.display_name,
          repositoryFullName: r.full_name,
          pluginPath: r.plugin_path,
          isArchived: r.is_archived === 1,
          createdAt: r.created_at,
          folderId: r.folder_id ?? '',
          folderName: r.folder_name ?? DEFAULT_FAVORITE_FOLDER_NAME,
        }));
      }, injectedDb ?? db);
    },

    /** 插件详情页用：当前用户是否已收藏。 */
    async isFavorite(ctx: CallerContext, pluginId: string, injectedDb?: SqliteDatabase): Promise<boolean> {
      if (ctx.userId === null) return false;
      return withRead(
        (conn) =>
          conn.prepare('SELECT 1 AS x FROM plugin_favorites WHERE user_id = ? AND plugin_id = ?').get(ctx.userId, pluginId) !==
          undefined,
        injectedDb ?? db,
      );
    },

    /** 个人中心"收藏的插件"。 */
    async listFavoritePlugins(ctx: CallerContext, injectedDb?: SqliteDatabase): Promise<FavoritePluginView[]> {
      if (ctx.userId === null) throw err.unauthenticated();
      const userId = ctx.userId;
      return withRead((conn) => {
        const rows = conn
          .prepare(
            `SELECT f.plugin_id, f.created_at, f.folder_id, ff.name AS folder_name,
                    p.display_name, p.plugin_path, r.full_name, r.is_archived
               FROM plugin_favorites f
               JOIN plugins p ON p.id = f.plugin_id
               JOIN repositories r ON r.id = p.repository_id
               LEFT JOIN favorite_folders ff ON ff.id = f.folder_id
              WHERE f.user_id = ?
              ORDER BY f.created_at DESC, f.plugin_id ASC`,
          )
          .all(userId) as Array<{
          plugin_id: string;
          created_at: number;
          folder_id: string | null;
          folder_name: string | null;
          display_name: string | null;
          plugin_path: string;
          full_name: string;
          is_archived: number;
        }>;
        return rows.map((r) => ({
          pluginId: r.plugin_id,
          displayName: r.display_name,
          repositoryFullName: r.full_name,
          pluginPath: r.plugin_path,
          isArchived: r.is_archived === 1,
          createdAt: r.created_at,
          folderId: r.folder_id ?? '',
          folderName: r.folder_name ?? DEFAULT_FAVORITE_FOLDER_NAME,
        }));
      }, injectedDb ?? db);
    },

    /**
     * 提交举报。同一人 + 同一目标 + 同一原因若已有**未处理**的举报，直接返回那一条
     * （部分唯一索引兜底），不重复堆积。
     */
    async createReport(
      ctx: CallerContext,
      input: { targetKind: ReportTargetKind; targetId: string; reason: ReportReason; detail?: string | null },
      injectedDb?: SqliteDatabase,
    ): Promise<{ reportId: string; created: boolean }> {
      assertCanWrite(ctx);
      const userId = ctx.userId;
      const detail = typeof input.detail === 'string' ? input.detail.trim() : '';
      if (!(input.reason in REPORT_REASON_LABELS)) {
        throw err.input('举报原因不合法。', [{ path: 'reason', message: '取值不合法' }]);
      }
      if (detail.length > 2000) {
        throw err.input('补充说明最多 2000 字。', [{ path: 'detail', message: '过长' }]);
      }

      return withTransaction((tx) => {
        const conn = tx.db;
        const contentEntityId = assertTargetPublic(conn, { kind: input.targetKind, id: input.targetId });
        const commentId = input.targetKind === 'comment' ? input.targetId : null;

        const existing = conn
          .prepare(
            `SELECT id FROM reports
              WHERE reporter_id = ? AND target_kind = ? AND content_entity_id = ? AND reason = ? AND state = 'open'`,
          )
          .get(userId, input.targetKind, contentEntityId, input.reason) as { id: string } | undefined;
        if (existing) return { reportId: existing.id, created: false };

        const reportId = newId();
        conn
          .prepare(
            `INSERT INTO reports
               (id, reporter_id, target_kind, content_entity_id, comment_id, reason, detail, state, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
          )
          .run(
            reportId,
            userId,
            input.targetKind,
            contentEntityId,
            commentId,
            input.reason,
            detail.length > 0 ? detail : null,
            nowMs(),
          );
        return { reportId, created: true };
      }, injectedDb ?? db);
    },

    /** 后台举报队列（未处理优先，先进先出）。 */
    async listReports(
      ctx: CallerContext,
      req: { state?: ReportState | 'all'; limit?: number } = {},
      injectedDb?: SqliteDatabase,
    ): Promise<ReportView[]> {
      if (!isAdmin(ctx)) throw err.forbidden('该操作需要管理员权限。');
      const state = req.state ?? 'open';
      const limit = Math.min(Math.max(req.limit ?? 50, 1), 100);
      return withRead((conn) => {
        const rows = conn
          .prepare(
            `SELECT rp.id, rp.target_kind, rp.content_entity_id, rp.comment_id, rp.reason, rp.detail,
                    rp.state, rp.created_at, u.nickname AS reporter_nickname
               FROM reports rp
               JOIN users u ON u.id = rp.reporter_id
              ${state === 'all' ? '' : "WHERE rp.state = ?"}
              ORDER BY rp.created_at ASC, rp.id ASC
              LIMIT ?`,
          )
          .all(...(state === 'all' ? [limit] : [state, limit])) as Array<{
          id: string;
          target_kind: ReportTargetKind;
          content_entity_id: string;
          comment_id: string | null;
          reason: ReportReason;
          detail: string | null;
          state: ReportState;
          created_at: number;
          reporter_nickname: string;
        }>;
        return rows.map((r) => {
          const described = describeTarget(conn, {
            kind: r.target_kind,
            id: r.comment_id ?? r.content_entity_id,
            contentEntityId: r.content_entity_id,
            commentId: r.comment_id,
          });
          return {
            reportId: r.id,
            targetKind: r.target_kind,
            contentEntityId: r.content_entity_id,
            commentId: r.comment_id,
            reason: r.reason,
            detail: r.detail,
            state: r.state,
            reporterNickname: r.reporter_nickname,
            createdAt: r.created_at,
            targetExcerpt: described.excerpt,
            targetHref: described.href,
          };
        });
      }, injectedDb ?? db);
    },

    /**
     * 处理一条举报：`hide` 真隐藏目标、`dismiss` 驳回、`request_evidence` 要求补充证据（仍挂起）。
     * 每次处理都写 `report_handling_records`，并给举报人（隐藏时还有内容作者）发处理结果通知。
     */
    async handleReport(
      ctx: CallerContext,
      reportId: string,
      input: { action: ReportAction; reason: string },
      injectedDb?: SqliteDatabase,
    ): Promise<HandleReportResult> {
      if (!isAdmin(ctx)) throw err.forbidden('该操作需要管理员权限。');
      const adminId = ctx.userId as string;
      const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
      if (reason.length === 0) throw err.input('处理举报必须填写原因。', [{ path: 'reason', message: '必填' }]);
      if (!['hide', 'dismiss', 'request_evidence'].includes(input.action)) {
        throw err.input('处理动作不合法。', [{ path: 'action', message: '取值不合法' }]);
      }

      return withTransaction((tx) => {
        const conn = tx.db;
        const report = conn
          .prepare(
            `SELECT id, reporter_id, target_kind, content_entity_id, comment_id, state FROM reports WHERE id = ?`,
          )
          .get(reportId) as
          | {
              id: string;
              reporter_id: string;
              target_kind: ReportTargetKind;
              content_entity_id: string;
              comment_id: string | null;
              state: ReportState;
            }
          | undefined;
        if (!report) throw err.unavailable('举报不存在（可能已被删除）。');
        if (report.state !== 'open') throw err.conflict('这条举报已经处理过了。', { state: report.state });

        const now = nowMs();
        conn
          .prepare('INSERT INTO report_handling_records (id, report_id, handled_by, action, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(newId(now), reportId, adminId, input.action, reason, now);

        const nextState: ReportState =
          input.action === 'hide' ? 'resolved' : input.action === 'dismiss' ? 'dismissed' : 'open';
        conn.prepare('UPDATE reports SET state = ? WHERE id = ?').run(nextState, reportId);

        // ---- 真正隐藏目标 ----
        let authorId: string | null = null;
        if (input.action === 'hide') {
          if (report.target_kind === 'review') {
            authorId = (
              conn.prepare('SELECT author_id FROM content_entities WHERE id = ?').get(report.content_entity_id) as
                | { author_id: string }
                | undefined
            )?.author_id ?? null;
            if (!resolveVisibilityInTx(conn, report.content_entity_id).hidden) {
              // 直接写三列而不是调 contentService.hide：那边是 async 接口，在一个同步事务里
              // 既不能 await，也会多开一层 savepoint。这里与它保持**同一套不变量**：
              // 三列同写 + visibility_control_version 递增（触发器会校验）。
              conn
                .prepare(
                  `UPDATE content_entities
                      SET hidden_at = ?, hidden_by = ?, hidden_reason = ?,
                          visibility_control_version = visibility_control_version + 1
                    WHERE id = ? AND hidden_at IS NULL`,
                )
                .run(now, adminId, `举报处理：${reason}`, report.content_entity_id);
            }
          } else if (report.target_kind === 'comment' && report.comment_id !== null) {
            authorId = (
              conn.prepare('SELECT author_id FROM comments WHERE id = ?').get(report.comment_id) as
                | { author_id: string }
                | undefined
            )?.author_id ?? null;
            conn
              .prepare(
                `UPDATE comments SET hidden_at = ?, hidden_by = ?, hidden_reason = ?
                  WHERE id = ? AND hidden_at IS NULL`,
              )
              .run(now, adminId, `举报处理：${reason}`, report.comment_id);
          }
        }

        // ---- 结果通知（自己通知自己被跳过；同一处理重放不重复通知）----
        const targetLabel = REPORT_TARGET_LABELS[report.target_kind];
        const reporterMessage =
          input.action === 'hide'
            ? `你的举报已处理：${targetLabel}已隐藏。原因：${reason}`
            : input.action === 'dismiss'
              ? `你的举报已核实：未发现违规，未做修改。说明：${reason}`
              : `你的举报需要补充证据，请补充后重新提交。说明：${reason}`;
        let notified = 0;
        const keys: string[] = [];
        const notify = (recipientId: string | null, detail: string) => {
          if (recipientId === null) return;
          const key = `report_handled:${reportId}:${recipientId}:${input.action}`;
          if (keys.includes(key)) return;
          keys.push(key);
          const delivered = deliverModerationResultNotification(conn, {
            recipientId,
            actorId: adminId,
            contentEntityId: report.content_entity_id,
            detail,
            deduplicationKey: key,
            now,
          });
          if (delivered.created) notified += 1;
        };
        notify(report.reporter_id, reporterMessage);
        if (input.action === 'hide' && authorId !== null && authorId !== report.reporter_id) {
          notify(authorId, `你发布的${targetLabel}已被管理员隐藏。原因：${reason}。如有异议可联系管理员。`);
        }

        return { reportId, state: nextState, action: input.action, notified };
      }, injectedDb ?? db);
    },
  };
}

export type InteractionsService = ReturnType<typeof createInteractionsService>;

/** 默认连接（路由层用）；显式传 db 的测试不走这里。 */
export function interactionsService(): InteractionsService {
  return createInteractionsService({ db: getDb() });
}
