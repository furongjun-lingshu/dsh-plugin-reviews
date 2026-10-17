/**
 * 五状态判定与证据链（dsh-bench 测评规范 v3.0）。
 *
 * 纪律：每个用例都必须能在实现被破坏时变红。关键对应关系：
 *  - 「无判定提交被拒」→ 去掉 submitReview 里的 parseVerdict 必填判断，必然变红；
 *  - 「有结论的判定必须带证据」→ 去掉 parseEvidenceRefs 的 required 分支，必然变红；
 *  - 「判定与证据落进修订快照」→ 从 INSERT 里去掉 verdict/evidence_refs 两列，必然变红；
 *  - 「旧载荷（v1）解析不炸」→ 去掉 parseDraftPayload 的缺键兼容分支，必然变红。
 *
 * 所有集成用例使用**真实临时文件数据库 + 真实迁移**，不用 :memory: 冒充。
 */

import { describe, expect, it, afterEach } from 'vitest';
import {
  createTestDb,
  insertPlugin,
  insertRepository,
  insertReview,
  insertUser,
  type TestDb,
} from './support/db';
import {
  EVIDENCE_MAX_ITEMS,
  VERDICTS,
  isVerdictKey,
  parseEvidenceRefs,
  parseVerdict,
  verdictLabel,
} from '../src/packages/common/verdict';
import { parseDraftPayload } from '../src/server/modules/reviews';
import { submitReview } from '../src/server/workflows/submit-review';
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

/** 造 用户 + 仓库 + 插件 + 评测文章 + 已保存草稿（save_version=1）。 */
function makeReviewDraft(db: TestDb['db']): { authorId: string; reviewId: string; pluginId: string; draftId: string } {
  const authorId = insertUser(db);
  const repositoryId = insertRepository(db);
  const pluginId = insertPlugin(db, repositoryId);
  const reviewId = insertReview(db, { authorId, pluginId });
  const now = Date.now();
  const draftId = newId();
  db.prepare(
    `INSERT INTO content_drafts (id, owner_id, draft_type, review_id, payload, save_version, created_at, saved_at)
     VALUES (?, ?, 'review', ?, ?, 1, ?, ?)`,
  ).run(
    draftId,
    authorId,
    reviewId,
    JSON.stringify({ title: '标题', pluginVersion: { kind: 'unknown' }, dshVersion: { kind: 'unknown' }, pluginId, body: [] }),
    now,
    now,
  );
  return { authorId, reviewId, pluginId, draftId };
}

const GOOD_BODY = '这是一篇关于 DSH 插件的实测评测正文，包含安装步骤、实际表现与结论，长度足够通过基础筛查。';

function submitWith(
  db: TestDb['db'],
  fixture: { authorId: string; draftId: string },
  overrides: Record<string, unknown> = {},
) {
  const authorCtx: CallerContext = { userId: fixture.authorId, role: 'user', accountStatus: 'active' };
  return submitReview(
    authorCtx,
    {
      draftId: fixture.draftId,
      expectedSaveVersion: 1,
      requestKey: `req-${newId()}`,
      publishIntent: 'publish',
      title: '一篇实测评测',
      bodyMarkdown: GOOD_BODY,
      pluginVersion: { kind: 'unknown' },
      dshVersion: { kind: 'unknown' },
      ...overrides,
    },
    db,
  );
}

describe('五状态闭集', () => {
  it('恰好五个状态，标签与规范一致，顺序稳定', () => {
    expect(VERDICTS.map((v) => v.label)).toEqual(['真有用', '帮倒忙', '没啥差别', '还说不准', '没法测']);
    expect(VERDICTS.filter((v) => v.conclusive).map((v) => v.key)).toEqual(['helpful', 'harmful', 'no-difference']);
  });

  it('isVerdictKey 只认五个键（大小写与中文标签都不算）', () => {
    expect(isVerdictKey('helpful')).toBe(true);
    expect(isVerdictKey('HELPFUL')).toBe(false);
    expect(isVerdictKey('真有用')).toBe(false);
    expect(isVerdictKey(null)).toBe(false);
    expect(verdictLabel('nope')).toBeNull();
    expect(verdictLabel('harmful')).toBe('帮倒忙');
  });

  it('parseVerdict：缺失/空串/未知值都按 input_invalid 拒绝，并带上字段路径', () => {
    for (const bad of [undefined, null, '', 'great', 1]) {
      try {
        parseVerdict(bad);
        throw new Error('应当拒绝：' + String(bad));
      } catch (e) {
        expect(isDomainError(e)).toBe(true);
        if (isDomainError(e)) {
          expect(e.code).toBe(ErrorCodes.INPUT_INVALID);
          expect(e.fields?.[0]?.path).toBe('verdict');
        }
      }
    }
    expect(parseVerdict('untestable')).toBe('untestable');
  });
});

describe('证据链校验', () => {
  it('接受合规条目并裁剪空白；note 为空串归一为 null', () => {
    const out = parseEvidenceRefs(
      [
        { url: ' https://github.com/a/b/compare/x...y ', note: ' A/B 读数 ' },
        { url: 'http://example.com/log', note: '' },
      ],
      { required: true },
    );
    expect(out).toEqual([
      { url: 'https://github.com/a/b/compare/x...y', note: 'A/B 读数' },
      { url: 'http://example.com/log', note: null },
    ]);
  });

  it('拒绝：空串、非 http(s)、含空白、超长、非法结构、超上限', () => {
    const cases: unknown[] = [
      [{ url: '' }],
      [{ url: 'example.com' }],
      [{ url: 'ftp://example.com/x' }],
      [{ url: 'https://example.com/a b' }],
      [{ url: 'https://e.com/' + 'x'.repeat(600) }],
      [{ note: '缺 url' }],
      [null],
      'not-an-array',
      Array.from({ length: EVIDENCE_MAX_ITEMS + 1 }, (_, i) => ({ url: 'https://e.com/' + i })),
    ];
    for (const raw of cases) {
      try {
        parseEvidenceRefs(raw, { required: false });
        throw new Error('应当拒绝：' + JSON.stringify(raw));
      } catch (e) {
        expect(isDomainError(e)).toBe(true);
        if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.INPUT_INVALID);
      }
    }
  });

  it('required 只对有结论的判定生效：还说不准/没法测可以没有证据', () => {
    expect(parseEvidenceRefs([], { required: false })).toEqual([]);
    try {
      parseEvidenceRefs([], { required: true });
      throw new Error('应当拒绝空证据（有结论的判定）');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.INPUT_INVALID);
    }
  });
});

describe('草稿载荷 v1 兼容', () => {
  it('旧载荷（无 verdict/evidence）解析为「未给出」，不报错', () => {
    const parsed = parseDraftPayload({
      title: '旧评测',
      pluginId: null,
      pluginVersion: { kind: 'unknown' },
      dshVersion: { kind: 'unknown' },
      body: [],
    });
    expect(parsed.verdict).toBeNull();
    expect(parsed.evidence).toEqual([]);
  });

  it('新载荷的非法判定被拒绝（fail-closed）', () => {
    expect(() =>
      parseDraftPayload({
        title: 't',
        pluginId: null,
        pluginVersion: { kind: 'unknown' },
        dshVersion: { kind: 'unknown' },
        body: [],
        verdict: 'great',
        evidence: [],
      }),
    ).toThrow();
  });
});

describe('提交链路（真实临时库）', () => {
  it('无判定的 publish 提交被拒（input_invalid），不产生修订快照', async () => {
    const { db } = setup();
    const fixture = makeReviewDraft(db);
    try {
      await submitWith(db, fixture, { verdict: null });
      throw new Error('应当拒绝无判定的提交');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.INPUT_INVALID);
    }
    const count = db.prepare('SELECT COUNT(*) AS n FROM review_revisions').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('有结论的判定没带证据被拒（input_invalid）', async () => {
    const { db } = setup();
    const fixture = makeReviewDraft(db);
    try {
      await submitWith(db, fixture, { verdict: 'helpful', evidenceRefs: [] });
      throw new Error('应当拒绝无证据的有结论判定');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.INPUT_INVALID);
    }
  });

  it('「没法测」可以不带证据，且判定与证据原样落进修订快照', async () => {
    const { db } = setup();
    const fixture = makeReviewDraft(db);
    const result = await submitWith(db, fixture, { verdict: 'untestable', evidenceRefs: [] });
    expect(result.reviewRevisionId).toBeTruthy();

    const rev = db
      .prepare('SELECT verdict, evidence_refs FROM review_revisions WHERE id = ?')
      .get(result.reviewRevisionId) as { verdict: string | null; evidence_refs: string | null };
    expect(rev.verdict).toBe('untestable');
    expect(rev.evidence_refs).toBeNull();
  });

  it('「真有用」+ 证据：快照里的证据链是规范化后的 JSON（可复核）', async () => {
    const { db } = setup();
    const fixture = makeReviewDraft(db);
    const result = await submitWith(db, fixture, {
      verdict: 'helpful',
      evidenceRefs: [{ url: ' https://github.com/a/b/compare/x...y ', note: '配对 A/B' }],
    });

    const rev = db
      .prepare('SELECT verdict, evidence_refs FROM review_revisions WHERE id = ?')
      .get(result.reviewRevisionId) as { verdict: string | null; evidence_refs: string | null };
    expect(rev.verdict).toBe('helpful');
    expect(JSON.parse(rev.evidence_refs ?? '[]')).toEqual([
      { url: 'https://github.com/a/b/compare/x...y', note: '配对 A/B' },
    ]);
  });

  it('同 requestKey 重放：判定/证据不同视为同键不同内容（request_key_reused）', async () => {
    const { db } = setup();
    const fixture = makeReviewDraft(db);
    const key = `req-${newId()}`;
    await submitWith(db, fixture, { verdict: 'helpful', evidenceRefs: [{ url: 'https://e.com/1', note: null }], requestKey: key });
    try {
      await submitWith(db, fixture, { verdict: 'harmful', evidenceRefs: [{ url: 'https://e.com/1', note: null }], requestKey: key });
      throw new Error('应当拒绝同键不同内容的提交');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.REQUEST_KEY_REUSED);
    }
  });
});
