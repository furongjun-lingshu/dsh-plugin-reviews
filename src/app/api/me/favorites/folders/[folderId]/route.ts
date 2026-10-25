/**
 * 收藏夹改名 / 删除。
 *
 * PATCH  /api/me/favorites/folders/{folderId} → { name }
 * DELETE /api/me/favorites/folders/{folderId} → 夹内收藏移到默认夹后删夹
 */
import { getDb } from '@/server/platform/db';
import { createInteractionsService } from '@/server/modules/interactions';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../../_lib/context';

export const runtime = 'nodejs';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ folderId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { folderId } = await params;
    const ctx = await currentContext();
    const body = (await readJson(request)) as { name?: unknown };
    if (typeof body.name !== 'string') {
      throw err.input('缺少收藏夹名称。', [{ path: 'name', message: '必填' }]);
    }
    const service = createInteractionsService({ db: getDb() });
    const result = await service.renameFavoriteFolder(ctx, folderId, body.name);
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ folderId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { folderId } = await params;
    const ctx = await currentContext();
    const service = createInteractionsService({ db: getDb() });
    const result = await service.deleteFavoriteFolder(ctx, folderId);
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
