/**
 * 每用户偏好（迁移 0030）。
 *
 * 设计取舍：
 *   - **缺键即默认**：库里只存"用户主动改过"的键，读取时与 `DEFAULT_PREFERENCES` 合并。
 *     这样改默认值不需要写迁移，也不会出现"历史默认值被冻结"；
 *   - **白名单键 + 取值校验**：偏好是用户输入，未知键直接拒绝（而不是静默写进去），
 *     免得将来某天一个拼错的键永远读不到；
 *   - 只做读写，不做审计：这是界面偏好，不是业务变更（与 `site_settings` 的差异也在这）。
 */

import type { SqliteDatabase } from '@/server/platform/db';
import { getDb } from '@/server/platform/db';
import { withRead, withTransaction } from '@/server/platform/tx';
import { nowMs } from '@/server/platform/time';
import { err } from '@/packages/common/errors';
import type { CallerContext } from '@/server/platform/context';
import {
  AUTOSAVE_SECONDS_OPTIONS,
  DEFAULT_AUTOSAVE_SECONDS,
  isAutosaveSeconds,
} from '@/packages/common/autosave';

export { AUTOSAVE_SECONDS_OPTIONS };

/** 偏好键（库里存的就是这些字符串）。 */
export const PREF_KEYS = {
  editorAutosaveSeconds: 'editor.autosave_seconds',
} as const;

export type PreferenceKey = (typeof PREF_KEYS)[keyof typeof PREF_KEYS];

export interface UserPreferences {
  /** 草稿自动保存间隔（秒）；0 表示关闭。 */
  editorAutosaveSeconds: number;
}

/** 默认值：停笔 5 秒保存（与迁移注释、个人设置页文案一致）。 */
export const DEFAULT_PREFERENCES: UserPreferences = { editorAutosaveSeconds: DEFAULT_AUTOSAVE_SECONDS };

function validateAutosaveSeconds(raw: unknown): number {
  if (!isAutosaveSeconds(raw)) {
    throw err.input(
      `自动保存间隔只能取 ${AUTOSAVE_SECONDS_OPTIONS.join(' / ')} 秒。`,
      [{ path: 'editorAutosaveSeconds', message: '取值不在允许范围内' }],
    );
  }
  return raw;
}

/** 读取某用户的偏好（缺键回落默认值）。 */
export function readPreferences(db: SqliteDatabase, userId: string): UserPreferences {
  const rows = db
    .prepare('SELECT key, value FROM user_preferences WHERE user_id = ?')
    .all(userId) as Array<{ key: string; value: string }>;
  const result: UserPreferences = { ...DEFAULT_PREFERENCES };
  for (const row of rows) {
    if (row.key === PREF_KEYS.editorAutosaveSeconds) {
      const parsed = JSON.parse(row.value) as unknown;
      // 库里可能有旧版本遗留的非法值（比如将来缩了取值范围）：读的时候不炸，回落默认。
      if (isAutosaveSeconds(parsed)) {
        result.editorAutosaveSeconds = parsed;
      }
    }
  }
  return result;
}

/** 写入偏好的补丁（只改给出的键）。 */
export function writePreferences(
  ctx: CallerContext,
  patch: Partial<UserPreferences>,
  db: SqliteDatabase = getDb(),
): UserPreferences {
  const userId = ctx.userId;
  if (!userId) throw err.unauthenticated();

  const entries: Array<{ key: PreferenceKey; value: unknown }> = [];
  if (patch.editorAutosaveSeconds !== undefined) {
    entries.push({
      key: PREF_KEYS.editorAutosaveSeconds,
      value: validateAutosaveSeconds(patch.editorAutosaveSeconds),
    });
  }

  return withTransaction((tx) => {
    const now = nowMs();
    for (const entry of entries) {
      tx.db
        .prepare(
          `INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(userId, entry.key, JSON.stringify(entry.value), now);
    }
    return readPreferences(tx.db, userId);
  }, db);
}

/** 只读（不进入写事务）。 */
export function getUserPreferences(ctx: CallerContext, db: SqliteDatabase = getDb()): UserPreferences {
  const userId = ctx.userId;
  if (!userId) throw err.unauthenticated();
  return withRead((conn) => readPreferences(conn, userId), db);
}
