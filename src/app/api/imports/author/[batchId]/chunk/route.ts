/**
 * 续传一片。
 *
 * POST /api/imports/author/{batchId}/chunk  { inputId, attemptId?, offset, base64 }
 *
 * 为什么用 base64 而不是 multipart：这一片是**追加**到某个 offset 的，
 * base64 让"位置"与"内容"在同一个 JSON 里原子到达；multipart 还要再解析一层边界。
 * 8MB 的 base64 大约 10.7MB 文本，仍在单请求可接受范围内。
 */

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
    const body = (await readJson(request)) as {
      inputId?: unknown;
      attemptId?: unknown;
      offset?: unknown;
      base64?: unknown;
    };

    if (typeof body.inputId !== 'string' || body.inputId.trim() === '') {
      throw err.input('缺少文件标识。', [{ path: 'inputId', message: '必填' }]);
    }
    if (typeof body.offset !== 'number' || !Number.isInteger(body.offset) || body.offset < 0) {
      throw err.input('续传位置不合法。', [{ path: 'offset', message: '非负整数' }]);
    }
    if (typeof body.base64 !== 'string' || body.base64.length === 0) {
      throw err.input('缺少分片内容。', [{ path: 'base64', message: '必填' }]);
    }

    const service = createAuthorImportService({ db: getDb() });
    const result = await service.uploadChunk(ctx, {
      inputId: body.inputId,
      attemptId: typeof body.attemptId === 'string' && body.attemptId.trim() !== '' ? body.attemptId : undefined,
      offset: body.offset,
      bytes: Buffer.from(body.base64, 'base64'),
    });
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
