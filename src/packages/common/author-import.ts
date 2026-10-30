/**
 * 作者文件夹导入的**纯函数**（客户端切分与服务端校验共用，避免两份口径漂移）。
 *
 * 这里只放"不碰 IO、不碰数据库"的逻辑：判断哪些是 .md、哪些是图片、
 * 路径怎么规范化、引用怎么解析。上传/草稿/附件那些留给服务端模块。
 */

/** 与前端选择目录得到的 webkitRelativePath 对齐：统一斜杠、去掉首层目录名。 */
export function normalizeImportPath(raw: string): string {
  const normalized = String(raw ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  const slash = normalized.indexOf('/');
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

export const MARKDOWN_FILE_RE = /\.(md|markdown|txt)$/i;
export const IMAGE_FILE_RE = /\.(png|jpe?g|webp)$/i;

export function isMarkdownFile(path: string): boolean {
  return MARKDOWN_FILE_RE.test(path);
}

export function isImageFile(path: string): boolean {
  return IMAGE_FILE_RE.test(path);
}

/** 浏览器端分片大小（与服务端 UPLOAD_LIMITS.maxChunkBytes 对齐）。 */
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
