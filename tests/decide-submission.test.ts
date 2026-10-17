/**
 * 人工审核决定闭环测试（第三轮补的洞）。
 *
 * 这个文件存在的**唯一理由**：在它之前，"管理员在后台点通过"之后**没有任何东西会去发布** ——
 * `decideByAdmin` 把状态推到 `approved` 就结束了。两个验收脚本都在"通过"之后
 * **直接调用 `publishReview`**，于是这条缝一直没被咬出来（单测全绿、验收全绿，真人点了等于没点）。
 *
 * 所以这里的用例必须满足：
 *  - 从 `submitReview` 开始，走**真实队列 + 真实 worker 处理器**；
 *  - "人工通过"这一步**只调 workflow**（不直接调 publishReview），
 *    发布必须由队列里的 `review_publish` 任务被 worker 领走才发生；
 *  - 断言落在库里的真实结果（状态、公开指针、首次发布时间），不是"函数返回了对象"。
 *
 * 反同义反复：把 `decide-submission.ts` 里的入队整段删掉，本文件的第 1 条用例必然变红
 * （提交会永远停在 approved，`published_revision_id` 为 null）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestDb,
  insertPlugin,
  insertRepository,
  insertReview,
  insertUser,
  type TestDb,
} from './support/db';
import { newId } from '../src/server/platform/id';
import type { SqliteDatabase } from '../src/server/platform/db';
import type { CallerContext } from '../src/server/platform/context';
import type { TaskType } from '../src/packages/common/field-rules';
import { createTasksService } from '../src/server/modules/tasks/service';
import { commentsService } from '../src/server/modules/comments';
import { submitReview } from '../src/server/workflows/submit-review';
import { decideSubmission } from '../src/server/workflows/decide-submission';
import { createHandlers } from '../src/worker/handlers';
import { createWorker } from '../src/worker/main';
import type { TaskHandler } from '../src/worker/main';

let ctx: TestDb | null = null;

afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

function setup(): TestDb {
  ctx = createTestDb();
  return ctx;
}

const GOOD_BODY =
  '这是一篇关于 DSH 插件的实测评测正文，包含安装步骤、实际表现与结论，长度足够通过基础筛查。';

function adminCtxOf(userId: string): CallerContext {
  return { userId, role: 'admin', accountStatus: 'active' };
}

function userCtxOf(userId: string): CallerContext {
  return { userId, role: 'user', accountStatus: 'active' };
}

/** 造 作者 + 插件 + 评测 + 已保存草稿；返回定位所需的 ID。 */
function makeSubmittedReview(db: SqliteDatabase) {
  const authorId = insertUser(db);
  const repositoryId = insertRepository(db);
  const pluginId = insertPlugin(db, repositoryId);
  const reviewId = insertReview(db, { authorId, pluginId });
  const draftId = newId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO content_drafts (id, owner_id, draft_type, review_id, payload, save_version, created_at, saved_at)
     VALUES (?, ?, 'review', ?, ?, 1, ?, ?)`,
  ).run(draftId, authorId, reviewId, JSON.stringify({ title: '标题', body: GOOD_BODY }), now, now);
  return { authorId, reviewId, pluginId, draftId };
}

/** 跑 worker 直到没有可领取的任务（check 通过会再入队 publish，单轮领不到）。 */
async function drain(db: SqliteDatabase, handlers: Partial<Record<TaskType, TaskHandler>>): Promise<number> {
  const worker = createWorker({
    workerReference: 'test-worker',
    tasks: createTasksService(db),
    handlers,
    sleep: async () => {},
  });
  let total = 0;
  for (let i = 0; i < 20; i += 1) {
    const n = await worker.runOnce();
    total += n;
    if (n === 0) break;
  }
  return total;
}

function submissionRow(db: SqliteDatabase, submissionId: string): { processing_state: string; state_version: number } {
  return db
    .prepare('SELECT processing_state, state_version FROM content_submissions WHERE id = ?')
    .get(submissionId) as { processing_state: string; state_version: number };
}

function publishTasks(db: SqliteDatabase, submissionId: string) {
  return db
    .prepare(
      `SELECT id, processing_state, deduplication_key FROM background_tasks
        WHERE task_type = 'review_publish' AND deduplication_key = ?`,
    )
    .all(`review_publish:${submissionId}`) as {
    id: string;
    processing_state: string;
    deduplication_key: string;
  }[];
}

describe('人工审核决定：通过之后必须真的有人去发布', () => {
  it('提交 → 检查落人工 → 管理员通过 → 队列里的 review_publish 被 worker 领走 → 真的公开', async () => {
    const { db } = setup();
    const fixture = makeSubmittedReview(db);

    // 1) 提交（入队 review_check）
    const submitted = await submitReview(
      userCtxOf(fixture.authorId),
      {
        draftId: fixture.draftId,
        expectedSaveVersion: 1,
        requestKey: `sub-${newId()}`,
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

    // 2) 跑检查任务：**未配置内容筛查** → 绝不自动放行，落 manual_review
    const checkRun = await drain(db, createHandlers({ db, contentScreenEnabled: false }));
    expect(checkRun).toBe(1);
    expect(submissionRow(db, submitted.submissionId).processing_state).toBe('manual_review');
    // 没被自动通过时，队列里**不该**有发布任务
    expect(publishTasks(db, submitted.submissionId)).toHaveLength(0);

    // 3) 管理员人工通过 —— 只调 workflow，不碰 publishReview
    const admin = insertUser(db, { role: 'admin' });
    const before = submissionRow(db, submitted.submissionId);
    const decided = await decideSubmission(
      adminCtxOf(admin),
      {
        submissionId: submitted.submissionId,
        decision: 'approve',
        reason: '环境、过程、结果与依据齐全。',
        expectedStateVersion: before.state_version,
        requestKey: `approve-${newId()}`,
      },
      db,
    );

    expect(decided.state).toBe('approved');
    expect(decided.publishTaskId).toBeTruthy();

    // 4) 队列里真的躺着一条发布任务（去重键与 worker 的自动路径一致）
    const queued = publishTasks(db, submitted.submissionId);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.processing_state).toBe('queued');
    expect(queued[0]?.id).toBe(decided.publishTaskId);

    // 5) 这时候**还没公开**（发布是另一件事，职责分离）
    expect(
      (db.prepare('SELECT published_revision_id FROM reviews WHERE id = ?').get(fixture.reviewId) as {
        published_revision_id: string | null;
      }).published_revision_id,
    ).toBeNull();

    // 6) worker 领走发布任务 → 真的公开
    const publishRun = await drain(db, createHandlers({ db, contentScreenEnabled: false }));
    expect(publishRun).toBe(1);

    expect(submissionRow(db, submitted.submissionId).processing_state).toBe('published');
    const review = db.prepare('SELECT published_revision_id FROM reviews WHERE id = ?').get(fixture.reviewId) as {
      published_revision_id: string | null;
    };
    expect(review.published_revision_id).toBe(submitted.reviewRevisionId);

    const entity = db
      .prepare('SELECT first_published_at, public_updated_at FROM content_entities WHERE id = ?')
      .get(fixture.reviewId) as { first_published_at: number | null; public_updated_at: number | null };
    expect(entity.first_published_at).not.toBeNull();
    expect(entity.public_updated_at).not.toBeNull();
  });

  it('人工通过后的重复入队只复用同一条发布任务（幂等键与 worker 完全一致）', async () => {
    const { db } = setup();
    const fixture = makeSubmittedReview(db);
    const submitted = await submitReview(
      userCtxOf(fixture.authorId),
      {
        draftId: fixture.draftId,
        expectedSaveVersion: 1,
        requestKey: `sub-${newId()}`,
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
    await drain(db, createHandlers({ db, contentScreenEnabled: false }));

    const admin = insertUser(db, { role: 'admin' });
    await decideSubmission(
      adminCtxOf(admin),
      {
        submissionId: submitted.submissionId,
        decision: 'approve',
        reason: '通过。',
        expectedStateVersion: submissionRow(db, submitted.submissionId).state_version,
        requestKey: `approve-${newId()}`,
      },
      db,
    );

    // 模拟"另一个路径又入队了一次"（例如 worker 的 check 处理器、或管理员重复触发）
    const tasks = createTasksService(db);
    const again = await tasks.enqueue({
      taskType: 'review_publish',
      deduplicationKey: `review_publish:${submitted.submissionId}`,
      requestedBy: null,
      payload: { submission_id: submitted.submissionId },
      schedulingGroup: 'review_publish',
      availableAt: Date.now(),
      tx: db,
    });
    expect(again.created).toBe(false);
    expect(publishTasks(db, submitted.submissionId)).toHaveLength(1);
  });

  it('「需修改」不产生发布任务，内容保持未公开', async () => {
    const { db } = setup();
    const fixture = makeSubmittedReview(db);
    const submitted = await submitReview(
      userCtxOf(fixture.authorId),
      {
        draftId: fixture.draftId,
        expectedSaveVersion: 1,
        requestKey: `sub-${newId()}`,
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
    await drain(db, createHandlers({ db, contentScreenEnabled: false }));

    const admin = insertUser(db, { role: 'admin' });
    const decided = await decideSubmission(
      adminCtxOf(admin),
      {
        submissionId: submitted.submissionId,
        decision: 'needs_changes',
        reason: '缺少实测过程。',
        expectedStateVersion: submissionRow(db, submitted.submissionId).state_version,
        requestKey: `approve-${newId()}`,
      },
      db,
    );

    expect(decided.state).toBe('needs_changes');
    expect(decided.publishTaskId).toBeNull();
    expect(publishTasks(db, submitted.submissionId)).toHaveLength(0);
    expect(
      (db.prepare('SELECT published_revision_id FROM reviews WHERE id = ?').get(fixture.reviewId) as {
        published_revision_id: string | null;
      }).published_revision_id,
    ).toBeNull();

    // 作者还能看到"需修改"的结论
    expect(submissionRow(db, submitted.submissionId).processing_state).toBe('needs_changes');
  });

  it('非管理员不能通过本流程做决定（权限不在 workflow 层被绕过）', async () => {
    const { db } = setup();
    const fixture = makeSubmittedReview(db);
    const submitted = await submitReview(
      userCtxOf(fixture.authorId),
      {
        draftId: fixture.draftId,
        expectedSaveVersion: 1,
        requestKey: `sub-${newId()}`,
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
    await drain(db, createHandlers({ db, contentScreenEnabled: false }));

    // 作者本人（普通用户）试图自己通过自己的稿子
    await expect(
      decideSubmission(
        userCtxOf(fixture.authorId),
        {
          submissionId: submitted.submissionId,
          decision: 'approve',
          reason: '我自己觉得没问题。',
          expectedStateVersion: submissionRow(db, submitted.submissionId).state_version,
          requestKey: `approve-${newId()}`,
        },
        db,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // 状态没动，也没有发布任务
    expect(submissionRow(db, submitted.submissionId).processing_state).toBe('manual_review');
    expect(publishTasks(db, submitted.submissionId)).toHaveLength(0);
  });

  it('后台待办里混着评论提交：通过它必须入队 comment_publish，而不是 review_publish', async () => {
    const { db } = setup();

    // 1) 先把评测发出来（评论只能挂在公开内容上）
    const fixture = makeSubmittedReview(db);
    const reviewSubmission = await submitReview(
      userCtxOf(fixture.authorId),
      {
        draftId: fixture.draftId,
        expectedSaveVersion: 1,
        requestKey: `sub-${newId()}`,
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
    await drain(db, createHandlers({ db, contentScreenEnabled: false }));
    const admin = insertUser(db, { role: 'admin' });
    await decideSubmission(
      adminCtxOf(admin),
      {
        submissionId: reviewSubmission.submissionId,
        decision: 'approve',
        reason: '通过。',
        expectedStateVersion: submissionRow(db, reviewSubmission.submissionId).state_version,
        requestKey: `approve-${newId()}`,
      },
      db,
    );
    await drain(db, createHandlers({ db, contentScreenEnabled: false }));

    // 2) 另一个用户发一条评论 → 走它自己的提交与检查
    const reader = insertUser(db);
    const comment = await commentsService.createComment(
      userCtxOf(reader),
      {
        contentEntityId: fixture.reviewId,
        body: '请问在 DSH 0.3 上也能用吗？这是一条长度足够的正常评论。',
        requestKey: `comment-${newId()}`,
      },
      db,
    );

    // 3) 评论检查：未配置筛查 → 同样落 manual_review（后台待办里就会出现它）
    await drain(db, createHandlers({ db, contentScreenEnabled: false }));
    expect(submissionRow(db, comment.submissionId).processing_state).toBe('manual_review');

    // 4) 管理员通过这条**评论提交**
    const decided = await decideSubmission(
      adminCtxOf(admin),
      {
        submissionId: comment.submissionId,
        decision: 'approve',
        reason: '评论无问题。',
        expectedStateVersion: submissionRow(db, comment.submissionId).state_version,
        requestKey: `approve-${newId()}`,
      },
      db,
    );
    expect(decided.publishTaskId).toBeTruthy();

    // 关键：任务类型必须与提交类型匹配。一律 review_publish 的话，评论会静默地永远发不出去。
    const task = db
      .prepare('SELECT task_type, deduplication_key FROM background_tasks WHERE id = ?')
      .get(decided.publishTaskId) as { task_type: string; deduplication_key: string };
    expect(task.task_type).toBe('comment_publish');
    expect(task.deduplication_key).toBe(`comment_publish:${comment.submissionId}`);
    expect(publishTasks(db, comment.submissionId)).toHaveLength(0); // 不该有 review_publish

    // 5) worker 领走 → 评论真的公开，并出现在讨论组里
    await drain(db, createHandlers({ db, contentScreenEnabled: false }));
    const commentRow = db
      .prepare('SELECT published_revision_id, first_published_at FROM comments WHERE id = ?')
      .get(comment.commentId) as { published_revision_id: string | null; first_published_at: number | null };
    expect(commentRow.published_revision_id).not.toBeNull();
    expect(commentRow.first_published_at).not.toBeNull();

    const roots = await commentsService.listRootComments(fixture.reviewId, { page: 1, page_size: 20 }, db);
    expect(roots.items.map((i) => i.commentId)).toContain(comment.commentId);
  });
});
