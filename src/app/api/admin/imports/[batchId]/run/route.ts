/**
 * 运行/重试一个导入批次。
 *
 * POST /api/admin/imports/{batchId}/run  { itemId? }
 *
 * 不带 itemId：按顺序处理 pending（受上游预算限制，跑不完的留到下一轮）。
 * 带 itemId：只重试那一条（失败条目单独重来，不重跑整批）。
 */

import { getDb } from '@/server/platform/db';
import { createImportService } from '@/server/modules/imports';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../../_lib/context';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ batchId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { batchId } = await params;
    const ctx = await currentContext();
    const body = (await readJson(request)) as { itemId?: unknown };

    const service = createImportService({ db: getDb() });
    const result = await service.runBatch(ctx, batchId, {
      itemId: typeof body.itemId === 'string' && body.itemId.trim() !== '' ? body.itemId : undefined,
    });
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
