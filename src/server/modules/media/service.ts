/**
 * 媒体模块：附件登记、接收字节、真实格式鉴定、展示图生成、就绪判定。
 *
 * 铁律（需求第 6 节 / 架构第 10 节）：
 *  1. **真实格式以图片内容判定**，不看 Content-Type 声明、不看文件扩展名；
 *  2. 「收到字节」≠「可以引用」：必须鉴图成功 + 展示图生成 + **本地落盘回读校验通过**才 ready；
 *  3. 落盘失败/校验不符 → failed 并记录原因，**绝不把坏文件标成就绪**；
 *  4. storage_key 由服务端生成，不接受任何用户输入参与路径。
 */

import sharp from 'sharp';
import type { Metadata as SharpMetadata } from 'sharp';
import type { SqliteDatabase } from '@/server/platform/db';
import { getDb } from '@/server/platform/db';
import { withRead, withTransaction, type Tx } from '@/server/platform/tx';
import { nowMs } from '@/server/platform/time';
import { newId } from '@/server/platform/id';
import { err } from '@/packages/common/errors';
import { numberSetting } from '@/server/modules/settings';
import type { CallerContext } from '@/server/platform/context';
import { assertCanWrite } from '@/server/platform/context';
import {
  createLocalFileStore,
  defaultMediaRoot,
  sha256Hex,
  type FileStore,
} from '@/server/platform/file-store';
import type { PageRequest, PageResult } from '@/packages/common/result';

// ============================================================
// 参数（可配置项的当前常量：需求第 6.2 节的 JPG/PNG/WebP / 10MB / 每篇 20 张）
// ============================================================

export const MEDIA_LIMITS = {
  /** 允许的格式：只能配置为已实现解析器的类型。 */
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'] as const,
  /** 单张最大字节数（10 MiB）。 */
  maxBytes: 10 * 1024 * 1024,
  /**
   * 解码后像素上限（4000 万，约 8000×5000）。
   * 压缩后字节数小、解码后像素极大的「解压炸弹」会吃满内存（sharp 默认上限约
   * 2.68 亿像素 ≈ 数百 MB~1 GB），因此在字节闸之外再加一道像素闸：
   * metadata 读出宽高后显式比较，解码调用也带 limitInputPixels（双保险）。
   */
  maxPixels: 40_000_000,
  /** 每篇评测最多图片数（含封面）。 */
  maxPerReview: 20,
  /** 展示图长边上限。 */
  displayMaxEdge: 1280,
} as const;

export type AllowedMime = (typeof MEDIA_LIMITS.allowedMimeTypes)[number];

/** 明确的上传失败原因（不把原因糊成一句"上传失败"）。 */
export type MediaErrorCode =
  | 'too_many_pixels'
  | 'unsupported_format'
  | 'too_large'
  | 'empty_file'
  | 'decode_failed'
  | 'storage_error'
  | 'not_ready'
  | 'forbidden';

// ============================================================
// 视图
// ============================================================

export interface AttachmentView {
  attachmentId: string;
  processingState: 'pending' | 'processing' | 'ready' | 'failed';
  lastErrorCode: string | null;
  originalFilename: string;
  createdAt: number;
  readyAt: number | null;
  /** 就绪后可引用；未就绪为 null。 */
  displayFileId: string | null;
  /** 固定站内地址（不绑定存储源域名）。 */
  displayUrl: string | null;
  width: number | null;
  height: number | null;
}

interface AttachmentRow {
  id: string;
  uploaded_by: string;
  original_filename: string;
  processing_state: 'pending' | 'processing' | 'ready' | 'failed';
  last_error_code: string | null;
  created_at: number;
  ready_at: number | null;
}

interface FileRow {
  id: string;
  attachment_id: string;
  variant_key: string;
  variant_role: 'original' | 'display';
  mime_type: AllowedMime;
  byte_size: number;
  width: number;
  height: number;
  content_hash: string;
  processing_state: 'pending' | 'ready' | 'failed';
}

// ============================================================
// 真实格式鉴定
// ============================================================

/**
 * 用图片解码器判定真实格式与尺寸。
 * 这不是"读文件头"——sharp 会真正解析图片结构，伪装成 PNG 的文本会在这一步失败。
 */
export async function probeImage(bytes: Buffer): Promise<
  | { ok: true; mime: AllowedMime; width: number; height: number }
  | { ok: false; code: MediaErrorCode; detail: string }
> {
  if (bytes.byteLength === 0) {
    return { ok: false, code: 'empty_file', detail: '文件内容为空。' };
  }
  if (bytes.byteLength > MEDIA_LIMITS.maxBytes) {
    return {
      ok: false,
      code: 'too_large',
      detail: `单张图片最多 ${Math.floor(MEDIA_LIMITS.maxBytes / 1024 / 1024)}MB，当前 ${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB。`,
    };
  }

  let meta: SharpMetadata;
  try {
    meta = await sharp(bytes, { failOn: 'error', limitInputPixels: MEDIA_LIMITS.maxPixels }).metadata();
  } catch (e) {
    // 解码器自身也有像素上限（sharp 默认约 2.68 亿）：超限与「不是图片」要分开报，
    // 否则用户上传超大图只会看到「无法解析」。
    if (e instanceof Error && /pixel limit/i.test(e.message)) {
      return {
        ok: false,
        code: 'too_many_pixels',
        detail: `图片像素数超过上限（${MEDIA_LIMITS.maxPixels} 像素，约 8000×5000）。`,
      };
    }
    return { ok: false, code: 'decode_failed', detail: '无法解析为图片（文件可能损坏或不是图片）。' };
  }

  const format = meta.format;
  const mime: AllowedMime | null =
    format === 'jpeg' ? 'image/jpeg' : format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : null;

  if (!mime) {
    return {
      ok: false,
      code: 'unsupported_format',
      detail: `只支持 JPG、PNG、WebP，实际格式为 ${format ?? '未知'}。`,
    };
  }
  if (!meta.width || !meta.height) {
    return { ok: false, code: 'decode_failed', detail: '无法读取图片尺寸。' };
  }

  // 显式像素闸：不同 sharp/libvips 版本对 metadata() 的 limitInputPixels 行为不一致，
  // 这里用解码前元数据再判一次（fail-closed），不依赖解码器版本。
  if (meta.width * meta.height > MEDIA_LIMITS.maxPixels) {
    return {
      ok: false,
      code: 'too_many_pixels',
      detail: `图片像素数 ${meta.width}×${meta.height} 超过上限 ${MEDIA_LIMITS.maxPixels} 像素（约 8000×5000）。`,
    };
  }

  return { ok: true, mime, width: meta.width, height: meta.height };
}

/** 生成展示图：长边不超过 displayMaxEdge，保持原格式；已经足够小则原样返回标记。 */
export async function buildDisplayImage(
  bytes: Buffer,
  mime: AllowedMime,
): Promise<{ bytes: Buffer; mime: AllowedMime; width: number; height: number; resized: boolean }> {
  const meta = await sharp(bytes, { failOn: 'error', limitInputPixels: MEDIA_LIMITS.maxPixels }).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const longest = Math.max(width, height);
  const needsResize = longest > MEDIA_LIMITS.displayMaxEdge;

  if (!needsResize) {
    return { bytes, mime, width, height, resized: false };
  }

  const pipeline = sharp(bytes, { failOn: 'error', limitInputPixels: MEDIA_LIMITS.maxPixels }).resize({
    width: width >= height ? MEDIA_LIMITS.displayMaxEdge : undefined,
    height: height > width ? MEDIA_LIMITS.displayMaxEdge : undefined,
    withoutEnlargement: true,
  });

  // 保持原格式编码（PNG 用无损，JPEG/WebP 用较高质量，避免展示图糊掉）
  const out =
    mime === 'image/png'
      ? await pipeline.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })
      : mime === 'image/webp'
        ? await pipeline.webp({ quality: 82 }).toBuffer({ resolveWithObject: true })
        : await pipeline.jpeg({ quality: 82, mozjpeg: true }).toBuffer({ resolveWithObject: true });

  return { bytes: out.data, mime, width: out.info.width, height: out.info.height, resized: true };
}

/** 服务端生成的存储键：只由服务端 ID 与固定变体名构成。 */
export function storageKeyFor(attachmentId: string, variantKey: string): string {
  return `attachments/${attachmentId}/${variantKey}`;
}

/** 固定站内资源地址（不保存会过期的厂商链接）。 */
export function mediaUrl(attachmentId: string, variantKey: string): string {
  return `/media/${attachmentId}/${variantKey}`;
}

// ============================================================
// 服务
// ============================================================

export interface MediaServiceDeps {
  db: SqliteDatabase;
  store?: FileStore;
}

export interface MediaService {
  /** 登记一次上传（先有附件身份，再有字节）。 */
  createAttachment(
    ctx: CallerContext,
    input: { draftId: string; originalFilename: string; usage: 'body' | 'cover' },
  ): Promise<AttachmentView>;
  /** 接收完整字节：鉴图 → 生成展示图 → 落盘 → 置 ready。 */
  receiveFile(
    ctx: CallerContext,
    input: {
      attachmentId: string;
      bytes: Buffer;
      /** 这张图在草稿里的用途（默认正文）；封面图会被记进 draft_attachment_links。 */
      usage?: 'body' | 'cover';
      /** 用途为封面时必须给出草稿：就绪后建立「草稿 × 文件 × cover」引用。 */
      draftId?: string;
    },
  ): Promise<AttachmentView>;
  /** 读取本人有权查看的附件状态。 */
  getAttachment(ctx: CallerContext, attachmentId: string): Promise<AttachmentView>;
  /** 解析公开读取：只有公开内容引用（或本人草稿引用）才允许返回字节。 */
  resolveReadable(
    input: { attachmentId: string; variantKey: string },
    viewer: CallerContext,
  ): Promise<{ bytes: Buffer; mime: string } | null>;
}

function toView(row: AttachmentRow, file: FileRow | null): AttachmentView {
  const ready = row.processing_state === 'ready' && file !== null;
  return {
    attachmentId: row.id,
    processingState: row.processing_state,
    lastErrorCode: row.last_error_code,
    originalFilename: row.original_filename,
    createdAt: row.created_at,
    readyAt: row.ready_at,
    displayFileId: ready ? file.id : null,
    displayUrl: ready ? mediaUrl(row.id, file.variant_key) : null,
    width: ready ? file.width : null,
    height: ready ? file.height : null,
  };
}

function readAttachment(db: SqliteDatabase, attachmentId: string): AttachmentRow {
  const row = db
    .prepare(
      `SELECT id, uploaded_by, original_filename, processing_state, last_error_code, created_at, ready_at
         FROM attachments WHERE id = ?`,
    )
    .get(attachmentId) as AttachmentRow | undefined;
  if (!row) throw err.unavailable('附件不存在或不可访问。');
  return row;
}

function readDisplayFile(db: SqliteDatabase, attachmentId: string): FileRow | null {
  const row = db
    .prepare(
      `SELECT id, attachment_id, variant_key, variant_role, mime_type, byte_size, width, height,
              content_hash, processing_state
         FROM attachment_files
        WHERE attachment_id = ? AND variant_role = 'display' AND processing_state = 'ready'`,
    )
    .get(attachmentId) as FileRow | undefined;
  return row ?? null;
}

export function createMediaService(deps: MediaServiceDeps): MediaService {
  const db = deps.db;
  const store: FileStore = deps.store ?? createLocalFileStore({ root: defaultMediaRoot() });

  return {
    async createAttachment(ctx, input) {
      assertCanWrite(ctx);
      const userId = ctx.userId;

      if (typeof input.originalFilename !== 'string' || input.originalFilename.trim().length === 0) {
        throw err.input('缺少文件名。', [{ path: 'originalFilename', message: '必填' }]);
      }
      if (input.usage !== 'body' && input.usage !== 'cover') {
        throw err.input('用途只能是正文图片或封面。', [{ path: 'usage', message: '取值不合法' }]);
      }

      return withTransaction((tx: Tx) => {
        // 草稿必须属于本人：不能把附件挂到别人的草稿上。
        const draft = tx.db
          .prepare('SELECT id, owner_id FROM content_drafts WHERE id = ?')
          .get(input.draftId) as { id: string; owner_id: string } | undefined;
        if (!draft) throw err.unavailable('草稿不存在或不可访问。');
        if (draft.owner_id !== userId) throw err.forbidden('只能向自己的草稿上传图片。');

        // 每篇限额（含封面）：超限明确说原因，不静默截断。
        const used = (
          tx.db
            .prepare(
              `SELECT count(DISTINCT a.id) AS c
                 FROM attachments a
                 JOIN content_drafts d ON d.id = ?
                WHERE a.uploaded_by = ? AND a.processing_state <> 'failed'
                  AND a.created_at >= d.created_at`,
            )
            .get(input.draftId, userId) as { c: number }
        ).c;
        // 上限可后台调整（media.max_images_per_review），但永不超过内置硬上限。
        const maxPerReview = Math.min(
          numberSetting(db, 'media.max_images_per_review', MEDIA_LIMITS.maxPerReview),
          MEDIA_LIMITS.maxPerReview,
        );
        if (used >= maxPerReview) {
          throw err.input(`每篇评测最多 ${maxPerReview} 张图片（含封面），当前已有 ${used} 张。`, [
            { path: 'usage', message: '超出每篇图片数量限制' },
          ]);
        }

        const id = newId();
        const now = nowMs();
        tx.db
          .prepare(
            `INSERT INTO attachments (id, uploaded_by, original_filename, processing_state, created_at)
             VALUES (?, ?, ?, 'pending', ?)`,
          )
          .run(id, userId, input.originalFilename.trim(), now);

        // 登记引用：编辑期的"这张图在当前草稿里作什么用"。
        // 先建引用需要一个 file_id；文件尚未产生，因此引用在接收成功后建立（见 receiveFile）。
        void input.usage;

        const row = readAttachment(tx.db, id);
        return toView(row, null);
      }, db);
    },

    async receiveFile(ctx, input) {
      assertCanWrite(ctx);
      const userId = ctx.userId;
      const usage: 'body' | 'cover' = input.usage === 'cover' ? 'cover' : 'body';

      // ---- 事务 1：校验归属与当前状态，标记 processing ----
      const pre = withTransaction((tx: Tx) => {
        const row = readAttachment(tx.db, input.attachmentId);
        if (row.uploaded_by !== userId) throw err.forbidden('只能上传到自己登记的附件上。');
        if (row.processing_state === 'ready') {
          throw err.conflict('该附件已经接收完成，不能覆盖原文件。');
        }
        tx.db
          .prepare(`UPDATE attachments SET processing_state = 'processing', last_error_code = NULL WHERE id = ?`)
          .run(row.id);
        return { attachmentId: row.id };
      }, db);

      // ---- 事务外：鉴图、压缩、落盘（耗时且不得占用写事务）----
      const probed = await probeImage(input.bytes);
      if (!probed.ok) {
        markFailed(db, pre.attachmentId, probed.code);
        throw err.input(probed.detail, [{ path: 'file', message: probed.detail }]);
      }

      let display: Awaited<ReturnType<typeof buildDisplayImage>>;
      try {
        display = await buildDisplayImage(input.bytes, probed.mime);
      } catch {
        markFailed(db, pre.attachmentId, 'decode_failed');
        throw err.input('图片处理失败，可能已损坏，请换一张。', [{ path: 'file', message: '无法生成展示图' }]);
      }

      const originalKey = storageKeyFor(pre.attachmentId, 'ORIGINAL');
      const displayKey = storageKeyFor(pre.attachmentId, 'DISPLAY');

      let originalStored;
      let displayStored;
      try {
        originalStored = await store.put(originalKey, input.bytes);
        displayStored = await store.put(displayKey, display.bytes);
      } catch {
        markFailed(db, pre.attachmentId, 'storage_error');
        throw err.internal('图片保存失败，请稍后重试。');
      }

      // ---- 事务 2：写入文件版本与落盘记录，置 ready ----
      return withTransaction((tx: Tx) => {
        const now = nowMs();
        const originalFileId = newId();
        const displayFileId = newId();
        const displayVariantKey = 'DISPLAY';

        tx.db
          .prepare(
            `INSERT INTO attachment_files
               (id, attachment_id, variant_key, variant_role, mime_type, byte_size, width, height,
                hash_algorithm, content_hash, processing_state, created_at)
             VALUES (?, ?, 'ORIGINAL', 'original', ?, ?, ?, ?, 'sha256', ?, 'ready', ?)`,
          )
          .run(
            originalFileId,
            pre.attachmentId,
            probed.mime,
            originalStored.byteSize,
            probed.width,
            probed.height,
            originalStored.sha256,
            now,
          );

        tx.db
          .prepare(
            `INSERT INTO attachment_files
               (id, attachment_id, variant_key, variant_role, mime_type, byte_size, width, height,
                hash_algorithm, content_hash, processing_state, created_at)
             VALUES (?, ?, ?, 'display', ?, ?, ?, ?, 'sha256', ?, 'ready', ?)`,
          )
          .run(
            displayFileId,
            pre.attachmentId,
            displayVariantKey,
            display.mime,
            displayStored.byteSize,
            display.width,
            display.height,
            displayStored.sha256,
            now,
          );

        // 本地保底落盘记录：就绪的前提是这份记录真实存在且摘要已核验。
        for (const [fileId, stored] of [
          [originalFileId, originalStored],
          [displayFileId, displayStored],
        ] as const) {
          tx.db
            .prepare(
              `INSERT INTO attachment_blobs (id, file_id, storage_key, byte_size, content_hash, verified_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(newId(), fileId, stored.storageKey, stored.byteSize, stored.sha256, now, now);
        }

        tx.db
          .prepare(`UPDATE attachments SET processing_state = 'ready', ready_at = ? WHERE id = ?`)
          .run(now, pre.attachmentId);

        // 封面引用：编辑期记在草稿上（draft_attachment_links），发布时再固定到修订快照。
        // 只接受**同一用户自己的**草稿，避免借封面把文件挂到别人的草稿上。
        if (usage === 'cover' && input.draftId !== undefined) {
          const draft = tx.db
            .prepare('SELECT owner_id FROM content_drafts WHERE id = ?')
            .get(input.draftId) as { owner_id: string } | undefined;
          if (!draft) throw err.unavailable('草稿不存在或不可访问。');
          if (draft.owner_id !== userId) throw err.forbidden('只能向自己的草稿上传封面。');
          // 一篇评测只有一个封面：先撤掉旧封面引用再挂新的（与 uq_review_revision_cover 同义）。
          tx.db
            .prepare("DELETE FROM draft_attachment_links WHERE draft_id = ? AND usage = 'cover'")
            .run(input.draftId);
          tx.db
            .prepare(
              "INSERT OR IGNORE INTO draft_attachment_links (draft_id, file_id, usage) VALUES (?, ?, 'cover')",
            )
            .run(input.draftId, displayFileId);
        }

        const row = readAttachment(tx.db, pre.attachmentId);
        return toView(row, readDisplayFile(tx.db, pre.attachmentId));
      }, db);
    },

    async getAttachment(ctx, attachmentId) {
      if (ctx.userId === null) throw err.unauthenticated();
      return withRead((conn) => {
        const row = readAttachment(conn, attachmentId);
        if (row.uploaded_by !== ctx.userId) throw err.forbidden('只能查看自己上传的附件。');
        return toView(row, readDisplayFile(conn, attachmentId));
      }, db);
    },

    async resolveReadable(input, viewer) {
      // 第一步：纯读取判断（事务外只做查询，不碰文件）。
      const found = withRead((conn) => {
        const file = conn
          .prepare(
            `SELECT f.id, f.attachment_id, f.variant_key, f.variant_role, f.mime_type,
                    f.byte_size, f.width, f.height, f.content_hash, f.processing_state,
                    b.storage_key
               FROM attachment_files f
               JOIN attachments a ON a.id = f.attachment_id
               JOIN attachment_blobs b ON b.file_id = f.id
              WHERE f.attachment_id = ? AND f.variant_key = ? AND f.processing_state = 'ready'`,
          )
          .get(input.attachmentId, input.variantKey) as (FileRow & { storage_key: string }) | undefined;
        if (!file) return null;

        // 权限判定（架构第 10 节）：两种情形才允许读取，其余一律不返回字节。
        //   a) 该文件被**当前公开**的修订引用（读者）；且只允许 display 变体；
        //   b) 查看者是附件所有人（本人在草稿期预览自己的图，含原图）。
        const isOwner = viewer.userId !== null && viewer.userId === ownerOf(conn, input.attachmentId);
        if (isOwner) {
          return { storageKey: file.storage_key, mime: file.mime_type };
        }
        if (file.variant_role !== 'display') return null;
        if (!isPubliclyReferenced(conn, file.id)) return null;
        return { storageKey: file.storage_key, mime: file.mime_type };
      }, db);

      if (!found) return null;

      // 第二步：事务外读文件字节（IO 不占用写事务）。
      const bytes = await store.get(found.storageKey);
      if (!bytes) return null;
      return { bytes, mime: found.mime };
    },
  };
}

function markFailed(db: SqliteDatabase, attachmentId: string, code: MediaErrorCode): void {
  withTransaction((tx: Tx) => {
    tx.db
      .prepare(`UPDATE attachments SET processing_state = 'failed', last_error_code = ? WHERE id = ?`)
      .run(code, attachmentId);
  }, db);
}

function ownerOf(db: SqliteDatabase, attachmentId: string): string | null {
  const row = db.prepare('SELECT uploaded_by FROM attachments WHERE id = ?').get(attachmentId) as
    | { uploaded_by: string }
    | undefined;
  return row?.uploaded_by ?? null;
}

/** 该文件是否被"当前公开"的修订引用（架构第 10 节：公开读取按内容权限）。 */
function isPubliclyReferenced(db: SqliteDatabase, fileId: string): boolean {
  const row = db
    .prepare(
      `SELECT count(*) AS c
         FROM review_revision_attachment_links l
         JOIN review_revisions rv ON rv.id = l.review_revision_id
         JOIN reviews r ON r.id = rv.review_id
         JOIN content_entities ce ON ce.id = r.id
        WHERE l.file_id = ?
          AND r.published_revision_id = rv.id
          AND ce.withdrawn_at IS NULL
          AND ce.hidden_at IS NULL`,
    )
    .get(fileId) as { c: number };
  return row.c > 0;
}

/** 进程级单例（Web 与 worker 各自持有）。 */
let singleton: MediaService | null = null;
export function mediaService(): MediaService {
  if (!singleton) singleton = createMediaService({ db: getDb() });
  return singleton;
}
export function resetMediaService(): void {
  singleton = null;
}

/** 供测试与装配方复用的类型出口。 */
export type { FileStore } from '@/server/platform/file-store';
export { sha256Hex };
export type { PageRequest, PageResult };
