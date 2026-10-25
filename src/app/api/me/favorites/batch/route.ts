/**
 * 收藏夹内插件的批量操作。
 *
 * POST /api/me/favorites/batch
 * body: { action: 'remove' | 'move', pluginIds: string[], folderId?: string }
 */
import { getDb } from '@/server/platform/db';
import { createInteractionsService } from '@/server/modules/interactions';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../_lib/context';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    const body = (await readJson(request)) as {
      action?: unknown;
      pluginIds?: unknown;
      folderId?: unknown;
    };
    if (body.action !== 'remove' && body.action !== 'move') {
      throw err.input('批量操作类型不合法。', [{ path: 'action', message: 'remove | move' }]);
    }
    if (!Array.isArray(body.pluginIds) || body.pluginIds.some((id) => typeof id !== 'string')) {
      throw err.input('pluginIds 必须是字符串数组。', [{ path: 'pluginIds', message: '类型不正确' }]);
    }
    const service = createInteractionsService({ db: getDb() });
    const result = await service.batchFavoriteAction(ctx, {
      action: body.action,
      pluginIds: body.pluginIds as string[],
      folderId: typeof body.folderId === 'string' ? body.folderId : null,
    });
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
