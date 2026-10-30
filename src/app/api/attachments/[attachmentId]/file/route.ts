/**
 * 附件字节接收（架构第 70 节）。
 *
 * PUT /api/attachments/{attachmentId}/file
 *
 * 整文件接收：边收边限大小，超限立刻中止，不把整个大文件先读进内存。
 * 「收到字节」≠「可以引用」：本例返回的是处理后的真实状态（ready / failed）。
 */

import { createMediaService, MEDIA_LIMITS } from '@/server/modules/media';
import { getDb } from '@/server/platform/db';
import { err } from '@/packages/common/errors';
import { getDb as getDatabase } from '@/server/platform/db';
import { numberSetting } from '@/server/modules/settings';
import { currentContext, okJson, errorResponse, requestMeta } from '../../../_lib/context';

export const runtime = 'nodejs';

async function readBodyWithinLimit(request: Request, maxBytes: number): Promise<Buffer> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) {
      throw err.input(`单张图片最多 ${Math.floor(maxBytes / 1024 / 1024)}MB。`, [
        { path: 'file', message: '超出单张大小限制' },
      ]);
    }
  }

  const body = request.body;
  if (!body) throw err.input('请求体为空。', [{ path: 'file', message: '没有收到文件内容' }]);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw err.input(`单张图片最多 ${Math.floor(maxBytes / 1024 / 1024)}MB，当前上传已超限。`, [
          { path: 'file', message: '超出单张大小限制' },
        ]);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  if (total === 0) throw err.input('没有收到文件内容。', [{ path: 'file', message: '文件为空' }]);
  return Buffer.concat(chunks.map((c) => Buffer.from(c)), total);
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ attachmentId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { attachmentId } = await params;
    const ctx = await currentContext();
    // 上限可后台调整（media.max_image_bytes），但永不超过内置硬上限：配置再大也不放开 10MB。
    const maxBytes = Math.min(
      numberSetting(getDatabase(), 'media.max_image_bytes', MEDIA_LIMITS.maxBytes),
      MEDIA_LIMITS.maxBytes,
    );
    const bytes = await readBodyWithinLimit(request, maxBytes);

    // 用途与草稿由前端带上（封面图需要落到 draft_attachment_links）：缺省按正文图处理。
    const url = new URL(request.url);
    const usage = url.searchParams.get('usage') === 'cover' ? 'cover' : 'body';
    const draftId = url.searchParams.get('draftId') ?? undefined;

    const media = createMediaService({ db: getDb() });
    const ready = await media.receiveFile(ctx, { attachmentId, bytes, usage, draftId });
    return okJson(ready, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
