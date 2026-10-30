/** POST /api/imports/author/{batchId}/finalize：把已就绪的 Markdown 变成草稿。 */

import { getDb } from '@/server/platform/db';
import { createAuthorImportService } from '@/server/modules/imports/author';
import { currentContext, okJson, errorResponse, requestMeta } from '../../../../_lib/context';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ batchId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { batchId } = await params;
    const ctx = await currentContext();
    const service = createAuthorImportService({ db: getDb() });
    const result = await service.finalizeBatch(ctx, batchId);
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
