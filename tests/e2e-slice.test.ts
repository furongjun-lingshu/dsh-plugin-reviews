/**
 * 端到端切片验收：登录 → 收录插件 → 写评测 → 提交 → 审核 → 发布 → 评论。
 *
 * 这是本切片**最重要的一条测试**：它串起四个桶的真实实现，证明链路端到端跑得通，
 * 而不是各桶单测各自为政。
 *
 * 断言口径：每条都指向真实业务结果（库里的行、可见性解析、公开指针），
 * 不使用"函数返回了对象"这类恒真断言。
 */

import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from './support/db';
import { manifestStub, repoInfoStub } from './support/probe';
import { createIdentityService } from '../src/server/modules/identity';
import { createCatalogService, type CatalogProbe } from '../src/server/modules/catalog';
import { reviewsService } from '../src/server/modules/reviews';
import { contentService } from '../src/server/modules/content';
import { commentsService } from '../src/server/modules/comments';
import { createTasksService } from '../src/server/modules/tasks';
import { createModerationService } from '../src/server/modules/moderation';
import { submitReview, validateForPublish } from '../src/server/workflows/submit-review';
import { publishReview } from '../src/server/workflows/publish-review';
import { newId } from '../src/server/platform/id';
import type { CallerContext } from '../src/server/platform/context';

let harness: TestDb;
let db: TestDb['db'];

beforeEach(() => {
  harness = createTestDb();
  db = harness.db;
});
afterEach(() => {
  harness.cleanup();
});

/** 调用上下文：角色与账户状态每次从库里读，不缓存。 */
function callerFor(userId: string): CallerContext {
  const row = db.prepare('SELECT role, account_status FROM users WHERE id = ?').get(userId) as
    | { role: 'user' | 'admin'; account_status: 'active' | 'disabled' }
    | undefined;
  return { userId, role: row?.role ?? null, accountStatus: row?.account_status ?? null };
}

/** 收录检查探针桩：一个"合法 DSH 插件仓库"。 */
function healthyProbe(): CatalogProbe {
  return {
    async fetchRepository() {
      return repoInfoStub({
        githubRepositoryId: 'gh-1001',
        fullName: 'acme/dsh-memory',
        htmlUrl: 'https://github.com/acme/dsh-memory',
      });
    },
    async fetchPluginManifest() {
      return manifestStub({ bundlePath: './dsh.bundle.json' });
    },
  };
}

/** 登录一个用户并返回其调用上下文。 */
async function signIn(
  identity: ReturnType<typeof createIdentityService>,
  ghId: string,
  username: string,
): Promise<{ userId: string; token: string; ctx: CallerContext }> {
  const res = await identity.signInWithGithub(
    {
      providerUserId: ghId,
      providerUsername: username,
      profileUrl: `https://github.com/${username}`,
      avatarUrl: null,
      displayName: username,
    },
    Date.now(),
  );
  const session = await identity.createSession(res.userId, Date.now());
  return { userId: res.userId, token: session.token, ctx: callerFor(res.userId) };
}

/** 造一个管理员（绕过 OAuth，直接建行）。 */
function makeAdmin(): string {
  const id = newId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (id, nickname, role, account_status, created_at, updated_at)
     VALUES (?, '管理员', 'admin', 'active', ?, ?)`,
  ).run(id, now, now);
  return id;
}

describe('端到端：登录 → 收录插件 → 写评测 → 提交 → 审核 → 发布', () => {
  it('作者能走完整条链路，每步结果都真实落库', async () => {
    // ---------- 1) 登录 ----------
    const identity = createIdentityService({ db });
    const author = await signIn(identity, 'gh-user-1', 'alice');
    expect(author.ctx.accountStatus).toBe('active');

    // 会话可解析；库里只存摘要（不明文存 token）
    const resolved = await identity.resolveSession(author.token, Date.now());
    expect(resolved?.userId).toBe(author.userId);
    const storedToken = db
      .prepare('SELECT token_digest FROM user_sessions WHERE user_id = ?')
      .get(author.userId) as { token_digest: string };
    expect(storedToken.token_digest).not.toBe(author.token);
    expect(storedToken.token_digest).toHaveLength(64);

    // ---------- 2) 收录插件（真实收录检查 + 幂等） ----------
    const catalog = createCatalogService({ db });
    const accepted = await catalog.acceptPluginSubmission(
      author.ctx,
      { url: 'https://github.com/acme/dsh-memory', requestKey: 'rk-plugin-1' },
      { probe: healthyProbe() },
    );
    expect(accepted.created).toBe(true);
    expect(accepted.status).toBe('accepted');

    // 重复收录同一插件 → 复用，不重复建行
    const again = await catalog.acceptPluginSubmission(
      author.ctx,
      { url: 'https://github.com/acme/dsh-memory', requestKey: 'rk-plugin-2' },
      { probe: healthyProbe() },
    );
    expect(again.created).toBe(false);
    expect(again.pluginId).toBe(accepted.pluginId);
    expect((db.prepare('SELECT COUNT(*) AS c FROM plugins').get() as { c: number }).c).toBe(1);

    // ---------- 3) 写评测：建草稿 → 保存 ----------
    const draft = await reviewsService.createOrGetDraft(author.ctx, {
      pluginId: accepted.pluginId,
      requestKey: 'rk-draft-1',
    }, db);

    const saved = await reviewsService.saveDraft(author.ctx, {
      draftId: draft.draftId,
      expectedVersion: 0,
      requestKey: 'rk-save-1',
      payload: {
        title: '用它整理科研资料，省了不少时间',
        pluginId: accepted.pluginId,
        pluginVersion: { kind: 'known', value: '1.2.0' },
        dshVersion: { kind: 'known', value: '0.3.1' },
        body: [{ key: 's1', markdown: '## 用它做什么\n\n整理文献。' }],
      },
    }, db);
    expect(saved.saveVersion).toBe(1);

    // 过期版本保存必须被拒，且**不覆盖**已保存内容
    await expect(
      reviewsService.saveDraft(author.ctx, {
        draftId: draft.draftId,
        expectedVersion: 0,
        requestKey: 'rk-save-stale',
        payload: {
          title: '被拒绝的标题',
          pluginId: accepted.pluginId,
          pluginVersion: { kind: 'known', value: '1.2.0' },
          dshVersion: { kind: 'known', value: '0.3.1' },
          body: [{ key: 's1', markdown: '不该落库' }],
        },
      }, db),
    ).rejects.toMatchObject({ code: 'version_conflict' });

    const reloaded = await reviewsService.getDraft(author.ctx, draft.draftId, db);
    expect(reloaded.saveVersion).toBe(1);
    expect(reloaded.payload.title).toBe('用它整理科研资料，省了不少时间');
    expect(reloaded.payload.body[0]?.markdown).toContain('整理文献');

    // ---------- 4) 完整发布校验 + 提交 ----------
    const validation = validateForPublish({
      title: reloaded.payload.title,
      pluginId: accepted.pluginId,
      pluginVersion: reloaded.payload.pluginVersion,
      dshVersion: reloaded.payload.dshVersion,
    });
    expect(validation.fields).toEqual([]);

    // 先取当前 save_version 作为"作者确认版本"
    const confirmedVersion = reloaded.saveVersion;
    const submission = await submitReview(author.ctx, {
      draftId: draft.draftId,
      expectedSaveVersion: confirmedVersion,
      requestKey: 'rk-submit-1',
      publishIntent: 'publish',
      assessmentLevel: 'standard',
      // 五状态判定（dsh-bench 规范）：publish 意图必填；有结论的判定带证据。
      verdict: 'helpful',
      evidenceRefs: [{ url: 'https://example.com/bench-evidence', note: null }],
      title: reloaded.payload.title,
      bodyMarkdown: '## 用它做什么\n\n整理文献。',
      pluginVersion: reloaded.payload.pluginVersion,
      dshVersion: reloaded.payload.dshVersion,
    }, db);
    expect(submission.processingState).toBe('pending');

    // 快照已建立且不可变
    expect((db.prepare('SELECT COUNT(*) AS c FROM review_revisions').get() as { c: number }).c).toBe(1);
    expect(() =>
      db.prepare('UPDATE review_revisions SET title = ? WHERE id = ?').run('篡改', submission.reviewRevisionId),
    ).toThrow(/不可改写/);

    // 提交后仍未公开
    const beforePublish = await contentService.resolveVisibility(submission.reviewId, db);
    expect(beforePublish.publiclyVisible).toBe(false);
    expect(beforePublish.hasPublishedRevision).toBe(false);

    // ---------- 5) 审核 ----------
    const moderation = createModerationService(db);
    expect(
      (db.prepare('SELECT processing_state FROM content_submissions WHERE id = ?').get(submission.submissionId) as {
        processing_state: string;
      }).processing_state,
    ).toBe('pending');

    // 内容筛查未配置 → 转人工，绝不自动放行
    await moderation.transition(submission.submissionId, {
      expectedStateVersion: 0,
      to: 'manual_review',
      reason: '内容筛查服务未配置，转人工处理。',
    });

    const adminId = makeAdmin();
    const decided = await moderation.decideByAdmin(callerFor(adminId), {
      submissionId: submission.submissionId,
      decision: 'approve',
      reason: '环境、过程、结果与依据齐全。',
      expectedStateVersion: 1,
      requestKey: 'rk-approve-1',
    });
    expect(decided.state).toBe('approved');

    // ---------- 6) 发布 ----------
    const outcome = publishReview(submission.submissionId, db);
    expect(outcome.published).toBe(true);
    expect(outcome.revisionId).toBe(submission.reviewRevisionId);

    // 发布是系统动作：审计里必须能查到，且与人工操作区分（actor_kind=system、无 actor_user_id）。
    const publishAudit = db
      .prepare(
        "SELECT actor_kind, actor_user_id, target_id, reason FROM operation_records WHERE action_type = 'review.publish'",
      )
      .get() as { actor_kind: string; actor_user_id: string | null; target_id: string; reason: string };
    expect(publishAudit.actor_kind).toBe('system');
    expect(publishAudit.actor_user_id).toBeNull();
    expect(publishAudit.target_id).toBe(submission.reviewId);
    expect(publishAudit.reason).toContain('系统发布');

    expect(
      (db.prepare('SELECT published_revision_id FROM reviews WHERE id = ?').get(submission.reviewId) as {
        published_revision_id: string;
      }).published_revision_id,
    ).toBe(submission.reviewRevisionId);

    const entity = db
      .prepare('SELECT first_published_at, public_updated_at FROM content_entities WHERE id = ?')
      .get(submission.reviewId) as { first_published_at: number | null; public_updated_at: number | null };
    expect(entity.first_published_at).not.toBeNull();
    expect(entity.public_updated_at).not.toBeNull();

    expect(
      (db.prepare('SELECT processing_state FROM content_submissions WHERE id = ?').get(submission.submissionId) as {
        processing_state: string;
      }).processing_state,
    ).toBe('published');

    // ---------- 7) 可见性：确实公开 ----------
    const vis = await contentService.resolveVisibility(submission.reviewId, db);
    expect(vis.publiclyVisible).toBe(true);
    expect(vis.hasPublishedRevision).toBe(true);
    expect(vis.withdrawn).toBe(false);
    expect(vis.hidden).toBe(false);

    // 公开详情能读到正文
    const detail = await reviewsService.getReview(author.ctx, submission.reviewId, db);
    expect(detail.publishedRevisionId).toBe(submission.reviewRevisionId);
    expect(detail.publishedRevision?.bodyMarkdown).toContain('整理文献');

    // ---------- 8) 评论 + 回复 ----------
    const reader = await signIn(identity, 'gh-user-2', 'bob');

    const rootComment = await commentsService.createComment(
      reader.ctx,
      {
        contentEntityId: submission.reviewId,
        body: '请问在 DSH 0.3 上也能用吗？',
        requestKey: 'rk-comment-1',
      },
      db,
    );
    expect(rootComment.commentId).toBeTruthy();

    const reply = await commentsService.createComment(
      author.ctx,
      {
        contentEntityId: submission.reviewId,
        body: '可以，我就是在 0.3.1 上测的。',
        replyToCommentId: rootComment.commentId,
        requestKey: 'rk-comment-2',
      },
      db,
    );

    // 讨论组归属：被回复者是顶层 → root = 它自身
    const replyRow = db
      .prepare('SELECT content_entity_id, reply_to_comment_id, root_comment_id FROM comments WHERE id = ?')
      .get(reply.commentId) as {
      content_entity_id: string;
      reply_to_comment_id: string;
      root_comment_id: string;
    };
    expect(replyRow.content_entity_id).toBe(submission.reviewId);
    expect(replyRow.reply_to_comment_id).toBe(rootComment.commentId);
    expect(replyRow.root_comment_id).toBe(rootComment.commentId);

    // 库里真实存在两条评论 + 两条修订
    expect((db.prepare('SELECT COUNT(*) AS c FROM comments').get() as { c: number }).c).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS c FROM comment_revisions').get() as { c: number }).c).toBe(2);

    // ---------- 9) 撤回后不再公开，但内容不删 ----------
    const withdraw = await contentService.withdraw(
      author.ctx,
      {
        reviewId: submission.reviewId,
        expectedControlVersion: vis.controlVersion,
        reason: '发现数据有误，先撤回。',
        requestKey: 'rk-withdraw-1',
      },
      db,
    );
    expect(withdraw.withdrawnAt).toBeGreaterThan(0);

    const afterWithdraw = await contentService.resolveVisibility(submission.reviewId, db);
    expect(afterWithdraw.publiclyVisible).toBe(false);
    expect(afterWithdraw.withdrawn).toBe(true);
    // 历史仍在：公开修订指针没被清掉，撤回只影响可见性
    expect(
      (db.prepare('SELECT published_revision_id FROM reviews WHERE id = ?').get(submission.reviewId) as {
        published_revision_id: string | null;
      }).published_revision_id,
    ).toBe(submission.reviewRevisionId);
    expect((db.prepare('SELECT COUNT(*) AS c FROM review_revisions').get() as { c: number }).c).toBe(1);
  });

  it('未知版本可以正常提交并发布（未知不是退回理由）', () => {
    const validation = validateForPublish({
      title: '没有版本的评测',
      pluginId: 'any-plugin-id',
      pluginVersion: { kind: 'unknown' },
      dshVersion: { kind: 'unknown', reason: '作者记不清了' },
    });
    expect(validation.fields).toEqual([]);
  });

  it('缺少标题/插件/版本时给出具体字段错误（不是一句笼统提示）', () => {
    const validation = validateForPublish({
      title: '   ',
      pluginId: null,
      pluginVersion: undefined,
      dshVersion: null,
    });
    const paths = validation.fields.map((f) => f.path).sort();
    expect(paths).toEqual(['dsh_version', 'plugin_id', 'plugin_version', 'title']);
  });
});

describe('端到端：持久任务队列真的被 worker 使用', () => {
  it('入队 → 领取 → 写执行权 → 结束；旧执行权不能写回', async () => {
    const identity = createIdentityService({ db });
    const author = await signIn(identity, 'gh-user-9', 'carol');

    const tasks = createTasksService(db);
    const enqueued = await tasks.enqueue({
      taskType: 'review_check',
      deduplicationKey: 'rk-task-1',
      requestedBy: author.userId,
      payload: { submission_id: 'placeholder' },
      schedulingGroup: `author:${author.userId}`,
      availableAt: Date.now(),
      tx: db,
    });
    expect(enqueued.created).toBe(true);

    // 领取并写入执行权
    const claim = await tasks.claim('worker-test', Date.now());
    expect(claim?.taskId).toBe(enqueued.taskId);

    const running = db
      .prepare('SELECT processing_state, lease_owner, execution_token FROM background_tasks WHERE id = ?')
      .get(enqueued.taskId) as { processing_state: string; lease_owner: string; execution_token: string };
    expect(running.processing_state).toBe('running');
    expect(running.lease_owner).toBe('worker-test');
    expect(running.execution_token).toBeTruthy();

    // 同一任务不能被另一个 worker 同时领走
    const second = await tasks.claim('worker-other', Date.now());
    expect(second?.taskId).not.toBe(enqueued.taskId);

    // 旧/伪造执行权不能写回
    await expect(
      tasks.finish({ taskId: enqueued.taskId, executionToken: newId() }, { outcome: 'success', now: Date.now() }),
    ).rejects.toBeTruthy();

    // 任务状态没有因此被改动
    expect(
      (db.prepare('SELECT processing_state FROM background_tasks WHERE id = ?').get(enqueued.taskId) as {
        processing_state: string;
      }).processing_state,
    ).toBe('running');

    // 正确 token 可以结束
    await tasks.finish(
      { taskId: enqueued.taskId, executionToken: running.execution_token },
      { outcome: 'success', now: Date.now() },
    );
    const done = db
      .prepare('SELECT processing_state, finished_at FROM background_tasks WHERE id = ?')
      .get(enqueued.taskId) as { processing_state: string; finished_at: number | null };
    expect(done.processing_state).toBe('succeeded');
    expect(done.finished_at).not.toBeNull();

    // 同去重键不重复建任务
    const dupe = await tasks.enqueue({
      taskType: 'review_check',
      deduplicationKey: 'rk-task-1',
      requestedBy: author.userId,
      payload: {},
      schedulingGroup: 'g',
      availableAt: Date.now(),
      tx: db,
    });
    expect(dupe.created).toBe(false);
    expect((db.prepare('SELECT COUNT(*) AS c FROM background_tasks').get() as { c: number }).c).toBe(1);
  });
});

describe('端到端：发布资格不能被绕过', () => {
  it('未经过 approved 的提交绝不发布，且不改动公开指针', async () => {
    const identity = createIdentityService({ db });
    const author = await signIn(identity, 'gh-user-10', 'dave');

    const catalog = createCatalogService({ db });
    const accepted = await catalog.acceptPluginSubmission(
      author.ctx,
      { url: 'https://github.com/acme/dsh-memory', requestKey: 'rk-p2' },
      { probe: healthyProbe() },
    );

    const draft = await reviewsService.createOrGetDraft(author.ctx, {
      pluginId: accepted.pluginId,
      requestKey: 'rk-d3',
    }, db);
    const saved = await reviewsService.saveDraft(author.ctx, {
      draftId: draft.draftId,
      expectedVersion: 0,
      requestKey: 'rk-s3',
      payload: {
        title: '标题',
        pluginId: accepted.pluginId,
        pluginVersion: { kind: 'unknown' },
        dshVersion: { kind: 'unknown' },
        body: [{ key: 's1', markdown: '正文' }],
      },
    }, db);

    const submission = await submitReview(author.ctx, {
      draftId: draft.draftId,
      expectedSaveVersion: saved.saveVersion,
      requestKey: 'rk-sub-2',
      publishIntent: 'publish',
      assessmentLevel: 'standard',
      // 五状态判定（dsh-bench 规范）：publish 意图必填；有结论的判定带证据。
      verdict: 'helpful',
      evidenceRefs: [{ url: 'https://example.com/bench-evidence', note: null }],
      title: '标题',
      bodyMarkdown: '正文',
      pluginVersion: { kind: 'unknown' },
      dshVersion: { kind: 'unknown' },
    }, db);

    // 仍在 pending → 发布必须被拒绝
    const outcome = publishReview(submission.submissionId, db);
    expect(outcome.published).toBe(false);
    expect(outcome.reason).toBe('submission_not_approved');

    // 公开指针没被写入，公共实体也没标已发布
    expect(
      (db.prepare('SELECT published_revision_id FROM reviews WHERE id = ?').get(submission.reviewId) as {
        published_revision_id: string | null;
      }).published_revision_id,
    ).toBeNull();
    expect(
      (db.prepare('SELECT first_published_at FROM content_entities WHERE id = ?').get(submission.reviewId) as {
        first_published_at: number | null;
      }).first_published_at,
    ).toBeNull();
  });

  it('已撤回的文章不会被旧任务重新公开', async () => {
    const identity = createIdentityService({ db });
    const author = await signIn(identity, 'gh-user-11', 'erin');

    const catalog = createCatalogService({ db });
    const accepted = await catalog.acceptPluginSubmission(
      author.ctx,
      { url: 'https://github.com/acme/dsh-memory', requestKey: 'rk-p3' },
      { probe: healthyProbe() },
    );

    const draft = await reviewsService.createOrGetDraft(author.ctx, {
      pluginId: accepted.pluginId,
      requestKey: 'rk-d4',
    }, db);
    const saved = await reviewsService.saveDraft(author.ctx, {
      draftId: draft.draftId,
      expectedVersion: 0,
      requestKey: 'rk-s4',
      payload: {
        title: '待撤回的评测',
        pluginId: accepted.pluginId,
        pluginVersion: { kind: 'unknown' },
        dshVersion: { kind: 'unknown' },
        body: [{ key: 's1', markdown: '正文' }],
      },
    }, db);

    const submission = await submitReview(author.ctx, {
      draftId: draft.draftId,
      expectedSaveVersion: saved.saveVersion,
      requestKey: 'rk-sub-3',
      publishIntent: 'publish',
      assessmentLevel: 'standard',
      // 五状态判定（dsh-bench 规范）：publish 意图必填；有结论的判定带证据。
      verdict: 'helpful',
      evidenceRefs: [{ url: 'https://example.com/bench-evidence', note: null }],
      title: '待撤回的评测',
      bodyMarkdown: '正文',
      pluginVersion: { kind: 'unknown' },
      dshVersion: { kind: 'unknown' },
    }, db);

    // 审核通过
    const moderation = createModerationService(db);
    await moderation.transition(submission.submissionId, {
      expectedStateVersion: 0,
      to: 'manual_review',
      reason: '转人工。',
    });
    const adminId = makeAdmin();
    await moderation.decideByAdmin(callerFor(adminId), {
      submissionId: submission.submissionId,
      decision: 'approve',
      reason: '通过。',
      expectedStateVersion: 1,
      requestKey: 'rk-approve-2',
    });

    // 作者在发布前撤回
    const vis = await contentService.resolveVisibility(submission.reviewId, db);
    await contentService.withdraw(
      author.ctx,
      {
        reviewId: submission.reviewId,
        expectedControlVersion: vis.controlVersion,
        reason: '不发了。',
        requestKey: 'rk-withdraw-2',
      },
      db,
    );

    // 发布必须拒绝：撤回后不得被旧任务重新公开
    const outcome = publishReview(submission.submissionId, db);
    expect(outcome.published).toBe(false);
    expect(outcome.reason).toBe('target_withdrawn');

    expect(
      (db.prepare('SELECT published_revision_id FROM reviews WHERE id = ?').get(submission.reviewId) as {
        published_revision_id: string | null;
      }).published_revision_id,
    ).toBeNull();
  });
});
