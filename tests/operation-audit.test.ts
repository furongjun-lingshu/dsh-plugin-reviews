/**
 * 操作记录（审计）覆盖：可见性变更与整合包审核决定。
 *
 * 背景：`operation_records` 此前只被收录路径与用户管理写入，管理员"隐藏了谁的内容"
 * "通过了哪个版本"在后台查不到。本测试守住这几条新写入。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestDb,
  insertPlugin,
  insertRepository,
  insertReview,
  insertReviewRevision,
  insertUser,
  type TestDb,
} from './support/db';
import { contentService } from '../src/server/modules/content';
import { createInteractionsService } from '../src/server/modules/interactions';
import { createCatalogService } from '../src/server/modules/catalog';
import { reviewsService } from '../src/server/modules/reviews';
import { createPacksService } from '../src/server/modules/packs';
import type { CallerContext } from '@/server/platform/context';
import type { VersionValue } from '@/packages/common/field-rules';

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

function audit(db: TestDb['db'], actionType: string) {
  return db
    .prepare(
      `SELECT actor_kind, actor_user_id, target_type, target_id, reason, changes
         FROM operation_records WHERE action_type = ? ORDER BY created_at ASC`,
    )
    .all(actionType) as Array<{
    actor_kind: string;
    actor_user_id: string | null;
    target_type: string;
    target_id: string;
    reason: string;
    changes: string;
  }>;
}

const V: VersionValue = { kind: 'known', value: '1.0.0' };

describe('操作记录：可见性变更', () => {
  it('隐藏与解除隐藏都落审计，含操作人、对象与原因', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    const admin = insertUser(db, { role: 'admin' });
    const pluginId = insertPlugin(db, insertRepository(db), '.');
    const reviewId = insertReview(db, { authorId: author, pluginId });

    await contentService.hide(caller(db, admin), {
      entityId: reviewId,
      reason: '内容包含误导性结论',
      requestKey: 'hide-1',
    }, db);

    const hidden = audit(db, 'content.hide');
    expect(hidden).toHaveLength(1);
    expect(hidden[0].actor_kind).toBe('admin');
    expect(hidden[0].actor_user_id).toBe(admin);
    expect(hidden[0].target_type).toBe('content_entity');
    expect(hidden[0].target_id).toBe(reviewId);
    expect(hidden[0].reason).toBe('内容包含误导性结论');
    expect(JSON.parse(hidden[0].changes)).toEqual({ hidden: true });

    // 已隐藏再隐藏：业务拒绝，且不会多记一条
    await expect(
      contentService.hide(caller(db, admin), {
        entityId: reviewId,
        reason: '重复隐藏',
        requestKey: 'hide-2',
      }, db),
    ).rejects.toThrow();
    expect(audit(db, 'content.hide')).toHaveLength(1);

    await contentService.unhide(caller(db, admin), {
      entityId: reviewId,
      reason: '复核后确认无问题',
      requestKey: 'unhide-1',
    }, db);
    const unhidden = audit(db, 'content.unhide');
    expect(unhidden).toHaveLength(1);
    expect(unhidden[0].actor_user_id).toBe(admin);
    expect(JSON.parse(unhidden[0].changes)).toEqual({ hidden: false });
    expect(unhidden[0].reason).toBe('复核后确认无问题');
  });
});

describe('操作记录：整合包审核决定', () => {
  it('审核通过写 pack.release.approve，记录版本号', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    const admin = insertUser(db, { role: 'admin' });
    const service = createPacksService({ db });
    const draft = await service.createPackDraft(
      caller(db, author),
      {
        title: '组合包',
        purpose: '科研资料整理与检索',
        // 带外链 → 自动检查转人工，才有管理员通过这一步
        bodyMarkdown: '先安装记忆插件，详见 https://example.com/guide 的步骤说明。',
        dshVersion: V,
        configTemplate: null,
        testStatus: 'untested',
        testTask: null,
        testResult: null,
        items: [{ pluginId: insertPlugin(db, insertRepository(db), '.'), pluginVersion: V, installTarget: null }],
      },
      db,
    );
    const submitted = await service.submitReleaseForReview(caller(db, author), draft.releaseId, db);
    expect(submitted.outcome).toBe('manual');

    const approved = await service.approveRelease(caller(db, admin), draft.releaseId, db);
    expect(approved.releaseNumber).toBe(1);

    const rows = audit(db, 'pack.release.approve');
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_user_id).toBe(admin);
    expect(rows[0].target_type).toBe('pack_release');
    expect(rows[0].target_id).toBe(draft.releaseId);
    expect(JSON.parse(rows[0].changes)).toEqual({ release_number: 1 });
  });
});

describe('操作记录：作者动作与举报隐藏', () => {
  it('作者撤回写 content.withdraw（actor=user）', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    const pluginId = insertPlugin(db, insertRepository(db), '.');
    const reviewId = insertReview(db, { authorId: author, pluginId });

    await contentService.withdraw(caller(db, author), {
      reviewId,
      expectedControlVersion: 0,
      reason: '内容需要重写',
      requestKey: 'withdraw-1',
    }, db);

    const rows = audit(db, 'content.withdraw');
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_kind).toBe('user');
    expect(rows[0].actor_user_id).toBe(author);
    expect(rows[0].target_id).toBe(reviewId);
    expect(rows[0].reason).toBe('内容需要重写');
  });

  it('删除草稿写 draft.delete；批量删除逐份留痕', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    // 同一作者 + 同一插件会复用草稿（createOrGetDraft 的归属规则），所以两份草稿要绑不同插件。
    const pluginA = insertPlugin(db, insertRepository(db), '.');
    const pluginB = insertPlugin(db, insertRepository(db), '.');
    const a = await reviewsService.createOrGetDraft(caller(db, author), { pluginId: pluginA, requestKey: 'k1' }, db);
    const b = await reviewsService.createOrGetDraft(caller(db, author), { pluginId: pluginB, requestKey: 'k2' }, db);
    expect(a.draftId).not.toBe(b.draftId);

    await reviewsService.deleteDrafts(caller(db, author), [a.draftId, b.draftId], db);

    const rows = audit(db, 'draft.delete');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.target_id).sort()).toEqual([a.draftId, b.draftId].sort());
    expect(rows.every((r) => r.actor_user_id === author)).toBe(true);
  });

  it('举报隐藏写 report.hide，并带上举报 id', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    const reporter = insertUser(db);
    const admin = insertUser(db, { role: 'admin' });
    const pluginId = insertPlugin(db, insertRepository(db), '.');
    const reviewId = insertReview(db, { authorId: author, pluginId });
    // 举报要求目标「当前公开」：先给评测一个公开修订。
    const revisionId = insertReviewRevision(db, { reviewId, pluginId, revisionNumber: 1 });
    db.prepare('UPDATE reviews SET published_revision_id = ? WHERE id = ?').run(revisionId, reviewId);

    const interactions = createInteractionsService({ db });
    const report = await interactions.createReport(caller(db, reporter), {
      targetKind: 'review',
      targetId: reviewId,
      reason: 'abuse',
      detail: '含攻击性内容',
    });
    await interactions.handleReport(
      caller(db, admin),
      report.reportId,
      { action: 'hide', reason: '确认违规' },
      db,
    );

    const rows = audit(db, 'report.hide');
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_user_id).toBe(admin);
    expect(rows[0].target_id).toBe(reviewId);
    expect(JSON.parse(rows[0].changes)).toMatchObject({ report_id: report.reportId, hidden: true });
  });

  it('分类维护写 category.upsert / category.delete', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const admin = insertUser(db, { role: 'admin' });
    const catalog = createCatalogService({ db });

    await catalog.upsertCategory(caller(db, admin), {
      slug: 'memory',
      label: '记忆增强',
      topics: ['memory'],
      sortOrder: 1,
      isVisible: true,
    });
    const upserts = audit(db, 'category.upsert');
    expect(upserts).toHaveLength(1);
    expect(upserts[0].target_id).toBe('memory');
    expect(JSON.parse(upserts[0].changes)).toMatchObject({ label: '记忆增强' });

    await catalog.deleteCategory(caller(db, admin), 'memory');
    const deletes = audit(db, 'category.delete');
    expect(deletes).toHaveLength(1);
    expect(JSON.parse(deletes[0].changes)).toEqual({ deleted: true });
  });
});
