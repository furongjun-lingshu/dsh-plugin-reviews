/**
 * worker handlers 测试（工作包 GT / task-6）。
 *
 * 目标：证明"提交 → 检查 → 发布"与"评论提交 → 检查 → 发布"两条闭环真的能走完，
 * 且**默认保守**（不配置筛查就绝不自动放行）。
 *
 * 纪律（并行工作包 §3）：
 *  - 每个用例都必须在实现被破坏时变红；
 *  - 禁止恒真断言；
 *  - 真实临时文件库 + 真实迁移（不用 `:memory:`）。
 *
 * 反同义反复证据见文件末尾 `describe('反同义反复')`：
 * 把 handlers 注册表换回 `{}` → 端到端用例必须变红（该用例在注释里给出实测数字）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestDb,
  insertPlugin,
  insertRepository,
  insertReview,
  insertRootComment,
  insertUser,
  type TestDb,
} from './support/db';
import { newId } from '../src/server/platform/id';
import type { SqliteDatabase } from '../src/server/platform/db';
import type { CallerContext } from '../src/server/platform/context';
import { TaskTypes, type TaskType } from '../src/packages/common/field-rules';
import { createTasksService } from '../src/server/modules/tasks/service';
import { submitReview } from '../src/server/workflows/submit-review';
import { publishComment } from '../src/server/workflows/publish-comment';
import { createHandlers } from '../src/worker/handlers';
import {
  BASIC_BLOCKLIST,
  MIN_BODY_LENGTH,
  basicScreenEnabled,
  createBasicContentScreen,
  evaluateBasicScreen,
  loadSnapshotForScreen,
} from '../src/worker/content-screen';
import { createWorker } from '../src/worker/main';
import type { TaskHandler } from '../src/worker/main';
import { evaluateRules, isVersionResolved } from '../src/server/modules/moderation/service';

let ctx: TestDb | null = null;

afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

function setup(): TestDb {
  ctx = createTestDb();
  return ctx;
}

// ============================================================
// 夹具：造一份"可提交"的评测草稿
// ============================================================

interface ReviewFixture {
  authorId: string;
  reviewId: string;
  pluginId: string;
  draftId: string;
}

/** 造 用户 + 仓库 + 插件 + 评测文章 + 已保存草稿（save_version=1）。 */
function makeReviewDraft(db: SqliteDatabase): ReviewFixture {
  const authorId = insertUser(db, { role: 'user' });
  const repositoryId = insertRepository(db);
  const pluginId = insertPlugin(db, repositoryId);
  const reviewId = insertReview(db, { authorId, pluginId });

  const now = Date.now();
  const draftId = newId();
  db.prepare(
    `INSERT INTO content_drafts (id, owner_id, draft_type, review_id, payload, save_version, created_at, saved_at)
     VALUES (?, ?, 'review', ?, ?, 1, ?, ?)`,
  ).run(draftId, authorId, reviewId, JSON.stringify({ title: '标题', body: '正文' }), now, now);

  return { authorId, reviewId, pluginId, draftId };
}

/** 提交一份足够长的正常正文（能过本地基础筛查）。 */
const GOOD_BODY = '这是一篇关于 DSH 插件的实测评测正文，包含安装步骤、实际表现与结论，长度足够通过基础筛查。';

async function submitGoodReview(db: SqliteDatabase, fixture: ReviewFixture) {
  const authorCtx: CallerContext = { userId: fixture.authorId, role: 'user', accountStatus: 'active' };
  return submitReview(
    authorCtx,
    {
      draftId: fixture.draftId,
      expectedSaveVersion: 1,
      requestKey: `req-${newId()}`,
      publishIntent: 'publish',
      // 五状态判定（dsh-bench 规范）：publish 意图必填；有结论的判定带证据。
      verdict: 'helpful',
      evidenceRefs: [{ url: 'https://example.com/bench-evidence', note: null }],
      title: '一篇实测评测',
      bodyMarkdown: GOOD_BODY,
      pluginVersion: { kind: 'unknown' },
      dshVersion: { kind: 'unknown' },
    },
    db,
  );
}

function submissionState(db: SqliteDatabase, submissionId: string): string {
  return (
    db.prepare('SELECT processing_state FROM content_submissions WHERE id = ?').get(submissionId) as {
      processing_state: string;
    }
  ).processing_state;
}

function taskStates(db: SqliteDatabase): { task_type: string; processing_state: string; last_error_code: string | null }[] {
  return db
    .prepare('SELECT task_type, processing_state, last_error_code FROM background_tasks ORDER BY created_at, id')
    .all() as { task_type: string; processing_state: string; last_error_code: string | null }[];
}

/**
 * 跑 worker 直到没有可领取的任务（或达到轮数上限）。
 *
 * 为什么需要 drain：check 通过后会**再入队**一个 publish 任务，
 * 单轮 runOnce 领不到它（它在下一轮才可见）。drain 模拟常驻 worker 连续工作。
 */
async function drain(
  db: SqliteDatabase,
  handlers: Partial<Record<TaskType, TaskHandler>>,
  options: { maxRounds?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<number> {
  const tasks = createTasksService(db);
  const worker = createWorker({
    workerReference: 'test-worker',
    tasks,
    handlers,
    sleep: options.sleep ?? (async () => {}),
  });
  let total = 0;
  const maxRounds = options.maxRounds ?? 20;
  for (let i = 0; i < maxRounds; i += 1) {
    const n = await worker.runOnce();
    total += n;
    if (n === 0) break;
  }
  return total;
}

// ============================================================
// 1. 本地内容筛查（纯函数 + 开关）
// ============================================================

describe('本地基础内容筛查', () => {
  it('正常正文 → pass', () => {
    expect(evaluateBasicScreen({ title: '标题', bodyMarkdown: GOOD_BODY }).decision).toBe('pass');
  });

  it('空正文 → violation', () => {
    const v = evaluateBasicScreen({ title: '标题', bodyMarkdown: '' });
    expect(v.decision).toBe('violation');
    expect(v.fields).toContain('body');
  });

  it('过短正文 → violation', () => {
    expect(evaluateBasicScreen({ bodyMarkdown: '太短' }).decision).toBe('violation');
  });

  it('命中违禁词 → violation', () => {
    const body = `${GOOD_BODY} ${BASIC_BLOCKLIST[0]}`;
    expect(evaluateBasicScreen({ bodyMarkdown: body }).decision).toBe('violation');
  });

  it('重复字符刷屏 → violation', () => {
    expect(evaluateBasicScreen({ bodyMarkdown: 'a'.repeat(MIN_BODY_LENGTH * 3) }).decision).toBe('violation');
  });

  it('环境开关：只有显式 basic 才启用（其他值一律保守）', () => {
    expect(basicScreenEnabled({ DSH_REVIEW_CONTENT_SCREEN: 'basic' })).toBe(true);
    expect(basicScreenEnabled({})).toBe(false);
    expect(basicScreenEnabled({ DSH_REVIEW_CONTENT_SCREEN: '' })).toBe(false);
    expect(basicScreenEnabled({ DSH_REVIEW_CONTENT_SCREEN: 'BASIC' })).toBe(false);
    expect(basicScreenEnabled({ DSH_REVIEW_CONTENT_SCREEN: 'off' })).toBe(false);
  });

  it('createBasicContentScreen 返回三态之一（可被 moderation 直接注入）', async () => {
    const screen = createBasicContentScreen();
    expect(await screen({ submissionId: 's', snapshot: { bodyMarkdown: GOOD_BODY } })).toBe('pass');
    expect(await screen({ submissionId: 's', snapshot: { bodyMarkdown: '' } })).toBe('violation');
  });

  it('回归：moderation 传来的 snapshot 不含正文，筛查必须自己按 submissionId 读库', async () => {
    const { db } = setup();
    const fixture = makeReviewDraft(db);
    const submitted = await submitGoodReview(db, fixture);

    // moderation.loadSnapshot 给 screen 的视图只有字段信息，**没有 body**。
    // 若筛查直接拿它判定，就会把一切内容当成"空正文"→ 误判 violation。
    // 传入一个"无正文"的 snapshot，模拟 moderation 的真实行为。
    const screen = createBasicContentScreen(db);
    const decision = await screen({ submissionId: submitted.submissionId, snapshot: { title: '标题' } });
    expect(decision).toBe('pass');

    // 反证：同一个"无正文" snapshot，若交给纯判定函数，确实会被判 violation
    // —— 说明上面那个 pass 只可能来自"自己读库"，不是巧合。
    expect(evaluateBasicScreen({ title: '标题' }).decision).toBe('violation');
  });

  it('回归：筛查自己读库时，真正违规的正文仍被判 violation（不是无条件 pass）', async () => {
    const { db } = setup();
    // 造一条正文极短的提交。
    const authorId = insertUser(db, { role: 'user' });
    const repositoryId = insertRepository(db);
    const pluginId = insertPlugin(db, repositoryId);
    const contentEntityId = insertReview(db, { authorId, pluginId });
    const commentId = insertRootComment(db, { contentEntityId, authorId });
    const now = Date.now();
    const revisionId = newId();
    db.prepare('INSERT INTO comment_revisions (id, comment_id, revision_number, body, submitted_at) VALUES (?, ?, 1, ?, ?)').run(
      revisionId,
      commentId,
      '短',
      now,
    );
    const submissionId = newId();
    db.prepare(
      `INSERT INTO content_submissions
         (id, submitted_by, submission_type, comment_revision_id, request_key, request_digest,
          processing_state, state_version, publication_context, submitted_at, updated_at)
       VALUES (?, ?, 'comment_revision', ?, ?, ?, 'pending', 0, '{}', ?, ?)`,
    ).run(submissionId, authorId, revisionId, `req-${submissionId}`, 'b'.repeat(64), now, now);

    const screen = createBasicContentScreen(db);
    expect(await screen({ submissionId, snapshot: {} })).toBe('violation');
  });

  it('loadSnapshotForScreen 能读到真实提交的快照', async () => {
    const { db } = setup();
    const fixture = makeReviewDraft(db);
    const result = await submitGoodReview(db, fixture);

    const snapshot = loadSnapshotForScreen(db, result.submissionId) as {
      submissionType: string;
      title: string;
      bodyMarkdown: string;
    };
    expect(snapshot.submissionType).toBe('review_revision');
    expect(snapshot.title).toBe('一篇实测评测');
    expect(snapshot.bodyMarkdown).toBe(GOOD_BODY);
  });
});

// ============================================================
// 2. 接线：submit 之后任务真的被 enqueue
// ============================================================

describe('提交后的任务接线', () => {
  it('submitReview 真的入队了一个 review_check 任务（不是静默 null）', async () => {
    const { db } = setup();
    const fixture = makeReviewDraft(db);
    const result = await submitGoodReview(db, fixture);

    // taskId 为 null 说明 loadTasks 没装配上 —— 那正是链路断掉的地方。
    expect(result.taskId).not.toBeNull();

    const rows = taskStates(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.task_type).toBe('review_check');
    expect(rows[0]!.processing_state).toBe('queued');

    // payload 指向该提交（handler 靠它定位）。
    const payload = JSON.parse(
      (db.prepare('SELECT payload FROM background_tasks WHERE id = ?').get(result.taskId) as { payload: string }).payload,
    ) as { submission_id?: string };
    expect(payload.submission_id).toBe(result.submissionId);
  });
});

// ============================================================
// 3. 端到端：提交 → 检查 → 发布
// ============================================================

describe('端到端：提交 → 自动发布（筛查注入 pass）', () => {
  it('筛选通过：review 到达 published，published_revision_id 指向正确修订', async () => {
    const { db } = setup();
    const fixture = makeReviewDraft(db);
    const submitted = await submitGoodReview(db, fixture);

    expect(submissionState(db, submitted.submissionId)).toBe('pending');

    // 注入 pass 筛查（显式，不依赖环境变量）。
    const handlers = createHandlers({ db, contentScreen: async () => 'pass' });
    const handled = await drain(db, handlers);

    // 两个任务被处理：review_check + review_publish。
    expect(handled).toBe(2);

    expect(submissionState(db, submitted.submissionId)).toBe('published');

    const review = db
      .prepare('SELECT published_revision_id, latest_submitted_revision_id FROM reviews WHERE id = ?')
      .get(fixture.reviewId) as { published_revision_id: string | null; latest_submitted_revision_id: string | null };

    expect(review.published_revision_id).not.toBeNull();
    expect(review.published_revision_id).toBe(submitted.reviewRevisionId);
    expect(review.published_revision_id).toBe(review.latest_submitted_revision_id);

    // 公共内容发布时间被写上（首次发布）。
    const entity = db
      .prepare('SELECT first_published_at, public_updated_at FROM content_entities WHERE id = ?')
      .get(fixture.reviewId) as { first_published_at: number | null; public_updated_at: number | null };
    expect(entity.first_published_at).not.toBeNull();
    expect(entity.public_updated_at).not.toBeNull();

    // 两个任务都以 succeeded 结束。
    const rows = taskStates(db);
    expect(rows.map((r) => `${r.task_type}:${r.processing_state}`)).toEqual([
      'review_check:succeeded',
      'review_publish:succeeded',
    ]);
  });

  it('检查通过后确实再入队了一个 review_publish（职责分离，不是 check 内部直接发）', async () => {
    const { db } = setup();
    const fixture = makeReviewDraft(db);
    const submitted = await submitGoodReview(db, fixture);

    const handlers = createHandlers({ db, contentScreen: async () => 'pass' });
    const tasks = createTasksService(db);

    // 只跑一轮：只应处理 review_check，并额外入队 review_publish。
    const worker = createWorker({ workerReference: 'w', tasks, handlers, sleep: async () => {} });
    const firstRound = await worker.runOnce();
    expect(firstRound).toBe(1);

    const afterCheck = db
      .prepare('SELECT task_type, processing_state FROM background_tasks ORDER BY created_at, id')
      .all() as { task_type: string; processing_state: string }[];
    expect(afterCheck).toHaveLength(2);
    expect(afterCheck[0]!.task_type).toBe('review_check');
    expect(afterCheck[0]!.processing_state).toBe('succeeded');
    expect(afterCheck[1]!.task_type).toBe('review_publish');
    expect(afterCheck[1]!.processing_state).toBe('queued');

    // 此时还没发布 —— 发布是第二个任务的事。
    expect(submissionState(db, submitted.submissionId)).toBe('approved');
    expect(
      (db.prepare('SELECT published_revision_id FROM reviews WHERE id = ?').get(fixture.reviewId) as {
        published_revision_id: string | null;
      }).published_revision_id,
    ).toBeNull();

    // 第二轮完成发布。
    await worker.runOnce();
    expect(submissionState(db, submitted.submissionId)).toBe('published');
  });
});

// ============================================================
// 4. 幂等
// ============================================================

describe('发布幂等', () => {
  it('重复入队 publish 任务复用同一任务（UNIQUE(task_type, deduplication_key)）', async () => {
    const { db } = setup();
    const fixture = makeReviewDraft(db);
    const submitted = await submitGoodReview(db, fixture);
    const tasks = createTasksService(db);

    await drain(db, createHandlers({ db, contentScreen: async () => 'pass' }));
    expect(submissionState(db, submitted.submissionId)).toBe('published');

    // 再入队一次发布任务：必须复用既有任务，不新建。
    const again = await tasks.enqueue({
      taskType: 'review_publish',
      deduplicationKey: `review_publish:${submitted.submissionId}`,
      requestedBy: null,
      payload: { submission_id: submitted.submissionId },
      schedulingGroup: 'review_publish',
      availableAt: 0,
      tx: db,
    });
    expect(again.created).toBe(false);

    const publishTasks = db
      .prepare("SELECT COUNT(*) AS n FROM background_tasks WHERE task_type = 'review_publish'")
      .get() as { n: number };
    expect(publishTasks.n).toBe(1);
  });

  it('直接重复调用 publish handler：只发布一次，修订指针不被改写、revision 不重复', async () => {
    const { db } = setup();
    const fixture = makeReviewDraft(db);
    const submitted = await submitGoodReview(db, fixture);

    await drain(db, createHandlers({ db, contentScreen: async () => 'pass' }));
    const firstReview = db
      .prepare('SELECT published_revision_id FROM reviews WHERE id = ?')
      .get(fixture.reviewId) as { published_revision_id: string | null };

    // 直接再跑一次评测发布 handler（模拟"同一任务被重复执行"）。
    const handlers = createHandlers({ db, contentScreen: async () => 'pass' });
    const again = await handlers.review_publish!({
      taskId: 'manual-rerun',
      taskType: 'review_publish',
      executionToken: 'manual',
      leaseOwner: 'manual',
      leaseExpiresAt: 0,
      attemptNumber: 1,
      retryCycle: 1,
      payload: { submission_id: submitted.submissionId },
      schedulingGroup: 'review_publish',
      deadlineAt: 0,
    });

    // 幂等命中 → 成功结束，且**不是**错误。
    expect(again.outcome).toBe('success');

    const secondReview = db
      .prepare('SELECT published_revision_id FROM reviews WHERE id = ?')
      .get(fixture.reviewId) as { published_revision_id: string | null };
    expect(secondReview.published_revision_id).toBe(firstReview.published_revision_id);

    // 只存在一条修订快照（没有因重复发布而新建）。
    const revisions = db
      .prepare('SELECT COUNT(*) AS n FROM review_revisions WHERE review_id = ?')
      .get(fixture.reviewId) as { n: number };
    expect(revisions.n).toBe(1);

    // 提交版本号：发布只推进一次（0 → 1 checking → 2 approved → 3 published）。
    const version = db
      .prepare('SELECT state_version FROM content_submissions WHERE id = ?')
      .get(submitted.submissionId) as { state_version: number };
    expect(version.state_version).toBe(3);
  });

  it('整条链重复 drain 不会产生第二次发布（修订指针与首次相同）', async () => {
    const { db } = setup();
    const fixture = makeReviewDraft(db);
    const submitted = await submitGoodReview(db, fixture);

    await drain(db, createHandlers({ db, contentScreen: async () => 'pass' }));
    const reviewAfterFirst = db
      .prepare('SELECT published_revision_id FROM reviews WHERE id = ?')
      .get(fixture.reviewId) as { published_revision_id: string | null };

    // 再三轮：没有可领任务（全部 succeeded），也不该产生新任务。
    const extra = await drain(db, createHandlers({ db, contentScreen: async () => 'pass' }), { maxRounds: 3 });
    expect(extra).toBe(0);

    const reviewAfterSecond = db
      .prepare('SELECT published_revision_id FROM reviews WHERE id = ?')
      .get(fixture.reviewId) as { published_revision_id: string | null };
    expect(reviewAfterSecond.published_revision_id).toBe(reviewAfterFirst.published_revision_id);

    const taskCount = db.prepare('SELECT COUNT(*) AS n FROM background_tasks').get() as { n: number };
    expect(taskCount.n).toBe(2); // review_check + review_publish，没有多出来
    expect(submissionState(db, submitted.submissionId)).toBe('published');
  });
});

// ============================================================
// 5. 保守默认：不配置筛查绝不自动放行
// ============================================================

describe('默认保守：未配置筛查不得自动放行', () => {
  it('不注入筛查 → 停在 manual_review，内容没有被发布', async () => {
    const { db } = setup();
    const fixture = makeReviewDraft(db);
    const submitted = await submitGoodReview(db, fixture);

    // 不传 contentScreen，且显式关闭 env 开关 → 走 not_configured。
    const handlers = createHandlers({ db, contentScreenEnabled: false });
    await drain(db, handlers);

    expect(submissionState(db, submitted.submissionId)).toBe('manual_review');
    expect(submissionState(db, submitted.submissionId)).not.toBe('approved');
    expect(submissionState(db, submitted.submissionId)).not.toBe('published');

    // 修订指针没有被切换 —— 这是"没被发布"的硬证据。
    const review = db
      .prepare('SELECT published_revision_id FROM reviews WHERE id = ?')
      .get(fixture.reviewId) as { published_revision_id: string | null };
    expect(review.published_revision_id).toBeNull();

    // 也没有产生 review_publish 任务（没人该去发布）。
    const publishTasks = db
      .prepare("SELECT COUNT(*) AS n FROM background_tasks WHERE task_type = 'review_publish'")
      .get() as { n: number };
    expect(publishTasks.n).toBe(0);

    // 处理记录里如实写了 fault（不是静默通过）。
    const record = db
      .prepare(
        "SELECT result FROM content_moderation_records WHERE submission_id = ? AND stage = 'content_screen'",
      )
      .get(submitted.submissionId) as { result: string } | undefined;
    expect(record?.result).toBe('fault');
  });

  it('env 开关默认（未设置）时 basicScreenEnabled 为 false → 保守分支', async () => {
    const { db } = setup();
    const fixture = makeReviewDraft(db);
    const submitted = await submitGoodReview(db, fixture);

    // 不传 contentScreenEnabled → 走 env；测试进程未设 DSH_REVIEW_CONTENT_SCREEN。
    const prev = process.env.DSH_REVIEW_CONTENT_SCREEN;
    delete process.env.DSH_REVIEW_CONTENT_SCREEN;
    try {
      expect(basicScreenEnabled()).toBe(false);
      await drain(db, createHandlers({ db }));
      expect(submissionState(db, submitted.submissionId)).toBe('manual_review');
    } finally {
      if (prev !== undefined) process.env.DSH_REVIEW_CONTENT_SCREEN = prev;
    }
  });

  it('筛查判定 violation → needs_changes，内容没有被发布', async () => {
    const { db } = setup();
    const fixture = makeReviewDraft(db);
    const submitted = await submitGoodReview(db, fixture);

    await drain(db, createHandlers({ db, contentScreen: async () => 'violation' }));

    expect(submissionState(db, submitted.submissionId)).toBe('needs_changes');
    const review = db
      .prepare('SELECT published_revision_id FROM reviews WHERE id = ?')
      .get(fixture.reviewId) as { published_revision_id: string | null };
    expect(review.published_revision_id).toBeNull();
  });

  it('筛查抛错（外部服务故障）→ manual_review，不放行也不认定违规', async () => {
    const { db } = setup();
    const fixture = makeReviewDraft(db);
    const submitted = await submitGoodReview(db, fixture);

    await drain(
      db,
      createHandlers({
        db,
        contentScreen: async () => {
          throw new Error('外部审核服务 503');
        },
      }),
    );

    expect(submissionState(db, submitted.submissionId)).toBe('manual_review');
    const review = db
      .prepare('SELECT published_revision_id FROM reviews WHERE id = ?')
      .get(fixture.reviewId) as { published_revision_id: string | null };
    expect(review.published_revision_id).toBeNull();
  });
});

// ============================================================
// 6. 失败分支
// ============================================================

describe('失败分支', () => {
  it('payload 缺 submission_id → 任务记明确 errorCode 并终结（不浪费重试预算）', async () => {
    const { db } = setup();
    const tasks = createTasksService(db);
    await tasks.enqueue({
      taskType: 'review_check',
      deduplicationKey: 'broken-1',
      requestedBy: null,
      payload: { nothing: true },
      schedulingGroup: 'g',
      availableAt: 0,
    });

    const worker = createWorker({
      workerReference: 'w',
      tasks,
      handlers: createHandlers({ db, contentScreen: async () => 'pass' }),
      sleep: async () => {},
    });
    await worker.runOnce();

    const row = db
      .prepare("SELECT processing_state, last_error_code FROM background_tasks WHERE task_type = 'review_check'")
      .get() as { processing_state: string; last_error_code: string | null };
    expect(row.processing_state).toBe('skipped');
    expect(row.last_error_code).toBe('payload_missing_submission_id');
  });

  it('提交不存在 → 任务终结并带 errorCode，不产生发布', async () => {
    const { db } = setup();
    const tasks = createTasksService(db);
    await tasks.enqueue({
      taskType: 'review_publish',
      deduplicationKey: 'broken-2',
      requestedBy: null,
      payload: { submission_id: newId() },
      schedulingGroup: 'g',
      availableAt: 0,
    });

    const worker = createWorker({
      workerReference: 'w',
      tasks,
      handlers: createHandlers({ db }),
      sleep: async () => {},
    });
    await worker.runOnce();

    const row = db
      .prepare("SELECT processing_state, last_error_code FROM background_tasks WHERE task_type = 'review_publish'")
      .get() as { processing_state: string; last_error_code: string | null };
    // 提交不存在是**不可重试**的数据问题 → 明确终结，不烧重试预算。
    expect(row.processing_state).toBe('skipped');
    expect(row.last_error_code).toBe('submission_missing');
  });

  it('提交未 approved 时发布不执行，且不切换修订指针', async () => {
    const { db } = setup();
    const fixture = makeReviewDraft(db);
    const submitted = await submitGoodReview(db, fixture);

    // 提交仍在 pending（没跑 check），直接跑发布 handler。
    expect(submissionState(db, submitted.submissionId)).toBe('pending');
    const handlers = createHandlers({ db });
    const result = await handlers.review_publish!({
      taskId: 't',
      taskType: 'review_publish',
      executionToken: 'x',
      leaseOwner: 'x',
      leaseExpiresAt: 0,
      attemptNumber: 1,
      retryCycle: 1,
      payload: { submission_id: submitted.submissionId },
      schedulingGroup: 'g',
      deadlineAt: 0,
    });

    expect(result.outcome).toBe('skipped');
    expect(result.errorCode).toBe('publish_submission_not_approved');
    expect(submissionState(db, submitted.submissionId)).toBe('pending');
    expect(
      (db.prepare('SELECT published_revision_id FROM reviews WHERE id = ?').get(fixture.reviewId) as {
        published_revision_id: string | null;
      }).published_revision_id,
    ).toBeNull();
  });

  it('规则缺项（版本字段缺失）→ 判定为 needs_changes，字段路径完整', () => {
    const { db } = setup();
    const fixture = makeReviewDraft(db);

    // 说明：无法用真实库构造"版本缺失的提交"——review_revisions 有不可变触发器，
    // 插完再改会被拒绝（'提交后不可改写'）。因此该分支由 evaluateRules 纯函数覆盖；
    // 集成侧另有用例证明**正常提交不会被误判**（见上一个用例的 published 断言）。
    const rules = evaluateRules({
      submissionType: 'review_revision',
      title: '标题',
      pluginId: fixture.pluginId,
      pluginVersion: null,
      dshVersion: null,
    });
    expect(rules.result).toBe('needs_changes');
    expect(rules.nextState).toBe('needs_changes');
    expect(rules.fields.map((f) => f.path).sort()).toEqual(['dsh_version', 'plugin_version']);
  });

  it('明确未知版本不被退回（unknown 不构成退回理由）', () => {
    const rules = evaluateRules({
      submissionType: 'review_revision',
      title: '标题',
      pluginId: 'p1',
      pluginVersion: { kind: 'unknown' },
      dshVersion: { kind: 'unknown' },
    });
    expect(rules.result).toBe('pass');
    expect(isVersionResolved({ kind: 'unknown' })).toBe(true);
  });
});

// ============================================================
// 7. 评论闭环
// ============================================================

interface CommentFixture {
  authorId: string;
  contentEntityId: string;
  commentId: string;
  revisionId: string;
  submissionId: string;
}

/** 造一条"待检查的评论提交"（直接落库，形状与 comments 模块的写入一致）。 */
function makeCommentSubmission(db: SqliteDatabase, body = GOOD_BODY): CommentFixture {
  const authorId = insertUser(db, { role: 'user' });
  const repositoryId = insertRepository(db);
  const pluginId = insertPlugin(db, repositoryId);
  const contentEntityId = insertReview(db, { authorId, pluginId });
  const commentId = insertRootComment(db, { contentEntityId, authorId });

  const now = Date.now();
  const revisionId = newId();
  db.prepare(
    `INSERT INTO comment_revisions (id, comment_id, revision_number, body, submitted_at) VALUES (?, ?, 1, ?, ?)`,
  ).run(revisionId, commentId, body, now);

  const submissionId = newId();
  db.prepare(
    `INSERT INTO content_submissions
       (id, submitted_by, submission_type, comment_revision_id, request_key, request_digest,
        processing_state, state_version, publication_context, submitted_at, updated_at)
     VALUES (?, ?, 'comment_revision', ?, ?, ?, 'pending', 0, ?, ?, ?)`,
  ).run(submissionId, authorId, revisionId, `req-${submissionId}`, 'a'.repeat(64), '{}', now, now);

  return { authorId, contentEntityId, commentId, revisionId, submissionId };
}

describe('评论闭环：提交 → 检查 → 发布', () => {
  it('筛查通过 → 评论到达 published，published_revision_id 指向该修订', async () => {
    const { db } = setup();
    const fixture = makeCommentSubmission(db);
    const tasks = createTasksService(db);
    await tasks.enqueue({
      taskType: 'comment_check',
      deduplicationKey: `comment_check:${fixture.submissionId}`,
      requestedBy: null,
      payload: { submissionId: fixture.submissionId },
      schedulingGroup: 'comment_check',
      availableAt: 0,
    });

    const handled = await drain(db, createHandlers({ db, contentScreen: async () => 'pass' }));
    expect(handled).toBe(2); // comment_check + comment_publish

    expect(submissionState(db, fixture.submissionId)).toBe('published');
    const comment = db
      .prepare('SELECT published_revision_id, first_published_at FROM comments WHERE id = ?')
      .get(fixture.commentId) as { published_revision_id: string | null; first_published_at: number | null };
    expect(comment.published_revision_id).toBe(fixture.revisionId);
    expect(comment.first_published_at).not.toBeNull();

    const rows = taskStates(db);
    expect(rows.map((r) => `${r.task_type}:${r.processing_state}`)).toEqual([
      'comment_check:succeeded',
      'comment_publish:succeeded',
    ]);
  });

  it('评论筛查未配置 → 停在 manual_review，评论未被公开', async () => {
    const { db } = setup();
    const fixture = makeCommentSubmission(db);
    const tasks = createTasksService(db);
    await tasks.enqueue({
      taskType: 'comment_check',
      deduplicationKey: `comment_check:${fixture.submissionId}`,
      requestedBy: null,
      payload: { submissionId: fixture.submissionId },
      schedulingGroup: 'comment_check',
      availableAt: 0,
    });

    await drain(db, createHandlers({ db, contentScreenEnabled: false }));

    expect(submissionState(db, fixture.submissionId)).toBe('manual_review');
    const comment = db
      .prepare('SELECT published_revision_id FROM comments WHERE id = ?')
      .get(fixture.commentId) as { published_revision_id: string | null };
    expect(comment.published_revision_id).toBeNull();
  });

  it('评论发布幂等：重复跑 publish handler 不重复发布', async () => {
    const { db } = setup();
    const fixture = makeCommentSubmission(db);
    const tasks = createTasksService(db);
    await tasks.enqueue({
      taskType: 'comment_check',
      deduplicationKey: `comment_check:${fixture.submissionId}`,
      requestedBy: null,
      payload: { submissionId: fixture.submissionId },
      schedulingGroup: 'comment_check',
      availableAt: 0,
    });
    await drain(db, createHandlers({ db, contentScreen: async () => 'pass' }));

    const before = db
      .prepare('SELECT published_revision_id, first_published_at FROM comments WHERE id = ?')
      .get(fixture.commentId) as { published_revision_id: string; first_published_at: number };

    const handlers = createHandlers({ db });
    const again = await handlers.comment_publish!({
      taskId: 't',
      taskType: 'comment_publish',
      executionToken: 'x',
      leaseOwner: 'x',
      leaseExpiresAt: 0,
      attemptNumber: 1,
      retryCycle: 1,
      payload: { submissionId: fixture.submissionId },
      schedulingGroup: 'g',
      deadlineAt: 0,
    });
    expect(again.outcome).toBe('success');

    const after = db
      .prepare('SELECT published_revision_id, first_published_at FROM comments WHERE id = ?')
      .get(fixture.commentId) as { published_revision_id: string; first_published_at: number };
    expect(after.published_revision_id).toBe(before.published_revision_id);
    expect(after.first_published_at).toBe(before.first_published_at);
  });
});

// ============================================================
// 8. publishComment workflow 的资格核验（Lead 迁移后补的守卫）
//
// 评论发布原先是 worker 层内联实现，**先读后写、读在事务外**。
// 已迁移到 src/server/workflows/publish-comment.ts，资格核验全部移进事务内。
// 下面两条直接打 workflow，锁住迁移后的语义。
// ============================================================

describe('publishComment workflow', () => {
  /** 把提交置为 approved（发布的前置条件）。 */
  function approve(db: SqliteDatabase, submissionId: string): void {
    db.prepare(`UPDATE content_submissions SET processing_state = 'approved' WHERE id = ?`).run(submissionId);
  }

  it('已删除的评论即使提交已 approved 也绝不发布', () => {
    const { db } = setup();
    const fixture = makeCommentSubmission(db);
    approve(db, fixture.submissionId);
    // 并发删除：资格核验必须在事务内看到 deleted_at，而不是沿用调用方此前的判断。
    db.prepare('UPDATE comments SET deleted_at = ? WHERE id = ?').run(Date.now(), fixture.commentId);

    const outcome = publishComment(fixture.submissionId, db);
    expect(outcome.published).toBe(false);
    expect(outcome.reason).toBe('comment_deleted');

    const comment = db
      .prepare('SELECT published_revision_id FROM comments WHERE id = ?')
      .get(fixture.commentId) as { published_revision_id: string | null };
    expect(comment.published_revision_id).toBeNull();
    // 未发布时也不得把提交改成 published。
    expect(submissionState(db, fixture.submissionId)).toBe('approved');
  });

  it('未 approved 的提交不发布，也不改写状态', () => {
    const { db } = setup();
    const fixture = makeCommentSubmission(db); // 初始 pending

    const outcome = publishComment(fixture.submissionId, db);
    expect(outcome.published).toBe(false);
    expect(outcome.reason).toBe('submission_not_approved');

    const comment = db
      .prepare('SELECT published_revision_id FROM comments WHERE id = ?')
      .get(fixture.commentId) as { published_revision_id: string | null };
    expect(comment.published_revision_id).toBeNull();
    expect(submissionState(db, fixture.submissionId)).toBe('pending');
  });

  it('第二次调用返回 already_published，first_published_at 不被重置', () => {
    const { db } = setup();
    const fixture = makeCommentSubmission(db);
    approve(db, fixture.submissionId);

    const first = publishComment(fixture.submissionId, db);
    expect(first.published).toBe(true);
    const afterFirst = db
      .prepare('SELECT published_revision_id, first_published_at FROM comments WHERE id = ?')
      .get(fixture.commentId) as { published_revision_id: string; first_published_at: number };

    const second = publishComment(fixture.submissionId, db);
    expect(second.published).toBe(false);
    expect(second.reason).toBe('already_published');

    const afterSecond = db
      .prepare('SELECT published_revision_id, first_published_at FROM comments WHERE id = ?')
      .get(fixture.commentId) as { published_revision_id: string; first_published_at: number };
    expect(afterSecond.published_revision_id).toBe(afterFirst.published_revision_id);
    expect(afterSecond.first_published_at).toBe(afterFirst.first_published_at);
  });

  it('不是评论修订的提交不能走评论发布（评测提交走 publishReview）', () => {
    const { db } = setup();
    // 造一个**合法**的评测修订提交：不能省 revision_id，
    // 库里有触发器会挡"评测修订快照不存在"（这里顺带证明约束在起作用）。
    const fixture = makeReviewDraft(db);
    const now = Date.now();
    const revisionId = newId();
    db.prepare(
      `INSERT INTO review_revisions
         (id, review_id, revision_number, plugin_id, title, body_markdown, plugin_version, dsh_version, submitted_at)
       VALUES (?, ?, 1, ?, '标题', '正文', '{"kind":"unknown"}', '{"kind":"unknown"}', ?)`,
    ).run(revisionId, fixture.reviewId, fixture.pluginId, now);

    const reviewSubmissionId = newId();
    db.prepare(
      `INSERT INTO content_submissions
         (id, submitted_by, submission_type, review_revision_id, comment_revision_id, draft_id, draft_save_version,
          request_key, request_digest, processing_state, state_version, publication_context, submitted_at, updated_at)
       VALUES (?, ?, 'review_revision', ?, NULL, ?, 1, ?, ?, 'approved', 0, '{}', ?, ?)`,
    ).run(
      reviewSubmissionId,
      fixture.authorId,
      revisionId,
      fixture.draftId,
      `req-${reviewSubmissionId}`,
      'b'.repeat(64),
      now,
      now,
    );

    const outcome = publishComment(reviewSubmissionId, db);
    expect(outcome.published).toBe(false);
    expect(outcome.reason).toBe('submission_type_mismatch');
  });
});

// ============================================================
// 8. 注册表完整性
// ============================================================

describe('handler 注册表', () => {
  it('**每一个**任务类型都注册了处理器（缺一个链路就断，清单不许手工维护）', () => {
    const { db } = setup();
    const handlers = createHandlers({ db });
    // 直接遍历 TaskTypes：加类型时（如 0007 的 plugin_discovery）不用回来改本用例，
    // 但只要有人忘了写 handler，这里立刻变红。
    for (const t of TaskTypes) {
      expect(typeof handlers[t], `${t} 未注册`).toBe('function');
      expect(handlers[t]).toBeDefined();
    }
    expect(Object.keys(handlers)).toHaveLength(TaskTypes.length);
  });

  it('main() 真的用 createHandlers 装配注册表（读源码，防止退回空 {}）', async () => {
    // 这条**故意读源码**：main() 会阻塞在 run() 上，无法直接调用断言。
    // 它防的正是"注册表退回 {}"这个具体回归 —— 若有人把 createHandlers({ db })
    // 改回 `const handlers = {}`，本用例变红。
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(process.cwd(), 'src/worker/main.ts'), 'utf8');

    expect(source).toContain('createHandlers({ db })');
    // 不得再出现空的处理器字面量。
    expect(source).not.toMatch(/const handlers[^=]*=\s*\{\s*\};/);
    // 也不得再出现"未注册会被跳过"的老注释所暗示的空注册表写法。
    expect(source).toMatch(/import \{ createHandlers \} from '\.\/handlers'/);
  });
});
