/**
 * 作者修改已提交/已发布评测：创建（或复用）一份修改草稿。
 *
 * POST /api/reviews/{reviewId}/edit-draft
 * 返回 { draftId }，前端跳转到 /me/drafts/{draftId}。
 * 只有作者本人可以调用；已有未删除草稿时直接复用。
 */
import { getDb } from '@/server/platform/db';
import { reviewsService } from '@/server/modules/reviews';
import { currentContext, okJson, errorResponse, requestMeta } from '../../../_lib/context';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ reviewId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { reviewId } = await params;
    const ctx = await currentContext();
    const result = await reviewsService.createOrGetRevisionDraft(ctx, reviewId, getDb());
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
