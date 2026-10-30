/**
 * 管理员插件清单批量导入。
 *
 * POST /api/admin/imports  { manifest, mode: 'dry_run' | 'apply', requestKey }
 *
 * 只做参数形状校验；权限、解析、去重、审计全在 imports 模块里。
 */

import { getDb } from '@/server/platform/db';
import { createImportService } from '@/server/modules/imports';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../_lib/context';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    const body = (await readJson(request)) as { manifest?: unknown; mode?: unknown; requestKey?: unknown };

    if (typeof body.manifest !== 'string') {
      throw err.input('缺少清单内容。', [{ path: 'manifest', message: '必填' }]);
    }
    if (body.mode !== 'dry_run' && body.mode !== 'apply') {
      throw err.input('模式只能是预演或导入。', [{ path: 'mode', message: 'dry_run / apply' }]);
    }
    if (typeof body.requestKey !== 'string' || body.requestKey.trim() === '') {
      throw err.input('缺少请求标识。', [{ path: 'requestKey', message: '必填' }]);
    }

    const service = createImportService({ db: getDb() });
    const result = await service.createBatch(ctx, {
      manifest: body.manifest,
      mode: body.mode,
      requestKey: body.requestKey,
    });
    return okJson(result, requestId, 201);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
