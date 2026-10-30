/**
 * 本人偏好（迁移 0030）。
 *
 * GET   /api/me/preferences  → 与默认值合并后的完整偏好
 * PATCH /api/me/preferences  { editorAutosaveSeconds }  → 局部更新
 *
 * 只做形状与来源校验；取值白名单在模块里（`AUTOSAVE_SECONDS_OPTIONS`），
 * 路由不复制一份规则，避免两处白名单漂移。
 */

import { getDb } from '@/server/platform/db';
import { err } from '@/packages/common/errors';
import { getUserPreferences, writePreferences } from '@/server/modules/preferences';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../_lib/context';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    return okJson(getUserPreferences(ctx, getDb()), requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    const body = (await readJson(request)) as { editorAutosaveSeconds?: unknown };

    if (body.editorAutosaveSeconds === undefined) {
      throw err.input('缺少要保存的字段。', [
        { path: 'editorAutosaveSeconds', message: '至少提供自动保存间隔' },
      ]);
    }

    const next = writePreferences(ctx, { editorAutosaveSeconds: body.editorAutosaveSeconds as number }, getDb());
    return okJson(next, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
