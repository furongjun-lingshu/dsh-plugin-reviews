/**
 * 草稿 → 插件 绑定（草稿页「选择所对应的插件」）：可绑定、可更换、越权与非法输入被拒。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertPlugin, insertRepository, insertUser, type TestDb } from './support/db';
import { reviewsService } from '../src/server/modules/reviews';
import type { CallerContext } from '@/server/platform/context';
import { ErrorCodes, isDomainError } from '../src/packages/common/errors';

let ctx: TestDb | null = null;
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

function caller(db: TestDb['db'], userId: string): CallerContext {
  const row = db.prepare('SELECT role, account_status FROM users WHERE id = ?').get(userId) as {
    role: 'user' | 'admin';
    account_status: 'active' | 'disabled';
  };
  return { userId, role: row.role, accountStatus: row.account_status };
}

describe('草稿绑定插件', () => {
  it('未绑定的草稿可以就地选插件；返回展示名，读回也带上', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    const repoId = insertRepository(db);
    const pluginId = insertPlugin(db, repoId, '.');

    const draft = await reviewsService.createOrGetDraft(
      caller(db, author),
      { pluginId: null, requestKey: 'create-1' },
      db,
    );
    const before = await reviewsService.getDraft(caller(db, author), draft.draftId, db);
    expect(before.pluginId).toBeNull();
    expect(before.pluginLabel).toBeNull();

    const bound = await reviewsService.setDraftPlugin(caller(db, author), {
      draftId: draft.draftId,
      pluginId,
    }, db);
    expect(bound.pluginId).toBe(pluginId);
    // 展示名 = 仓库全名（没有清单名时）
    expect(bound.pluginLabel).toContain('/');

    const after = await reviewsService.getDraft(caller(db, author), draft.draftId, db);
    expect(after.pluginId).toBe(pluginId);
    expect(after.pluginLabel).toBe(bound.pluginLabel);
    // 权威位置是 reviews.plugin_id
    const row = db.prepare('SELECT plugin_id FROM reviews WHERE id = ?').get(draft.reviewId) as {
      plugin_id: string;
    };
    expect(row.plugin_id).toBe(pluginId);
  });

  it('可以更换成另一个插件', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    const first = insertPlugin(db, insertRepository(db), '.');
    const second = insertPlugin(db, insertRepository(db), '.');

    const draft = await reviewsService.createOrGetDraft(
      caller(db, author),
      { pluginId: first, requestKey: 'create-2' },
      db,
    );
    await reviewsService.setDraftPlugin(caller(db, author), { draftId: draft.draftId, pluginId: second }, db);
    const view = await reviewsService.getDraft(caller(db, author), draft.draftId, db);
    expect(view.pluginId).toBe(second);

    // 草稿正文/保存版本不受影响
    expect(view.saveVersion).toBe(0);
  });

  it('非作者不能改绑；未知插件明确拒绝', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    const other = insertUser(db);
    const pluginId = insertPlugin(db, insertRepository(db), '.');
    const draft = await reviewsService.createOrGetDraft(
      caller(db, author),
      { pluginId: null, requestKey: 'create-3' },
      db,
    );

    try {
      await reviewsService.setDraftPlugin(caller(db, other), { draftId: draft.draftId, pluginId }, db);
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.FORBIDDEN);
    }

    try {
      await reviewsService.setDraftPlugin(
        caller(db, author),
        { draftId: draft.draftId, pluginId: '00000000-0000-7000-8000-000000000000' },
        db,
      );
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.INPUT_INVALID);
    }
  });

  it('已提交（软删除）的草稿不能再改绑：改的是历史对应的文章', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    const pluginId = insertPlugin(db, insertRepository(db), '.');
    const draft = await reviewsService.createOrGetDraft(
      caller(db, author),
      { pluginId: null, requestKey: 'create-4' },
      db,
    );
    db.prepare('UPDATE content_drafts SET deleted_at = ? WHERE id = ?').run(Date.now(), draft.draftId);

    try {
      await reviewsService.setDraftPlugin(caller(db, author), { draftId: draft.draftId, pluginId }, db);
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.TARGET_UNAVAILABLE);
    }
  });
});
