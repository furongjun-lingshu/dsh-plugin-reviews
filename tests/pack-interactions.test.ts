/**
 * 整合包互动：有帮助、举报（pack_release）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertPlugin, insertRepository, insertUser, type TestDb } from './support/db';
import { createPacksService } from '../src/server/modules/packs';
import { createInteractionsService } from '../src/server/modules/interactions';
import { resolveVisibilityInTx } from '../src/server/modules/content';
import type { CallerContext } from '../src/server/platform/context';
import type { VersionValue } from '@/packages/common/field-rules';
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

const V: VersionValue = { kind: 'known', value: '1.0.0' };

async function makePublished(
  db: TestDb['db'],
  author: string,
): Promise<{ packId: string; releaseId: string }> {
  const repo = insertRepository(db);
  const plugin = insertPlugin(db, repo, '.');
  return createPacksService({ db }).createPackWithFirstRelease(
    caller(db, author),
    {
      title: '包',
      purpose: '用途',
      bodyMarkdown: '说明',
      dshVersion: V,
      configTemplate: null,
      testStatus: 'untested',
      testTask: null,
      testResult: null,
      items: [{ pluginId: plugin, pluginVersion: V, installTarget: null }],
    },
    db,
  );
}

describe('整合包互动', () => {
  it('有帮助：匿名只给总数；登录切换并计数', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    const user = insertUser(db);
    const { releaseId } = await makePublished(db, author);
    const service = createPacksService({ db });

    expect(await service.helpfulStateForRelease(releaseId, null, db)).toEqual({ helpful: false, count: 0 });
    expect(await service.toggleHelpfulForRelease(caller(db, user), releaseId, db)).toEqual({
      helpful: true,
      count: 1,
    });
    expect(await service.helpfulStateForRelease(releaseId, user, db)).toEqual({ helpful: true, count: 1 });
    expect(await service.toggleHelpfulForRelease(caller(db, user), releaseId, db)).toEqual({
      helpful: false,
      count: 0,
    });
  });

  it('举报：已发布版本可举报；未发布草稿拒绝', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db);
    const user = insertUser(db);
    const published = await makePublished(db, author);
    const interactions = createInteractionsService({ db });

    const report = await interactions.createReport(
      caller(db, user),
      { targetKind: 'pack_release', targetId: published.releaseId, reason: 'spam' },
      db,
    );
    expect(report.created).toBe(true);

    // 草稿版本不可举报
    const packs = createPacksService({ db });
    const draft = await packs.createPackDraft(
      caller(db, author),
      {
        title: '草稿',
        purpose: '用途',
        bodyMarkdown: '说明',
        dshVersion: V,
        configTemplate: null,
        testStatus: 'untested',
        testTask: null,
        testResult: null,
        items: [{ pluginId: insertPlugin(db, insertRepository(db), '.'), pluginVersion: V, installTarget: null }],
      },
      db,
    );
    try {
      await interactions.createReport(
        caller(db, user),
        { targetKind: 'pack_release', targetId: draft.releaseId, reason: 'spam' },
        db,
      );
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.TARGET_UNAVAILABLE);
    }
  });

  it('举报隐藏：pack_release 落 content_entities，版本不再公开，举报人与作者都收到通知', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const author = insertUser(db, { nickname: '作者' });
    const reporter = insertUser(db, { nickname: '举报人' });
    const admin = insertUser(db, { role: 'admin', nickname: '管理员' });
    const { packId, releaseId } = await makePublished(db, author);
    const interactions = createInteractionsService({ db });
    const packs = createPacksService({ db });

    expect((await packs.listPublicPacks({}, db)).total).toBe(1);

    const report = await interactions.createReport(
      caller(db, reporter),
      { targetKind: 'pack_release', targetId: releaseId, reason: 'abuse', detail: '版本里带了可疑脚本' },
      db,
    );

    const handled = await interactions.handleReport(
      caller(db, admin),
      report.reportId,
      { action: 'hide', reason: '版本内含可疑脚本' },
      db,
    );
    expect(handled).toEqual({ reportId: report.reportId, state: 'resolved', action: 'hide', notified: 2 });

    // 1) 三件套落到 content_entities —— pack_release 的 content_entity 就是版本本身
    expect(resolveVisibilityInTx(db, releaseId)).toMatchObject({
      hidden: true,
      withdrawn: false,
      publiclyVisible: false,
    });
    const row = db
      .prepare(
        `SELECT hidden_at, hidden_by, hidden_reason, visibility_control_version
           FROM content_entities WHERE id = ?`,
      )
      .get(releaseId) as {
      hidden_at: number | null;
      hidden_by: string | null;
      hidden_reason: string | null;
      visibility_control_version: number;
    };
    expect(row.hidden_at).not.toBeNull();
    expect(row.hidden_by).toBe(admin);
    expect(row.hidden_reason).toContain('版本内含可疑脚本');
    expect(row.visibility_control_version).toBe(1);

    // 2) 公开列表不再返回该包（隐藏而非删除：包与版本行仍在）
    const list = await packs.listPublicPacks({}, db);
    expect(list.total).toBe(0);
    expect(list.items).toHaveLength(0);
    expect(db.prepare('SELECT 1 AS x FROM plugin_packs WHERE id = ?').get(packId)).toBeDefined();

    // 3) 举报人收到处理结果、作者收到隐藏通知（两条 moderation_result）
    const notesOf = (userId: string) =>
      db
        .prepare(
          `SELECT kind, detail, content_entity_id FROM notifications
            WHERE recipient_id = ? ORDER BY created_at ASC, id ASC`,
        )
        .all(userId) as Array<{ kind: string; detail: string; content_entity_id: string }>;

    const reporterNotes = notesOf(reporter);
    expect(reporterNotes).toHaveLength(1);
    expect(reporterNotes[0].kind).toBe('moderation_result');
    expect(reporterNotes[0].content_entity_id).toBe(releaseId);
    expect(reporterNotes[0].detail).toBe('你的举报已处理：整合包版本已隐藏。原因：版本内含可疑脚本');

    const authorNotes = notesOf(author);
    expect(authorNotes).toHaveLength(1);
    expect(authorNotes[0].kind).toBe('moderation_result');
    expect(authorNotes[0].content_entity_id).toBe(releaseId);
    expect(authorNotes[0].detail).toContain('你发布的整合包版本已被管理员隐藏');
  });
});
