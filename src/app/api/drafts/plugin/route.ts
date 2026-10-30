/**
 * 草稿 → 插件 绑定（草稿页「选择所对应的插件」用）。
 *
 * POST /api/drafts/plugin  { draftId, pluginId }
 *
 * 与 `PUT /api/drafts` 分开：保存是"写正文"，改绑是"换对象"。
 * 混进保存请求里会让一次保存悄悄改掉草稿的归属对象，出问题时说不清是哪一步改的。
 */

import { getDb } from '@/server/platform/db';
import { reviewsService } from '@/server/modules/reviews';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../_lib/context';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    const body = (await readJson(request)) as { draftId?: unknown; pluginId?: unknown };
    if (typeof body.draftId !== 'string' || body.draftId.trim() === '') {
      throw err.input('缺少草稿标识。', [{ path: 'draftId', message: '必填' }]);
    }
    if (typeof body.pluginId !== 'string' || body.pluginId.trim() === '') {
      throw err.input('缺少插件标识。', [{ path: 'pluginId', message: '必填' }]);
    }

    const result = await reviewsService.setDraftPlugin(
      ctx,
      { draftId: body.draftId, pluginId: body.pluginId },
      getDb(),
    );
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
