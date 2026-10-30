/**
 * 评测发布流程（架构第 34.1、56、57、63 节）。
 *
 * 职责：在提交通过检查后，把「公开修订指针切换 + 公共内容发布时间」协调成一次事务。
 *
 * 发布资格必须**在事务内重新核验**，不能因为"曾经通过"就替换当前内容
 * （架构第 57 节）；旧任务不得把已撤回或已隐藏的内容重新公开。
 */

import { withTransaction, type Tx } from '@/server/platform/tx';
import { recordOperationInTx } from '@/server/modules/operations';
import { nowMs } from '@/server/platform/time';
import type { SqliteDatabase } from '@/server/platform/db';
import { getDb } from '@/server/platform/db';
import { err } from '@/packages/common/errors';
import { reindexReviewInTx } from '@/server/modules/search';
import type { SubmissionState } from '@/packages/common/field-rules';

export interface PublishOutcome {
  published: boolean;
  /** 未发布时的原因码（供页面如实展示，不伪造成功）。 */
  reason?:
    | 'submission_not_approved'
    | 'already_published'
    | 'target_withdrawn'
    | 'target_hidden'
    | 'revision_missing'
    | 'superseded';
  reviewId?: string;
  revisionId?: string;
  publishedAt?: number;
}

interface SubmissionRow {
  id: string;
  submission_type: string;
  processing_state: SubmissionState;
  review_revision_id: string | null;
}

interface RevisionRow {
  id: string;
  review_id: string;
  plugin_id: string;
}

interface EntityRow {
  id: string;
  withdrawn_at: number | null;
  hidden_at: number | null;
  first_published_at: number | null;
}

/**
 * 执行一次发布。
 *
 * 资格核验（事务内，全部通过才切换公开修订）：
 *  1. 提交处于 `approved`（检查已通过）；
 *  2. 快照存在且属于本篇评测；
 *  3. 文章的公共内容实体**未撤回、未隐藏**；
 *  4. 该提交仍是文章的最新提交（未被更新的提交取代）。
 *
 * 注意 `published` 表示"该提交曾完成发布"，**不代表内容当前仍公开** ——
 * 后续撤回/隐藏由可见性解析另行判断（架构第 56 节）。
 */
export function publishReview(
  submissionId: string,
  db: SqliteDatabase = getDb(),
  /** 触发这次发布的队列任务（写进审计的 task_id，便于从操作记录回到任务）。 */
  options?: { taskId?: string | null },
): PublishOutcome {
  return withTransaction((tx: Tx) => {
    const handle = tx.db;
    const now = nowMs();

    const submission = handle
      .prepare('SELECT id, submission_type, processing_state, review_revision_id FROM content_submissions WHERE id = ?')
      .get(submissionId) as SubmissionRow | undefined;

    if (!submission) throw err.unavailable('提交不存在。');
    if (submission.submission_type !== 'review_revision') {
      throw err.input('该提交不是评测修订，不能走评测发布流程。');
    }
    if (submission.processing_state === 'published') {
      return { published: false, reason: 'already_published' as const };
    }
    if (submission.processing_state !== 'approved') {
      // 未通过检查绝不发布；也不改写状态。
      return { published: false, reason: 'submission_not_approved' as const };
    }
    if (!submission.review_revision_id) {
      return { published: false, reason: 'revision_missing' as const };
    }

    const revision = handle
      .prepare('SELECT id, review_id, plugin_id FROM review_revisions WHERE id = ?')
      .get(submission.review_revision_id) as RevisionRow | undefined;
    if (!revision) return { published: false, reason: 'revision_missing' as const };

    const review = handle
      .prepare('SELECT id, plugin_id, published_revision_id, latest_submitted_revision_id FROM reviews WHERE id = ?')
      .get(revision.review_id) as
      | { id: string; plugin_id: string | null; published_revision_id: string | null; latest_submitted_revision_id: string | null }
      | undefined;
    if (!review) return { published: false, reason: 'revision_missing' as const };

    // 资格：被更新的提交取代时不再发布旧快照（架构第 57 节）。
    if (review.latest_submitted_revision_id !== revision.id) {
      handle
        .prepare(`UPDATE content_submissions SET processing_state = 'ineligible', state_version = state_version + 1, updated_at = ? WHERE id = ?`)
        .run(now, submissionId);
      return { published: false, reason: 'superseded' as const };
    }

    const entity = handle
      .prepare('SELECT id, withdrawn_at, hidden_at, first_published_at FROM content_entities WHERE id = ?')
      .get(revision.review_id) as EntityRow | undefined;
    if (!entity) return { published: false, reason: 'revision_missing' as const };
    if (entity.withdrawn_at !== null) return { published: false, reason: 'target_withdrawn' as const };
    if (entity.hidden_at !== null) return { published: false, reason: 'target_hidden' as const };

    // 公开修订必须与该文章的插件关联一致；先同步文章插件（触发器会校验一致性）。
    if (review.plugin_id !== revision.plugin_id) {
      handle.prepare('UPDATE reviews SET plugin_id = ? WHERE id = ?').run(revision.plugin_id, review.id);
    }

    handle.prepare('UPDATE reviews SET published_revision_id = ? WHERE id = ?').run(revision.id, review.id);

    // 首次成功发布设置 first_published_at（再次发布不重置）；public_updated_at 每次都更新。
    if (entity.first_published_at === null) {
      handle
        .prepare('UPDATE content_entities SET first_published_at = ?, public_updated_at = ? WHERE id = ?')
        .run(now, now, entity.id);
    } else {
      handle.prepare('UPDATE content_entities SET public_updated_at = ? WHERE id = ?').run(now, entity.id);
    }

    handle
      .prepare(`UPDATE content_submissions SET processing_state = 'published', state_version = state_version + 1, updated_at = ? WHERE id = ?`)
      .run(now, submissionId);

    // 全文检索索引与"公开修订指针"在**同一个事务**里更新（迁移 0014）：
    // 少一边就会出现"搜得到但打不开"或"发布了却搜不到"。撤回/隐藏不删索引 ——
    // 检索层会逐行调 resolveVisibilityInTx，旧索引行不会泄露已下线的内容。
    reindexReviewInTx(handle, review.id);

    // 审计：发布是**系统动作**（worker 执行），不是某个人点的按钮。
    // actor_kind='system' 且 actor_user_id 为空；task_id 指回队列任务。
    // 这样"这篇是谁发的/为什么发"在 /admin/operations 里能查到，且与人工操作区分得开。
    recordOperationInTx(
      handle,
      {
        actionType: 'review.publish',
        operationKey: `review_publish:${submissionId}`,
        actorKind: 'system',
        actorUserId: null,
        targetType: 'content_entity',
        targetId: review.id,
        targetSnapshot: { submission_id: submissionId, revision_id: revision.id },
        changes: { published_revision_id: revision.id },
        reason: '系统发布：审核通过后由发布任务公开',
        taskId: options?.taskId ?? null,
      },
      now,
    );

    return {
      published: true,
      reviewId: review.id,
      revisionId: revision.id,
      publishedAt: now,
    };
  }, db);
}
