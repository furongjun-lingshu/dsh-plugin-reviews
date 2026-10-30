/**
 * 每用户偏好（迁移 0030）：默认值、写读、白名单、按用户隔离。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertUser, type TestDb } from './support/db';
import {
  DEFAULT_PREFERENCES,
  getUserPreferences,
  readPreferences,
  writePreferences,
} from '../src/server/modules/preferences';
import type { CallerContext } from '@/server/platform/context';
import { ErrorCodes, isDomainError } from '../src/packages/common/errors';

let ctx: TestDb | null = null;
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

function caller(db: TestDb['db'], userId: string | null): CallerContext {
  if (userId === null) return { userId: null, role: 'user', accountStatus: 'active' };
  const row = db.prepare('SELECT role, account_status FROM users WHERE id = ?').get(userId) as {
    role: 'user' | 'admin';
    account_status: 'active' | 'disabled';
  };
  return { userId, role: row.role, accountStatus: row.account_status };
}

describe('用户偏好', () => {
  it('没有设置过时返回默认值（停笔 5 秒）', () => {
    ctx = createTestDb();
    const db = ctx.db;
    const user = insertUser(db);
    expect(readPreferences(db, user)).toEqual(DEFAULT_PREFERENCES);
    expect(DEFAULT_PREFERENCES.editorAutosaveSeconds).toBe(5);
  });

  it('写入后读回同一值；只影响自己', () => {
    ctx = createTestDb();
    const db = ctx.db;
    const a = insertUser(db);
    const b = insertUser(db);

    const saved = writePreferences(caller(db, a), { editorAutosaveSeconds: 30 }, db);
    expect(saved.editorAutosaveSeconds).toBe(30);
    expect(getUserPreferences(caller(db, a), db).editorAutosaveSeconds).toBe(30);
    // 另一个用户仍是默认值
    expect(getUserPreferences(caller(db, b), db).editorAutosaveSeconds).toBe(5);
  });

  it('允许关闭自动保存（0），并原样读回', () => {
    ctx = createTestDb();
    const db = ctx.db;
    const user = insertUser(db);
    writePreferences(caller(db, user), { editorAutosaveSeconds: 0 }, db);
    expect(getUserPreferences(caller(db, user), db).editorAutosaveSeconds).toBe(0);
  });

  it('白名单外的取值被拒绝，且不落库', () => {
    ctx = createTestDb();
    const db = ctx.db;
    const user = insertUser(db);
    for (const bad of [7, -1, 3600, 2.5]) {
      try {
        writePreferences(caller(db, user), { editorAutosaveSeconds: bad as number }, db);
        throw new Error('应当被拒绝');
      } catch (e) {
        expect(isDomainError(e)).toBe(true);
        if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.INPUT_INVALID);
      }
    }
    expect(readPreferences(db, user).editorAutosaveSeconds).toBe(5);
  });

  it('未登录读写都被拒（401），不写一行空用户偏好', () => {
    ctx = createTestDb();
    const db = ctx.db;
    for (const run of [
      () => getUserPreferences(caller(db, null), db),
      () => writePreferences(caller(db, null), { editorAutosaveSeconds: 10 }, db),
    ]) {
      try {
        run();
        throw new Error('应当被拒绝');
      } catch (e) {
        expect(isDomainError(e)).toBe(true);
        if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.UNAUTHENTICATED);
      }
    }
    const count = db.prepare('SELECT COUNT(*) AS c FROM user_preferences').get() as { c: number };
    expect(count.c).toBe(0);
  });
});
