/**
 * 评测草稿测试（工作包 GC）。
 *
 * 纪律：每个用例都必须能在实现被破坏时变红。文件内的关键对应关系：
 *  - 「过期版本保存被拒且不覆盖」→ 删掉 saveDraft 里的 `AND save_version = ?` 必然变红；
 *  - 「同键重放不递增版本」→ 把回执查询挪到 CAS 之后、或删掉回执分支，必然变红；
 *  - 「同键不同内容」→ 把摘要比较去掉，必然变红；
 *  - 「一篇评测只有一份草稿」→ 去掉复用分支，必然变红。
 *
 * 所有用例使用**真实临时文件数据库 + 真实迁移**，不用 :memory: 冒充。
 * 服务方法第三参数是平台层的连接注入点（`withRead/withTransaction` 的最后一个参数），
 * 测试用它把自己的临时库传进去，避免连到应用单例库。
 */

import { describe, expect, it, afterEach } from 'vitest';
import {
  createTestDb,
  insertPlugin,
  insertRepository,
  insertReview,
  insertReviewRevision,
  insertUser,
  type TestDb,
} from './support/db';
import { reviewsService, type DraftPayload } from '../src/server/modules/reviews';
import type { CallerContext } from '../src/server/platform/context';
import { ErrorCodes, isDomainError } from '../src/packages/common/errors';
import { newId } from '../src/server/platform/id';

let ctx: TestDb | null = null;

afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

function setup(): TestDb {
  ctx = createTestDb();
  return ctx;
}

/** 断言拒绝的是**具体错误码**，而不是宽泛的“有抛错就行”。 */
async function expectCode(promise: Promise<unknown>, code: string): Promise<Error> {
  try {
    await promise;
  } catch (e) {
    if (!isDomainError(e)) {
      throw new Error(`预期 DomainError(${code})，实际是 ${(e as Error).name}: ${(e as Error).message}`);
    }
    expect(e.code, `实际错误码 ${e.code} / ${e.message}`).toBe(code);
    return e;
  }
  throw new Error(`预期抛出 ${code}，但调用成功了`);
}

function payload(overrides: Partial<DraftPayload> = {}): DraftPayload {
  return {
    title: '一篇评测',
    pluginId: null,
    pluginVersion: { kind: 'unknown' },
    dshVersion: { kind: 'unknown' },
    body: [{ key: 'k1', markdown: '正文' }],
    ...overrides,
  };
}

function caller(
  userId: string,
  role: 'user' | 'admin' = 'user',
  accountStatus: 'active' | 'disabled' = 'active',
): CallerContext {
  return { userId, role, accountStatus };
}

function draftRow(db: TestDb['db'], draftId: string): { save_version: number; payload: string } {
  return db.prepare('SELECT save_version, payload FROM content_drafts WHERE id = ?').get(draftId) as {
    save_version: number;
    payload: string;
  };
}

describe('createOrGetDraft：一篇评测只有一份当前草稿', () => {
  it('首次创建：草稿与评测在同一事务内配对建立，save_version 从 0 开始', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);

    const created = await reviewsService.createOrGetDraft(caller(author), { pluginId: plugin, requestKey: 'create-1' }, db);

    expect(created.saveVersion).toBe(0);
    expect(created.draftId).not.toBe(created.reviewId);

    // 真实落库校验：公共实体与具体子表互指（延迟外键在 commit 时验证）
    const entity = db
      .prepare('SELECT content_type, author_id, review_id FROM content_entities WHERE id = ?')
      .get(created.reviewId) as { content_type: string; author_id: string; review_id: string };
    expect(entity.content_type).toBe('review');
    expect(entity.author_id).toBe(author);
    expect(entity.review_id).toBe(created.reviewId);

    const review = db.prepare('SELECT plugin_id FROM reviews WHERE id = ?').get(created.reviewId) as {
      plugin_id: string | null;
    };
    expect(review.plugin_id).toBe(plugin);

    const draft = db
      .prepare('SELECT owner_id, draft_type, review_id, save_version, payload FROM content_drafts WHERE id = ?')
      .get(created.draftId) as {
      owner_id: string;
      draft_type: string;
      review_id: string;
      save_version: number;
      payload: string;
    };
    expect(draft.owner_id).toBe(author);
    expect(draft.draft_type).toBe('review');
    expect(draft.review_id).toBe(created.reviewId);
    expect(draft.save_version).toBe(0);
    // 草稿载荷必须是结构完整的 JSON（缺字段表达“沿用旧值”是被禁止的）
    expect(JSON.parse(draft.payload)).toEqual({
      title: '',
      pluginId: plugin,
      pluginVersion: { kind: 'unknown' },
      dshVersion: { kind: 'unknown' },
      body: [],
      // v2 载荷：五状态判定与证据链（dsh-bench 规范）
      verdict: null,
      evidence: [],
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('重复调用复用同一草稿与同一评测行（不会制造第二篇）', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);

    const first = await reviewsService.createOrGetDraft(caller(author), { pluginId: plugin, requestKey: 'k1' }, db);
    const second = await reviewsService.createOrGetDraft(caller(author), { pluginId: plugin, requestKey: 'k1' }, db);
    const third = await reviewsService.createOrGetDraft(caller(author), { pluginId: plugin, requestKey: 'k2' }, db);

    expect(second).toEqual(first);
    expect(third.draftId).toBe(first.draftId);
    expect(third.reviewId).toBe(first.reviewId);

    const draftCount = (
      db
        .prepare("SELECT count(*) AS c FROM content_drafts WHERE draft_type = 'review' AND owner_id = ?")
        .get(author) as { c: number }
    ).c;
    const reviewCount = (
      db.prepare('SELECT count(*) AS c FROM reviews WHERE id = ?').get(first.reviewId) as { c: number }
    ).c;
    // ★ 去掉复用分支后每次调用都会新建草稿 → draftCount 变成 2/3 → 变红
    expect(draftCount).toBe(1);
    expect(reviewCount).toBe(1);
  });

  it('未登录、账户禁用、插件不存在分别被明确拒绝，且不留下半截行', async () => {
    const { db } = setup();
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    const author = insertUser(db);
    const disabled = insertUser(db, { accountStatus: 'disabled' });

    await expectCode(
      reviewsService.createOrGetDraft({ userId: null, role: null, accountStatus: null }, { pluginId: plugin, requestKey: 'x' }, db),
      ErrorCodes.UNAUTHENTICATED,
    );
    await expectCode(
      reviewsService.createOrGetDraft(caller(disabled, 'user', 'disabled'), { pluginId: plugin, requestKey: 'x' }, db),
      ErrorCodes.ACCOUNT_DISABLED,
    );
    await expectCode(
      reviewsService.createOrGetDraft(caller(author), { pluginId: newId(), requestKey: 'x' }, db),
      ErrorCodes.INPUT_INVALID,
    );
    await expectCode(
      reviewsService.createOrGetDraft(caller(author), { pluginId: plugin, requestKey: '   ' }, db),
      ErrorCodes.INPUT_INVALID,
    );

    // 失败路径绝不能落库
    expect(
      (db.prepare("SELECT count(*) AS c FROM content_drafts WHERE draft_type = 'review'").get() as { c: number }).c,
    ).toBe(0);
    expect((db.prepare('SELECT count(*) AS c FROM content_entities').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT count(*) AS c FROM reviews').get() as { c: number }).c).toBe(0);
  });
});

describe('saveDraft：原子版本推进', () => {
  it('成功保存：save_version 恰好 +1，payload 真的写进去了', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    const created = await reviewsService.createOrGetDraft(caller(author), { pluginId: plugin, requestKey: 'c' }, db);

    const saved = await reviewsService.saveDraft(
      caller(author),
      { draftId: created.draftId, expectedVersion: 0, requestKey: 'save-1', payload: payload({ title: '第一版' }) },
      db,
    );

    expect(saved.replayed).toBe(false);
    expect(saved.saveVersion).toBe(1);

    const row = draftRow(db, created.draftId);
    expect(row.save_version).toBe(1);
    expect((JSON.parse(row.payload) as DraftPayload).title).toBe('第一版');
  });

  it('过期版本保存被拒（version_conflict），且原 payload 与 save_version 均未被覆盖', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    const created = await reviewsService.createOrGetDraft(caller(author), { pluginId: plugin, requestKey: 'c' }, db);

    // 先成功保存一次，版本变成 1
    await reviewsService.saveDraft(
      caller(author),
      {
        draftId: created.draftId,
        expectedVersion: 0,
        requestKey: 'save-1',
        payload: payload({ title: '已落库的第一版' }),
      },
      db,
    );

    // 再用仍然过期的 expectedVersion=0 保存：必须抛 version_conflict
    await expectCode(
      reviewsService.saveDraft(
        caller(author),
        {
          draftId: created.draftId,
          expectedVersion: 0,
          requestKey: 'save-2',
          payload: payload({ title: '不该被写入的第二版' }),
        },
        db,
      ),
      ErrorCodes.VERSION_CONFLICT,
    );

    const row = draftRow(db, created.draftId);
    // ★ 这条断言就是「把 WHERE 的 save_version 条件去掉 → 本用例失败」的哨兵：
    //   去掉条件后 UPDATE 影响 1 行，save_version 会变成 2、payload 被覆盖成“不该被写入的第二版”。
    expect(row.save_version).toBe(1);
    expect((JSON.parse(row.payload) as DraftPayload).title).toBe('已落库的第一版');

    // 冲突请求不得写下回执（否则重试会拿到假回执）
    const receipts = (
      db
        .prepare('SELECT count(*) AS c FROM draft_save_receipts WHERE draft_id = ? AND request_key = ?')
        .get(created.draftId, 'save-2') as { c: number }
    ).c;
    expect(receipts).toBe(0);
  });

  it('连续推进：每次都用最新版本才能成功，跳版本失败', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const created = await reviewsService.createOrGetDraft(caller(author), { pluginId: null, requestKey: 'c' }, db);

    for (let version = 0; version < 3; version += 1) {
      const saved = await reviewsService.saveDraft(
        caller(author),
        {
          draftId: created.draftId,
          expectedVersion: version,
          requestKey: `save-${version}`,
          payload: payload({ title: `第 ${version + 1} 版` }),
        },
        db,
      );
      expect(saved.saveVersion).toBe(version + 1);
    }

    // 跳版本（当前 3，却声称 1）
    await expectCode(
      reviewsService.saveDraft(
        caller(author),
        { draftId: created.draftId, expectedVersion: 1, requestKey: 'save-bad', payload: payload({ title: '跳版本' }) },
        db,
      ),
      ErrorCodes.VERSION_CONFLICT,
    );

    const row = draftRow(db, created.draftId);
    expect(row.save_version).toBe(3);
    expect((JSON.parse(row.payload) as DraftPayload).title).toBe('第 3 版');
  });

  it('只有草稿所有者能保存；他人保存被拒且不影响数据', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const other = insertUser(db);
    const created = await reviewsService.createOrGetDraft(caller(author), { pluginId: null, requestKey: 'c' }, db);

    await expectCode(
      reviewsService.saveDraft(
        caller(other),
        { draftId: created.draftId, expectedVersion: 0, requestKey: 'steal', payload: payload({ title: '越权写入' }) },
        db,
      ),
      ErrorCodes.FORBIDDEN,
    );

    const row = draftRow(db, created.draftId);
    expect(row.save_version).toBe(0);
    expect((JSON.parse(row.payload) as DraftPayload).title).toBe('');
  });
});

describe('saveDraft：请求去重（draft_save_receipts）', () => {
  it('同键同内容重放：返回原回执、replayed=true、save_version 不递增', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const created = await reviewsService.createOrGetDraft(caller(author), { pluginId: null, requestKey: 'c' }, db);
    const body = payload({ title: '重放用' });

    const first = await reviewsService.saveDraft(
      caller(author),
      { draftId: created.draftId, expectedVersion: 0, requestKey: 'same-key', payload: body },
      db,
    );
    expect(first.replayed).toBe(false);
    expect(first.saveVersion).toBe(1);

    // ★ 关键：重放时故意带**过期**的 expectedVersion。
    //   正确的实现必须把「同键重放」判定放在 CAS 之前，否则这里会抛 version_conflict。
    const replay = await reviewsService.saveDraft(
      caller(author),
      { draftId: created.draftId, expectedVersion: 0, requestKey: 'same-key', payload: body },
      db,
    );

    expect(replay.replayed).toBe(true);
    expect(replay.saveVersion).toBe(first.saveVersion);
    expect(replay.savedAt).toBe(first.savedAt);

    // 不递增：库里仍是 1，回执表只有一行
    expect(draftRow(db, created.draftId).save_version).toBe(1);
    const receiptCount = (
      db.prepare('SELECT count(*) AS c FROM draft_save_receipts WHERE draft_id = ?').get(created.draftId) as { c: number }
    ).c;
    expect(receiptCount).toBe(1);
  });

  it('同键不同内容：抛 request_key_reused，且不覆盖已保存内容', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const created = await reviewsService.createOrGetDraft(caller(author), { pluginId: null, requestKey: 'c' }, db);

    await reviewsService.saveDraft(
      caller(author),
      { draftId: created.draftId, expectedVersion: 0, requestKey: 'reuse-key', payload: payload({ title: '原来的标题' }) },
      db,
    );

    await expectCode(
      reviewsService.saveDraft(
        caller(author),
        {
          draftId: created.draftId,
          expectedVersion: 1,
          requestKey: 'reuse-key',
          payload: payload({ title: '换了内容的标题' }),
        },
        db,
      ),
      ErrorCodes.REQUEST_KEY_REUSED,
    );

    const row = draftRow(db, created.draftId);
    expect(row.save_version).toBe(1);
    expect((JSON.parse(row.payload) as DraftPayload).title).toBe('原来的标题');
  });

  it('回执里的版本由数据库 CHECK 兜底：result_version 必须等于 expected_version + 1', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const created = await reviewsService.createOrGetDraft(caller(author), { pluginId: null, requestKey: 'c' }, db);
    await reviewsService.saveDraft(
      caller(author),
      { draftId: created.draftId, expectedVersion: 0, requestKey: 'k', payload: payload() },
      db,
    );

    // 直接写一条 result_version 与 expected_version 不匹配的回执，必须被 CHECK 拒绝
    expect(() =>
      db
        .prepare(
          `INSERT INTO draft_save_receipts (draft_id, request_key, expected_version, payload_digest, result_version, saved_at)
           VALUES (?, 'bad', 3, ?, 9, ?)`,
        )
        .run(created.draftId, 'a'.repeat(64), Date.now()),
    ).toThrow(/CHECK/i);
  });
});

describe('saveDraft：草稿结构契约（允许未完成，但不允许缺字段）', () => {
  it('允许未完成：标题空、未选插件、版本 unknown，结构完整即可保存', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const created = await reviewsService.createOrGetDraft(caller(author), { pluginId: null, requestKey: 'c' }, db);

    const saved = await reviewsService.saveDraft(
      caller(author),
      {
        draftId: created.draftId,
        expectedVersion: 0,
        requestKey: 'half-done',
        payload: { title: '', pluginId: null, pluginVersion: { kind: 'unknown' }, dshVersion: { kind: 'unknown' }, body: [] },
      },
      db,
    );
    expect(saved.saveVersion).toBe(1);
  });

  it('缺字段被拒（不允许用缺字段静默表达“沿用旧值”），且不推进版本', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const created = await reviewsService.createOrGetDraft(caller(author), { pluginId: null, requestKey: 'c' }, db);

    const incomplete = { title: '只有标题' } as unknown as DraftPayload;
    await expectCode(
      reviewsService.saveDraft(
        caller(author),
        { draftId: created.draftId, expectedVersion: 0, requestKey: 'incomplete', payload: incomplete },
        db,
      ),
      ErrorCodes.INPUT_INVALID,
    );

    expect(draftRow(db, created.draftId).save_version).toBe(0);
  });

  it('版本结构不合法被拒：known 但没有 value', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const created = await reviewsService.createOrGetDraft(caller(author), { pluginId: null, requestKey: 'c' }, db);

    await expectCode(
      reviewsService.saveDraft(
        caller(author),
        {
          draftId: created.draftId,
          expectedVersion: 0,
          requestKey: 'bad-version',
          payload: payload({ pluginVersion: { kind: 'known', value: '   ' } }),
        },
        db,
      ),
      ErrorCodes.INPUT_INVALID,
    );
    expect(draftRow(db, created.draftId).save_version).toBe(0);
  });

  it('失败的保存不写回执：修好结构后用同一 requestKey 仍可保存', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const created = await reviewsService.createOrGetDraft(caller(author), { pluginId: null, requestKey: 'c' }, db);

    await expectCode(
      reviewsService.saveDraft(
        caller(author),
        {
          draftId: created.draftId,
          expectedVersion: 0,
          requestKey: 'retry-key',
          payload: { title: 'x' } as unknown as DraftPayload,
        },
        db,
      ),
      ErrorCodes.INPUT_INVALID,
    );

    // 同一 requestKey 修好后再来：必须成功（失败请求没有占用这个键）
    const ok = await reviewsService.saveDraft(
      caller(author),
      { draftId: created.draftId, expectedVersion: 0, requestKey: 'retry-key', payload: payload({ title: '修好了' }) },
      db,
    );
    expect(ok.replayed).toBe(false);
    expect(ok.saveVersion).toBe(1);
  });
});

describe('getDraft / getReview：读取真实落库值', () => {
  it('getDraft 返回库里真实内容，且不泄露给他人', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    const created = await reviewsService.createOrGetDraft(caller(author), { pluginId: plugin, requestKey: 'c' }, db);

    const initial = await reviewsService.getDraft(caller(author), created.draftId, db);
    expect(initial.saveVersion).toBe(0);
    expect(initial.reviewId).toBe(created.reviewId);
    expect(initial.ownerId).toBe(author);
    expect(initial.pluginId).toBe(plugin);
    // v2：载荷增补 verdict/evidence（dsh-bench 规范）；旧载荷缺键由解析器兼容，
    // schema 版本随写入形态升级。
    expect(initial.payloadSchemaVersion).toBe(2);

    await reviewsService.saveDraft(
      caller(author),
      {
        draftId: created.draftId,
        expectedVersion: 0,
        requestKey: 's',
        payload: payload({ title: '读回来的标题', body: [{ key: 'a', markdown: '段落' }] }),
      },
      db,
    );

    const after = await reviewsService.getDraft(caller(author), created.draftId, db);
    expect(after.saveVersion).toBe(1);
    expect(after.payload.title).toBe('读回来的标题');
    expect(after.payload.body).toEqual([{ key: 'a', markdown: '段落' }]);

    const other = insertUser(db);
    await expect(reviewsService.getDraft(caller(other), created.draftId, db)).rejects.toMatchObject({
      code: ErrorCodes.FORBIDDEN,
    });
    // 不存在的草稿不能假装存在
    await expect(reviewsService.getDraft(caller(author), newId(), db)).rejects.toMatchObject({
      code: ErrorCodes.TARGET_UNAVAILABLE,
    });
  });

  it('getReview 反映公开修订与控制字段；未发布时公开修订为空', async () => {
    const { db } = setup();
    const author = insertUser(db);
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    const reviewId = insertReview(db, { authorId: author, pluginId: plugin });

    const before = await reviewsService.getReview(caller(author), reviewId, db);
    expect(before.publishedRevisionId).toBeNull();
    expect(before.publishedRevision).toBeNull();
    expect(before.withdrawnAt).toBeNull();
    expect(before.hiddenAt).toBeNull();
    expect(before.pluginId).toBe(plugin);
    expect(before.authorId).toBe(author);
    expect(before.contentType).toBe('review');

    const rev = insertReviewRevision(db, {
      reviewId,
      pluginId: plugin,
      revisionNumber: 1,
      title: '正式标题',
      body: '正式正文',
      pluginVersion: { kind: 'known', value: '1.2.0' },
      dshVersion: { kind: 'unknown' },
    });
    db.prepare('UPDATE reviews SET published_revision_id = ?, latest_submitted_revision_id = ? WHERE id = ?').run(
      rev,
      rev,
      reviewId,
    );

    const after = await reviewsService.getReview(caller(author), reviewId, db);
    expect(after.publishedRevisionId).toBe(rev);
    expect(after.publishedRevision?.title).toBe('正式标题');
    expect(after.publishedRevision?.pluginVersion).toEqual({ kind: 'known', value: '1.2.0' });
    expect(after.publishedRevision?.dshVersion).toEqual({ kind: 'unknown' });
    // 读取必须来自数据库，不是把传入 ID 原样回显
    expect(after.publishedRevision?.revisionId).toBe(rev);
  });
});
