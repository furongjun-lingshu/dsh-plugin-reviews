/** GET /api/imports/author/{batchId}：批次进度（已接收字节、条目状态）。 */

import { getDb } from '@/server/platform/db';
import { createAuthorImportService } from '@/server/modules/imports/author';
import { currentContext, okJson, errorResponse, requestMeta } from '../../../_lib/context';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ batchId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { batchId } = await params;
    const ctx = await currentContext();
    const service = createAuthorImportService({ db: getDb() });
    const view = await service.getBatch(ctx, batchId);
    return okJson(view, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
