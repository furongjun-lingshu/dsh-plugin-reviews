/**
 * 收藏夹列表 / 新建。
 *
 * GET  /api/me/favorites/folders → 当前用户全部收藏夹（含计数；首次访问懒建默认夹）
 * POST /api/me/favorites/folders → { name } 新建收藏夹（重名拒绝）
 */
import { getDb } from '@/server/platform/db';
import { createInteractionsService } from '@/server/modules/interactions';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../_lib/context';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    const service = createInteractionsService({ db: getDb() });
    const folders =
      ctx.userId === null ? [] : await service.listFavoriteFolders(ctx);
    return okJson({ folders, authenticated: ctx.userId !== null }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    const body = (await readJson(request)) as { name?: unknown };
    if (typeof body.name !== 'string') {
      throw err.input('缺少收藏夹名称。', [{ path: 'name', message: '必填' }]);
    }
    const service = createInteractionsService({ db: getDb() });
    const folder = await service.createFavoriteFolder(ctx, body.name);
    return okJson(folder, requestId, 201);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
