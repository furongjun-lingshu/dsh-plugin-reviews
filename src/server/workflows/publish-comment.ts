/**
 * 评论发布流程（架构第 34.1、56、57 节；与 publish-review.ts 同构）。
 *
 * 为什么单独存在：评论发布最初写在 `src/worker/handlers.ts` 里（worker 层）。
 * 那段实现是**先读后写、读在事务外**，于是存在一个真实竞态：
 * 资格核验与写入之间若有并发删除/撤回，已删除的评论仍会被公开。
 * `publishReview` 用「在事务内重新核验」避免这类问题（架构第 57 节），
 * 评论必须遵守同一条规矩 —— 否则同一不变式有两份实现，迟早漂移。
 *
 * 不变式（全部在事务内重新核验，不依赖调用方此前的判断）：
 *  1. 提交处于 `approved`；
 *  2. 提交是评论修订、且快照存在、且属于该评论；
 *  3. 评论未被删除；
 *  4. 该提交仍是评论的最新提交（未被更新的提交取代）。
 */

import { withTransaction, type Tx } from '@/server/platform/tx';
import { nowMs } from '@/server/platform/time';
import { recordOperationInTx } from '@/server/modules/operations';
import { log } from '@/server/platform/log';
import type { SqliteDatabase } from '@/server/platform/db';
import { getDb } from '@/server/platform/db';
import { err } from '@/packages/common/errors';
import type { SubmissionState } from '@/packages/common/field-rules';
import { deliverCommentNotification } from '@/server/modules/notifications';

export type CommentPublishReason =
  | 'submission_not_approved'
  | 'already_published'
  | 'submission_type_mismatch'
  | 'revision_missing'
  | 'comment_deleted'
  | 'comment_missing'
  | 'superseded';

export interface CommentPublishOutcome {
  published: boolean;
  reason?: CommentPublishReason;
  commentId?: string;
  revisionId?: string;
  publishedAt?: number;
}

interface SubmissionRow {
  id: string;
  submission_type: string;
  processing_state: SubmissionState;
  comment_revision_id: string | null;
}

/**
 * 执行一次评论发布。
 *
 * 与 `publishReview` 一致：`published` 表示"该提交完成了发布"，
 * **不代表内容当前仍公开** —— 后续删除由可见性解析另行判断。
 */
export function publishComment(
  submissionId: string,
  db: SqliteDatabase = getDb(),
  /** 触发这次发布的队列任务（写进审计的 task_id）。 */
  options?: { taskId?: string | null },
): CommentPublishOutcome {
  return withTransaction((tx: Tx) => {
    const handle = tx.db;
    const now = nowMs();

    const submission = handle
      .prepare('SELECT id, submission_type, processing_state, comment_revision_id FROM content_submissions WHERE id = ?')
      .get(submissionId) as SubmissionRow | undefined;

    if (!submission) throw err.unavailable('提交不存在。');
    if (submission.submission_type !== 'comment_revision') {
      return { published: false, reason: 'submission_type_mismatch' as const };
    }
    if (submission.processing_state === 'published') {
      return { published: false, reason: 'already_published' as const };
    }
    if (submission.processing_state !== 'approved') {
      // 未通过检查绝不发布；也不改写状态。
      return { published: false, reason: 'submission_not_approved' as const };
    }
    if (!submission.comment_revision_id) {
      return { published: false, reason: 'revision_missing' as const };
    }

    const revision = handle
      .prepare('SELECT id, comment_id FROM comment_revisions WHERE id = ?')
      .get(submission.comment_revision_id) as { id: string; comment_id: string } | undefined;
    if (!revision) return { published: false, reason: 'revision_missing' as const };

    const comment = handle
      .prepare(
        `SELECT id, content_entity_id, author_id, reply_to_comment_id, deleted_at,
                published_revision_id, latest_submitted_revision_id
           FROM comments WHERE id = ?`,
      )
      .get(revision.comment_id) as
      | {
          id: string;
          content_entity_id: string;
          author_id: string;
          reply_to_comment_id: string | null;
          deleted_at: number | null;
          published_revision_id: string | null;
          latest_submitted_revision_id: string | null;
        }
      | undefined;
    if (!comment) return { published: false, reason: 'comment_missing' as const };

    // 已删除的评论不得被旧任务重新公开（与评测的 withdrawn/hidden 同理）。
    if (comment.deleted_at !== null) {
      return { published: false, reason: 'comment_deleted' as const };
    }

    // 「被更新的提交取代」检查 —— 支持编辑评论之后**才能**加回这一条（原注释里写明的约束）。
    // 现在 `editComment` 会维护 `latest_submitted_revision_id`，所以旧修订的发布任务
    // 不会把用户新写的版本覆盖回旧正文。
    if (comment.latest_submitted_revision_id !== null && comment.latest_submitted_revision_id !== revision.id) {
      return { published: false, reason: 'superseded' as const };
    }

    // 这次发布是"首次公开"还是"编辑后替换"：决定要不要写 edited_at（页面据此显示"已编辑"）。
    const isEdit = comment.published_revision_id !== null;

    handle.prepare('UPDATE comments SET published_revision_id = ? WHERE id = ?').run(revision.id, comment.id);

    // 首次发布设置 first_published_at；**再次发布不重置**（用 COALESCE 表达，
    // 不必先读出来再分支 —— 少一次读、也不受读到的值是否过时影响）。
    handle
      .prepare('UPDATE comments SET first_published_at = COALESCE(first_published_at, ?) WHERE id = ?')
      .run(now, comment.id);

    // 编辑后替换：记下"最后修改时间"。同样只在首次置位之外单独写，不改动首次语义。
    if (isEdit) {
      handle.prepare('UPDATE comments SET edited_at = ? WHERE id = ?').run(now, comment.id);
    }

    // 站内通知：只在**评论公开的那一刻**投递（`idea.md §11`）。编辑不会重复通知
    // （去重键按评论而不是修订，见 notifications 模块）。
    const delivered = deliverCommentNotification(handle, {
      commentId: comment.id,
      contentEntityId: comment.content_entity_id,
      actorId: comment.author_id,
      replyToCommentId: comment.reply_to_comment_id,
      now,
    });
    if (!delivered.created && delivered.reason !== 'self' && delivered.reason !== 'duplicate') {
      log.warn('通知未投递', { comment_id: comment.id, reason: delivered.reason });
    }

    handle
      .prepare(`UPDATE content_submissions SET processing_state = 'published', state_version = state_version + 1, updated_at = ? WHERE id = ?`)
      .run(now, submissionId);

    // 审计：评论公开同样是系统动作（worker 执行），与人工操作区分。
    recordOperationInTx(
      handle,
      {
        actionType: 'comment.publish',
        operationKey: `comment_publish:${submissionId}`,
        actorKind: 'system',
        actorUserId: null,
        targetType: 'comment',
        targetId: comment.id,
        targetSnapshot: { submission_id: submissionId, revision_id: revision.id, is_edit: isEdit },
        changes: { published_revision_id: revision.id },
        reason: isEdit ? '系统发布：编辑后的评论替换公开修订' : '系统发布：审核通过后由发布任务公开',
        taskId: options?.taskId ?? null,
      },
      now,
    );

    return {
      published: true,
      commentId: comment.id,
      revisionId: revision.id,
      publishedAt: now,
    };
  }, db);
}
