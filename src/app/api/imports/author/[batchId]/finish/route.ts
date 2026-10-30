/** POST /api/imports/author/{batchId}/finish  { inputId, attemptId }：校验摘要并置 ready。 */

import { getDb } from '@/server/platform/db';
import { createAuthorImportService } from '@/server/modules/imports/author';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../../_lib/context';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ batchId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { batchId } = await params;
    void batchId;
    const ctx = await currentContext();
    const body = (await readJson(request)) as { inputId?: unknown; attemptId?: unknown };
    if (typeof body.inputId !== 'string' || body.inputId.trim() === '') {
      throw err.input('缺少文件标识。', [{ path: 'inputId', message: '必填' }]);
    }
    if (typeof body.attemptId !== 'string' || body.attemptId.trim() === '') {
      throw err.input('缺少上传尝试标识。', [{ path: 'attemptId', message: '必填' }]);
    }

    const service = createAuthorImportService({ db: getDb() });
    const result = await service.finishInput(ctx, { inputId: body.inputId, attemptId: body.attemptId });
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
