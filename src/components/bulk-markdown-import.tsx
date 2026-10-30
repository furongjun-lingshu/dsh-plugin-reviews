'use client';

/**
 * 批量导入多篇 `.md`：每份文件建一篇草稿（标题取首个 `# 标题` 或文件名）。
 *
 * 为什么在前端逐个建而不是做一个批量接口：
 *   - 草稿创建本身是**幂等**的（requestKey 去重），逐个调用失败只影响那一篇，
 *     不需要为「部分成功」再设计一套事务语义；
 *   - 进度天然可见：一篇一篇地显示成功/失败，作者知道哪篇没进来。
 *
 * 图片：作者从编辑器导出的一批 md 常带 images/ 文件夹，正文里是 `![](./images/a.png)`
 * 这类相对路径。这里提供两个入口（多选 .md / 选择文件夹），选中后一次拿到 md 与图片；
 * 图片按 md 所在目录匹配本地文件，逐张走草稿附件接口上传，再把引用替换成站内地址。
 * 匹配不到（含外链）的引用**保持原样**，不猜测、不删除；超大小 / 格式不支持 /
 * 超过每篇 20 张的图片跳过，并在结果里如实列出原因。
 */

import { useState, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  applyImageReplacements,
  buildImageIndex,
  collectImageRefs,
  isExternalImageUrl,
  resolveImageReference,
  stripCollectionRoot,
} from '@/packages/common/md-images';
import { ApiError, ErrorNotice, apiFetch, newRequestKey } from './api-client';

interface CreatedDraft {
  draftId: string;
  reviewId: string;
  saveVersion: number;
}

interface SaveResult {
  saveVersion: number;
  savedAt: number;
  replayed: boolean;
}

interface AttachmentView {
  attachmentId: string;
  processingState: 'pending' | 'processing' | 'ready' | 'failed';
  lastErrorCode: string | null;
  displayUrl: string | null;
}

interface ImportOutcome {
  filename: string;
  draftId: string | null;
  error: string | null;
  uploaded: number;
  unmatched: number;
  skipped: string[];
}

/** 与 review-editor.tsx 的 onUpload 同口径：服务端只收这三种格式、单张 10MB。 */
const ALLOWED_IMAGE_MIME: readonly string[] = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES_PER_DRAFT = 20;

const MARKDOWN_FILE_RE = /\.(md|markdown|txt)$/i;
const IMAGE_FILE_RE = /\.(png|jpe?g|webp|gif|bmp|svg|avif|heic|heif)$/i;

/** React 的 input 类型还没收录 webkitdirectory（Chromium 私有属性），用 spread 绕过。 */
const DIRECTORY_INPUT_PROPS = { webkitdirectory: '' } as Record<string, string>;

/** 从正文里取标题：第一个 Markdown 一级/二级标题；没有就用文件名（去扩展名）。 */
function titleOf(filename: string, markdown: string): string {
  const match = markdown.match(/^#{1,2}\s+(.+)$/m);
  if (match) return match[1].trim().slice(0, 80);
  return filename.replace(/\.(md|markdown|txt)$/i, '').slice(0, 80);
}

/** 把正文拆成编辑器认的分段（与编辑器内 toBodySegments 同口径：空行分段）。 */
function toBodySegments(markdown: string): { key: string; markdown: string }[] {
  return markdown.split(/\n{2,}/).map((text, index) => ({ key: `p${index}`, markdown: text }));
}

/** 文件的相对路径：目录选择给 webkitRelativePath；多选单文件时退回文件名。 */
function pathOf(file: File): string {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return relative !== undefined && relative !== '' ? relative : file.name;
}

/** 图片格式：优先用浏览器给的 MIME，拿不到时按扩展名补齐（发出去的 content-type 始终合法）。 */
function imageMimeOf(file: File): string | null {
  if (ALLOWED_IMAGE_MIME.includes(file.type)) return file.type;
  const ext = (/\.([a-z0-9]+)$/i.exec(file.name)?.[1] ?? '').toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return null;
}

/** 目录选择里会混进 html/css 等文件：只把看起来是图片的收进索引。 */
function looksLikeImage(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_FILE_RE.test(file.name);
}

/** 草稿附件上传（照抄 review-editor.tsx 的 onUpload：登记 → PUT 字节 → 就绪取 displayUrl）。 */
async function uploadImage(draftId: string, file: File, mime: string): Promise<string> {
  const registered = await apiFetch<AttachmentView>(`/api/drafts/${encodeURIComponent(draftId)}/attachments`, {
    method: 'POST',
    json: { originalFilename: file.name, usage: 'body' },
  });

  const ready = await apiFetch<AttachmentView>(
    `/api/attachments/${encodeURIComponent(registered.attachmentId)}/file`,
    {
      method: 'PUT',
      headers: { 'content-type': mime },
      body: file,
    },
  );

  if (ready.processingState === 'ready' && ready.displayUrl) return ready.displayUrl;
  if (ready.processingState === 'failed') {
    throw new Error(`图片处理失败${ready.lastErrorCode ? '（' + ready.lastErrorCode + '）' : ''}`);
  }
  // pending / processing 不是失败，但这一轮拿不到 displayUrl，只能保持原引用。
  throw new Error(`图片仍在处理中（${ready.processingState}）`);
}

export function BulkMarkdownImport({
  pluginId = null,
  /** 单个 .md 上限（字节）：来自后台 imports.max_markdown_bytes，默认 512KB。 */
  maxMarkdownBytes = 512 * 1024,
}: {
  pluginId?: string | null;
  maxMarkdownBytes?: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<ImportOutcome[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const saveDraft = async (draftId: string, expectedVersion: number, filename: string, markdown: string) =>
    apiFetch<SaveResult>('/api/drafts', {
      method: 'PUT',
      json: {
        draftId,
        requestKey: newRequestKey(),
        expectedVersion,
        title: titleOf(filename, markdown),
        pluginId,
        pluginVersion: { kind: 'unknown' },
        dshVersion: { kind: 'unknown' },
        body: toBodySegments(markdown),
        verdict: null,
        evidenceRefs: [],
        assessmentLevel: null,
      },
    });

  const onFiles = async (files: FileList) => {
    setBusy(true);
    setError(null);
    setOutcomes(null);
    const results: ImportOutcome[] = [];
    try {
      const all = Array.from(files);
      const markdowns = all.filter((file) => MARKDOWN_FILE_RE.test(file.name));
      const imageFiles = all.filter(looksLikeImage);

      if (markdowns.length === 0) {
        throw new ApiError({ code: 'input_invalid', message: '没有选中 .md 文件。' }, 400);
      }

      // 图片索引：按「去掉第一层目录的相对路径」+ basename 建两份键（见 md-images.ts）。
      const imageIndex = buildImageIndex(imageFiles.map((file) => ({ path: pathOf(file), name: file.name })));
      const filesByPath = new Map<string, File>();
      for (const file of imageFiles) {
        filesByPath.set(stripCollectionRoot(pathOf(file)).toLowerCase(), file);
      }

      for (const file of markdowns) {
        const filename = pathOf(file);
        let draftId: string | null = null;
        let uploaded = 0;
        let unmatched = 0;
        const skipped: string[] = [];
        try {
          if (file.size > maxMarkdownBytes) {
        throw new Error(`文件超过 ${Math.floor(maxMarkdownBytes / 1024)}KB`);
      }
          const text = await file.text();
          if (text.trim().length === 0) throw new Error('文件是空的');

          // 1) 建草稿（幂等：每篇一个新 requestKey）
          const draft = await apiFetch<CreatedDraft>('/api/drafts', {
            method: 'POST',
            json: { requestKey: newRequestKey(), pluginId },
          });
          draftId = draft.draftId;

          // 2) 先把标题与正文落库。之后即使图片上传失败，文章内容也不会丢。
          const firstSave = await saveDraft(draft.draftId, draft.saveVersion, file.name, text);

          // 3) 逐条引用匹配本地图片；同一张图只上传一次。
          const refs = collectImageRefs(text);
          const displayUrls = new Map<string, string>();
          const attempted = new Set<string>();

          for (const ref of refs) {
            if (isExternalImageUrl(ref.url)) continue;
            const localPath = resolveImageReference(ref.url, filename, imageIndex);
            if (localPath === null) {
              unmatched += 1;
              continue;
            }
            const key = localPath.toLowerCase();
            if (attempted.has(key)) continue;
            attempted.add(key);

            const imageFile = filesByPath.get(key);
            if (imageFile === undefined) {
              // 索引里有、文件表里没有：按未匹配处理，引用保持原样。
              unmatched += 1;
              continue;
            }
            if (uploaded >= MAX_IMAGES_PER_DRAFT) {
              skipped.push(imageFile.name + '：每篇最多 ' + MAX_IMAGES_PER_DRAFT + ' 张图片，已跳过');
              continue;
            }
            const mime = imageMimeOf(imageFile);
            if (mime === null) {
              skipped.push(
                imageFile.name + '：只支持 PNG / JPEG / WebP（当前 ' + (imageFile.type || '未知类型') + '）',
              );
              continue;
            }
            if (imageFile.size > MAX_IMAGE_BYTES) {
              skipped.push(
                imageFile.name + '：单张最多 10MB（当前 ' + (imageFile.size / 1024 / 1024).toFixed(1) + 'MB）',
              );
              continue;
            }

            try {
              displayUrls.set(localPath, await uploadImage(draft.draftId, imageFile, mime));
              uploaded += 1;
            } catch (e) {
              skipped.push(imageFile.name + '：' + (e instanceof Error ? e.message : '上传失败'));
            }
          }

          // 4) 有成功上传的图片才重写正文并再保存一次（expectedVersion 用新一轮回执）。
          const replacements = new Map<string, string>();
          for (const ref of refs) {
            if (isExternalImageUrl(ref.url)) continue;
            const localPath = resolveImageReference(ref.url, filename, imageIndex);
            if (localPath === null) continue;
            const displayUrl = displayUrls.get(localPath);
            if (displayUrl !== undefined) replacements.set(ref.url, displayUrl);
          }
          const rewritten = applyImageReplacements(text, replacements);
          if (rewritten.replaced > 0) {
            await saveDraft(draft.draftId, firstSave.saveVersion, file.name, rewritten.markdown);
          }

          results.push({
            filename,
            draftId: draft.draftId,
            error: null,
            uploaded,
            unmatched,
            skipped,
          });
        } catch (e) {
          results.push({
            filename,
            draftId,
            error: e instanceof Error ? e.message : '导入失败',
            uploaded,
            unmatched,
            skipped,
          });
        }
        setOutcomes([...results]);
      }
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) void onFiles(files);
    e.target.value = '';
  };

  const okCount = outcomes?.filter((o) => o.draftId !== null).length ?? 0;

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <label className="button file-button" style={{ cursor: busy ? 'default' : 'pointer' }}>
          <span>{busy ? '导入中…' : '选择文件夹导入（含图片）'}</span>
          <input
            type="file"
            multiple
            disabled={busy}
            style={{ display: 'none' }}
            {...DIRECTORY_INPUT_PROPS}
            onChange={onPick}
          />
        </label>
        <label className="button file-button" style={{ cursor: busy ? 'default' : 'pointer' }}>
          <span>批量导入 .md</span>
          <input
            type="file"
            multiple
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            disabled={busy}
            style={{ display: 'none' }}
            onChange={onPick}
          />
        </label>
      </div>
      <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
        每个文件生成一篇草稿（标题取首个 # 标题或文件名）。选择文件夹时会顺带匹配
        images/ 里的本地图片并上传；每篇最多 20 张、单张 ≤10MB、只支持 PNG / JPEG / WebP，
        未匹配到的引用保持原样。导入后仍需逐篇绑定插件再提交。
      </div>

      {outcomes !== null ? (
        <div className="panel" style={{ marginTop: 10 }}>
          <div className="list-meta">
            <span>
              共 {outcomes.length} 篇，成功 {okCount} 篇
              {outcomes.length - okCount > 0 ? '，失败 ' + (outcomes.length - okCount) + ' 篇' : ''}
            </span>
          </div>
          <ul style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 13 }}>
            {outcomes.map((o, index) => (
              <li key={index + '-' + o.filename}>
                {o.draftId ? (
                  <>
                    {o.filename} → 已建草稿 <a href={'/me/drafts/' + o.draftId}>打开编辑</a>
                    <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                      上传 {o.uploaded} 张图，{o.unmatched} 个引用未匹配
                      {o.skipped.length > 0 ? '；跳过 ' + o.skipped.length + ' 张：' + o.skipped.join('；') : ''}
                    </div>
                    {o.error ? (
                      <div style={{ color: 'var(--danger)', fontSize: 12 }}>{o.error}</div>
                    ) : null}
                  </>
                ) : (
                  <span style={{ color: 'var(--danger)' }}>
                    {o.filename}：{o.error}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </div>
  );
}
