/**
 * 收藏（`idea.md §15`）：GET 我的收藏，POST 切换（登录）。
 *
 * P1 只支持**插件**收藏；整合包收藏等 `plugin_packs` 建好后（P4）再开，
 * 现在传 kind='pack' 会明确报"暂不支持"，而不是静默成功。
 */

import { getDb } from '@/server/platform/db';
import { assertCanWrite } from '@/server/platform/context';
import { createInteractionsService } from '@/server/modules/interactions';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../_lib/context';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    const service = createInteractionsService({ db: getDb() });
    const folders = ctx.userId === null ? [] : await service.listFavoriteFolders(ctx);
    const plugins = ctx.userId === null ? [] : await service.listFavoritePlugins(ctx);
    return okJson({ folders, plugins, authenticated: ctx.userId !== null }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

/** 取消收藏：DELETE /api/me/favorites?pluginId=... */
export async function DELETE(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    assertCanWrite(ctx);
    const pluginId = new URL(request.url).searchParams.get('pluginId');
    if (!pluginId) throw err.input('缺少 pluginId。', [{ path: 'pluginId', message: '必填' }]);
    const service = createInteractionsService({ db: getDb() });
    const result = await service.removeFavorite(ctx, pluginId);
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    assertCanWrite(ctx);
    const body = (await readJson(request)) as {
      kind?: unknown;
      targetId?: unknown;
      folderId?: unknown;
    };
    if ((body.kind !== 'plugin' && body.kind !== 'pack') || typeof body.targetId !== 'string') {
      throw err.input('缺少收藏目标。', [
        { path: 'kind', message: '必须是 plugin 或 pack' },
        { path: 'targetId', message: '必填' },
      ]);
    }
    if (body.kind === 'pack') {
      throw err.input('整合包收藏将在整合包上线后开放。', [{ path: 'kind', message: '暂不支持' }]);
    }
    const service = createInteractionsService({ db: getDb() });
    if (typeof body.folderId === 'string' && body.folderId.length > 0) {
      const result = await service.setFavorite(ctx, {
        pluginId: body.targetId,
        folderId: body.folderId,
      });
      return okJson(result, requestId);
    }
    // 兼容旧调用（没有 folderId）：切到默认夹 / 取消。
    const result = await service.toggleFavorite(ctx, { kind: body.kind, targetId: body.targetId });
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
