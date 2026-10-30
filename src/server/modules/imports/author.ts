/**
 * 作者侧「文件夹导入 + 断点续传」（架构 §49 / 数据库模型 §7）。
 *
 * 与小批量导入组件（浏览器里一次读完再写）的差别，也是本模块存在的理由：
 *   1. **上传与处理分离**：先按清单登记所有文件，再逐片上传，传完再生成草稿；
 *   2. **断点续传**：租约（300s）+ 绝对期限（1800s），断网/关页面后可按已接收字节继续，
 *      不必重传整个文件；尝试过期会新建尝试，但**已接收字节保留**；
 *   3. **同名不同内容不当原输入**：声明的 sha256 与收完后的实际摘要不一致 → 明确失败，
 *      不静默复用旧字节；
 *   4. **续传按 offset 追加**：对象存储没有"追加"语义，所以每次续传写一个分片对象，
 *      结束时按 chunk_manifest 顺序读回拼接、校验摘要后才算 ready。
 */

import { createHash } from 'node:crypto';
import type { SqliteDatabase } from '@/server/platform/db';
import { getDb } from '@/server/platform/db';
import { withRead, withTransaction } from '@/server/platform/tx';
import { newId } from '@/server/platform/id';
import { nowMs } from '@/server/platform/time';
import { err } from '@/packages/common/errors';
import { assertCanWrite, isAdmin, type CallerContext } from '@/server/platform/context';
import { createLocalFileStore, defaultMediaRoot, type FileStore } from '@/server/platform/file-store';
import {
  applyImageReplacements,
  buildImageIndex,
  collectImageRefs,
  resolveImageReference,
  stripCollectionRoot,
} from '@/packages/common/md-images';
import { createMediaService } from '@/server/modules/media';
import { reviewsService } from '@/server/modules/reviews';
import { numberSetting } from '@/server/modules/settings';
import { recordOperationInTx } from '@/server/modules/operations';

/** 上传租约口径（参数与管理规则 §4：接收执行权 300s、续期 30s、单文件总时长 1800s）。 */
export const UPLOAD_LIMITS = {
  leaseSeconds: 300,
  absoluteSeconds: 1800,
  /** 单片上限：8MB。浏览器按这个切，服务端也按它拒。 */
  maxChunkBytes: 8 * 1024 * 1024,
} as const;

export interface AuthorInputDeclaration {
  /** 规范化相对路径（作者端已剥掉选择目录的首层名字）。 */
  path: string;
  kind: 'markdown' | 'image';
  byteSize: number;
  /** 声明摘要：结束时必须与实收一致，否则明确失败。 */
  sha256: string;
}

export interface AuthorBatchItemView {
  itemId: string;
  itemKey: string;
  state: 'pending' | 'done' | 'failed';
  draftId: string | null;
  issues: string[];
}

export interface AuthorBatchView {
  batchId: string;
  createdAt: number;
  inputs: Array<{
    inputId: string;
    path: string;
    kind: 'markdown' | 'image';
    uploadState: 'pending' | 'ready' | 'failed';
    receivedByteSize: number;
    declaredByteSize: number;
  }>;
  items: AuthorBatchItemView[];
  counts: { total: number; done: number; failed: number; pending: number };
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface InputRow {
  id: string;
  batch_id: string;
  input_key: string;
  file_kind: 'markdown' | 'image';
  relative_path: string;
  declared_byte_size: number;
  declared_sha256: string;
  upload_state: 'pending' | 'ready' | 'failed';
  received_byte_size: number;
  received_sha256: string | null;
}

interface AttemptRow {
  id: string;
  input_id: string;
  attempt_number: number;
  lease_owner: string;
  lease_expires_at: number;
  absolute_deadline_at: number;
  observed_byte_size: number;
  chunk_manifest: string;
  result: 'in_progress' | 'ok' | 'failed' | 'expired';
}

function readInput(db: SqliteDatabase, inputId: string): InputRow {
  const row = db
    .prepare(
      'SELECT id, batch_id, input_key, file_kind, relative_path, declared_byte_size, declared_sha256, upload_state, received_byte_size, received_sha256 FROM batch_input_files WHERE id = ?',
    )
    .get(inputId) as InputRow | undefined;
  if (!row) throw err.unavailable('输入文件不存在。');
  return row;
}

function readAttempt(db: SqliteDatabase, attemptId: string): AttemptRow {
  const row = db
    .prepare(
      'SELECT id, input_id, attempt_number, lease_owner, lease_expires_at, absolute_deadline_at, observed_byte_size, chunk_manifest, result FROM batch_input_upload_attempts WHERE id = ?',
    )
    .get(attemptId) as AttemptRow | undefined;
  if (!row) throw err.unavailable('上传尝试不存在。');
  return row;
}

/** 该输入所有尝试里出现过的分片，按 offset 去重合并（续传跨尝试拼回完整文件）。 */
function collectChunks(db: SqliteDatabase, inputId: string): Array<{ offset: number; size: number }> {
  const attempts = db
    .prepare('SELECT id, input_id, attempt_number, lease_owner, lease_expires_at, absolute_deadline_at, observed_byte_size, chunk_manifest, result FROM batch_input_upload_attempts WHERE input_id = ?')
    .all(inputId) as AttemptRow[];
  const byOffset = new Map<number, number>();
  for (const attempt of attempts) {
    for (const chunk of chunksOf(attempt)) {
      if (!byOffset.has(chunk.offset)) byOffset.set(chunk.offset, chunk.size);
    }
  }
  return [...byOffset.entries()]
    .map(([offset, size]) => ({ offset, size }))
    .sort((a, b) => a.offset - b.offset);
}

function chunksOf(attempt: AttemptRow): Array<{ offset: number; size: number }> {
  try {
    const parsed = JSON.parse(attempt.chunk_manifest) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => item as { offset?: unknown; size?: unknown })
      .filter((item) => typeof item.offset === 'number' && typeof item.size === 'number')
      .map((item) => ({ offset: item.offset as number, size: item.size as number }));
  } catch {
    return [];
  }
}

export function createAuthorImportService(deps: { db?: SqliteDatabase; store?: FileStore } = {}) {
  const db = deps.db ?? getDb();
  const store: FileStore = deps.store ?? createLocalFileStore({ root: defaultMediaRoot() });

  /** 断言：批次属于调用者（作者只能动自己的批次；管理员可看全部）。 */
  function requireOwnBatch(ctx: CallerContext, batchId: string): { id: string; batch_type: string; requested_by: string } {
    const batch = db
      .prepare('SELECT id, batch_type, requested_by FROM batch_jobs WHERE id = ?')
      .get(batchId) as { id: string; batch_type: string; requested_by: string } | undefined;
    if (!batch) throw err.unavailable('批次不存在。');
    if (batch.requested_by !== ctx.userId && !isAdmin(ctx)) {
      throw err.forbidden('只能操作自己的导入批次。');
    }
    if (batch.batch_type !== 'review_import') throw err.input('这不是作者导入批次。');
    return batch;
  }

  /** 把一次尝试标成失败（摘要不符 / 分片丢失）。 */
  function markFailed(inputId: string, attemptId: string, code: string, message: string) {
    const now = nowMs();
    withTransaction((tx) => {
      tx.db
        .prepare("UPDATE batch_input_upload_attempts SET result = 'failed', error_code = ?, finished_at = ? WHERE id = ?")
        .run(code, now, attemptId);
      tx.db
        .prepare("UPDATE batch_input_files SET upload_state = 'failed', updated_at = ?, state_version = state_version + 1 WHERE id = ?")
        .run(now, inputId);
      return { ok: true };
    }, db);
    return { inputId, uploadState: 'failed' as const, issues: [message] };
  }

  return {
    /** 登记批次与输入（此时还没有任何字节）。 */
    async createBatch(
      ctx: CallerContext,
      input: { inputs: AuthorInputDeclaration[]; requestKey: string },
    ): Promise<{ batchId: string; inputs: number; items: number }> {
      assertCanWrite(ctx);
      const userId = ctx.userId;
      if (!userId) throw err.unauthenticated();
      if (typeof input.requestKey !== 'string' || input.requestKey.trim() === '') {
        throw err.input('缺少请求标识。', [{ path: 'requestKey', message: '必填' }]);
      }
      if (!Array.isArray(input.inputs) || input.inputs.length === 0) {
        throw err.input('没有选择任何文件。', [{ path: 'inputs', message: '至少一个文件' }]);
      }

      const maxMarkdown = numberSetting(db, 'imports.max_markdown_bytes', 512 * 1024);
      const markdowns = input.inputs.filter((item) => item.kind === 'markdown');
      if (markdowns.length === 0) {
        throw err.input('没有选中 .md 文件。', [{ path: 'inputs', message: '至少一篇 Markdown' }]);
      }

      const normalized = input.inputs.map((item) => {
        const path = stripCollectionRoot(String(item.path ?? '').replace(/\\/g, '/'));
        if (path === '') throw err.input('文件路径不合法。', [{ path: 'inputs', message: '空路径' }]);
        if (!Number.isInteger(item.byteSize) || item.byteSize < 0) {
          throw err.input('文件大小不合法。', [{ path: 'inputs', message: path }]);
        }
        if (item.kind === 'markdown' && item.byteSize > maxMarkdown) {
          throw err.input(
            '单篇 Markdown 最多 ' + Math.floor(maxMarkdown / 1024) + 'KB：' + path,
            [{ path: 'inputs', message: path }],
          );
        }
        if (!/^[0-9a-f]{64}$/i.test(item.sha256)) {
          throw err.input('缺少文件摘要：' + path, [{ path: 'inputs', message: path }]);
        }
        return {
          path,
          kind: item.kind,
          byteSize: item.byteSize,
          sha256: item.sha256.toLowerCase(),
        };
      });

      const seen = new Set<string>();
      for (const item of normalized) {
        if (seen.has(item.path)) throw err.input('同一文件出现两次：' + item.path, [{ path: 'inputs', message: item.path }]);
        seen.add(item.path);
      }

      const digest = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');

      return withTransaction((tx) => {
        const conn = tx.db;
        const existing = conn
          .prepare('SELECT id FROM batch_jobs WHERE requested_by = ? AND request_key = ?')
          .get(userId, input.requestKey) as { id: string } | undefined;
        if (existing) {
          const counts = conn
            .prepare(
              'SELECT (SELECT COUNT(*) FROM batch_input_files WHERE batch_id = ?) AS inputs, (SELECT COUNT(*) FROM batch_job_items WHERE batch_id = ?) AS items',
            )
            .get(existing.id, existing.id) as { inputs: number; items: number };
          return { batchId: existing.id, inputs: Number(counts.inputs), items: Number(counts.items) };
        }

        const now = nowMs();
        const batchId = newId(now);
        conn
          .prepare(
            'INSERT INTO batch_jobs (id, requested_by, batch_type, mode, request_key, request_digest, input_manifest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            batchId,
            userId,
            'review_import',
            'apply',
            input.requestKey,
            digest,
            JSON.stringify({
              markdowns: markdowns.length,
              images: normalized.length - markdowns.length,
              paths: normalized.map((item) => item.path),
            }),
            now,
          );

        for (const item of normalized) {
          conn
            .prepare(
              'INSERT INTO batch_input_files (id, batch_id, input_key, file_kind, relative_path, declared_byte_size, declared_sha256, upload_state, received_byte_size, attempt_counter, state_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)',
            )
            .run(newId(now), batchId, item.path, item.kind, item.path, item.byteSize, item.sha256, 'pending', now, now);
        }

        // 每篇 Markdown 一个条目；图片在完成时按引用关系挂到条目上。
        for (const item of normalized.filter((entry) => entry.kind === 'markdown')) {
          const itemId = newId(now);
          conn
            .prepare(
              'INSERT INTO batch_job_items (id, batch_id, item_key, position, input_metadata, processing_state, issues, state_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
            )
            .run(
              itemId,
              batchId,
              item.path,
              0,
              JSON.stringify({ path: item.path, source: 'folder_import' }),
              'pending',
              '[]',
              now,
              now,
            );
          const sourceInput = conn
            .prepare('SELECT id FROM batch_input_files WHERE batch_id = ? AND input_key = ?')
            .get(batchId, item.path) as { id: string };
          conn
            .prepare(
              'INSERT INTO batch_item_input_links (batch_id, item_id, input_id, usage, created_at) VALUES (?, ?, ?, ?, ?)',
            )
            .run(batchId, itemId, sourceInput.id, 'source_markdown', now);
        }

        // 条目顺序按 Markdown 在清单里的顺序
        const items = conn
          .prepare('SELECT id FROM batch_job_items WHERE batch_id = ? ORDER BY created_at ASC, id ASC')
          .all(batchId) as Array<{ id: string }>;
        items.forEach((row, index) => {
          conn.prepare('UPDATE batch_job_items SET position = ? WHERE id = ?').run(index, row.id);
        });

        recordOperationInTx(
          conn,
          {
            actionType: 'author.import.batch',
            operationKey: input.requestKey,
            actorKind: 'user',
            actorUserId: userId,
            targetType: 'import_batch',
            targetId: batchId,
            targetSnapshot: { markdowns: markdowns.length, images: normalized.length - markdowns.length },
            changes: { total_inputs: normalized.length },
            reason: '作者启动文件夹导入（Markdown + 图片）',
          },
          now,
        );

        return {
          batchId,
          inputs: normalized.length,
          items: normalized.filter((entry) => entry.kind === 'markdown').length,
        };
      }, db);
    },

    /** 续传：按 offset 追加一片。不给 attemptId 就新建尝试（断点从未完成/已过期处继续）。 */
    async uploadChunk(
      ctx: CallerContext,
      input: { inputId: string; attemptId?: string; offset: number; bytes: Buffer },
    ): Promise<{ inputId: string; attemptId: string; received: number; declared: number; uploadState: string }> {
      assertCanWrite(ctx);
      const userId = ctx.userId;
      if (!userId) throw err.unauthenticated();

      const row = readInput(db, input.inputId);
      requireOwnBatch(ctx, row.batch_id);
      if (row.upload_state === 'ready') throw err.conflict('这个文件已经完整接收，不能继续追加。', { inputId: row.id });
      if (row.upload_state === 'failed') throw err.conflict('这个文件上次已失败，请重新创建尝试。', { inputId: row.id });
      if (!Number.isInteger(input.offset) || input.offset < 0) {
        throw err.input('续传位置必须是整数。', [{ path: 'offset', message: '不合法' }]);
      }
      if (!Buffer.isBuffer(input.bytes) || input.bytes.byteLength === 0) {
        throw err.input('这一片是空的。', [{ path: 'bytes', message: '至少 1 字节' }]);
      }
      if (input.bytes.byteLength > UPLOAD_LIMITS.maxChunkBytes) {
        throw err.input('单片超过 ' + Math.floor(UPLOAD_LIMITS.maxChunkBytes / 1024 / 1024) + 'MB。', [
          { path: 'bytes', message: '分片过大' },
        ]);
      }
      if (input.offset !== row.received_byte_size) {
        // 真实断点：告诉客户端"从哪继续"，而不是让它猜。
        throw err.conflict('收到的位置与已接收字节不一致，请从断点继续。', {
          inputId: row.id,
          received: row.received_byte_size,
        });
      }
      if (input.offset + input.bytes.byteLength > row.declared_byte_size) {
        throw err.input('这一片会让文件超过声明大小。', [{ path: 'bytes', message: '超出声明大小' }]);
      }

      const now = nowMs();
      const prepared = withTransaction((tx) => {
        const conn = tx.db;
        let attempt: AttemptRow;
        if (input.attemptId !== undefined) {
          attempt = readAttempt(conn, input.attemptId);
          if (attempt.input_id !== row.id) throw err.unavailable('上传尝试与文件不匹配。');
          if (attempt.result !== 'in_progress') {
            throw err.conflict('这次上传尝试已经结束，请新建尝试后从断点继续。', {
              inputId: row.id,
              attemptId: attempt.id,
            });
          }
          if (attempt.lease_owner !== userId) throw err.forbidden('只能续传自己发起的尝试。');
          if (now > attempt.absolute_deadline_at) {
            conn
              .prepare("UPDATE batch_input_upload_attempts SET result = 'expired', finished_at = ? WHERE id = ?")
              .run(now, attempt.id);
            throw err.conflict('这次上传已超过总时长上限，请新建尝试后从断点继续。', {
              inputId: row.id,
              received: row.received_byte_size,
            });
          }
        } else {
          // 新建尝试：编号递增；租约与绝对期限从这里起算。
          const live = conn
            .prepare(
              "SELECT id FROM batch_input_upload_attempts WHERE input_id = ? AND result = 'in_progress' AND lease_expires_at >= ? AND absolute_deadline_at >= ?",
            )
            .get(row.id, now, now) as { id: string } | undefined;
          if (live) {
            throw err.conflict('这个文件已有进行中的上传，请继续用它或等租约过期。', {
              inputId: row.id,
              attemptId: live.id,
            });
          }
          const counter = (
            conn.prepare('SELECT attempt_counter FROM batch_input_files WHERE id = ?').get(row.id) as {
              attempt_counter: number;
            }
          ).attempt_counter;
          const attemptId = newId(now);
          conn
            .prepare(
              'INSERT INTO batch_input_upload_attempts (id, batch_id, input_id, attempt_number, lease_owner, lease_expires_at, absolute_deadline_at, last_transfer_at, observed_byte_size, chunk_manifest, result, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .run(
              attemptId,
              row.batch_id,
              row.id,
              counter + 1,
              userId,
              now + UPLOAD_LIMITS.leaseSeconds * 1000,
              now + UPLOAD_LIMITS.absoluteSeconds * 1000,
              now,
              row.received_byte_size,
              JSON.stringify([]),
              'in_progress',
              now,
            );
          conn.prepare('UPDATE batch_input_files SET attempt_counter = ?, updated_at = ? WHERE id = ?').run(counter + 1, now, row.id);
          attempt = readAttempt(conn, attemptId);
        }
        return { attempt };
      }, db);

      // 事务外写对象存储（IO 不占写事务）
      // 分片按 **输入 + offset** 存，不按尝试存：续传会新建尝试，但已收到的字节必须还能读回来。
      const storageKey = 'imports/' + row.batch_id + '/' + row.id + '/' + input.offset;
      await store.put(storageKey, input.bytes);

      return withTransaction((tx) => {
        const conn = tx.db;
        const attempt = readAttempt(conn, prepared.attempt.id);
        const chunks = chunksOf(attempt);
        if (!chunks.some((chunk) => chunk.offset === input.offset)) {
          chunks.push({ offset: input.offset, size: input.bytes.byteLength });
        }
        chunks.sort((a, b) => a.offset - b.offset);
        // 总进度 = 断点位置 + 这一片（不是"本尝试分片之和"：续传时旧字节不在本次尝试里）
        const received = input.offset + input.bytes.byteLength;
        conn
          .prepare(
            'UPDATE batch_input_upload_attempts SET chunk_manifest = ?, observed_byte_size = ?, last_transfer_at = ?, lease_expires_at = ? WHERE id = ?',
          )
          .run(
            JSON.stringify(chunks),
            received,
            nowMs(),
            Math.min(nowMs() + UPLOAD_LIMITS.leaseSeconds * 1000, attempt.absolute_deadline_at),
            attempt.id,
          );
        conn
          .prepare('UPDATE batch_input_files SET received_byte_size = ?, state_version = state_version + 1, updated_at = ? WHERE id = ?')
          .run(received, nowMs(), row.id);

        return {
          inputId: row.id,
          attemptId: attempt.id,
          received,
          declared: row.declared_byte_size,
          uploadState: 'pending',
        };
      }, db);
    },

    /** 完成一个文件：读回所有分片、拼接、校验声明摘要。 */
    async finishInput(
      ctx: CallerContext,
      input: { inputId: string; attemptId: string },
    ): Promise<{ inputId: string; uploadState: 'ready' | 'failed'; issues: string[] }> {
      assertCanWrite(ctx);
      const row = readInput(db, input.inputId);
      requireOwnBatch(ctx, row.batch_id);
      if (row.upload_state === 'ready') return { inputId: row.id, uploadState: 'ready', issues: [] };

      const attempt = readAttempt(db, input.attemptId);
      if (attempt.input_id !== row.id) throw err.unavailable('上传尝试与文件不匹配。');
      if (attempt.result !== 'in_progress') throw err.conflict('这次上传尝试已经结束。', { inputId: row.id });
      if (attempt.observed_byte_size !== row.declared_byte_size) {
        throw err.conflict('还有字节没传完，不能结束。', {
          inputId: row.id,
          received: attempt.observed_byte_size,
          declared: row.declared_byte_size,
        });
      }

      const chunks = collectChunks(db, row.id);
      const buffers: Buffer[] = [];
      for (const chunk of chunks) {
        const stored = await store.get('imports/' + row.batch_id + '/' + row.id + '/' + chunk.offset);
        if (!stored || stored.byteLength !== chunk.size) {
          return markFailed(row.id, attempt.id, 'chunk_missing', '分片读回失败，请重试该文件。');
        }
        buffers.push(stored);
      }
      const bytes = Buffer.concat(buffers);
      const actual = sha256Hex(bytes);

      if (actual !== row.declared_sha256) {
        return markFailed(row.id, attempt.id, 'digest_mismatch', '文件内容与声明摘要不一致，请重新选择该文件。');
      }

      const now = nowMs();
      withTransaction((tx) => {
        tx.db
          .prepare("UPDATE batch_input_files SET upload_state = 'ready', received_byte_size = ?, received_sha256 = ?, received_at = ?, updated_at = ? WHERE id = ?")
          .run(bytes.byteLength, actual, now, now, row.id);
        tx.db
          .prepare("UPDATE batch_input_upload_attempts SET result = 'ok', finished_at = ? WHERE id = ?")
          .run(now, attempt.id);
        return { ok: true };
      }, db);

      return { inputId: row.id, uploadState: 'ready', issues: [] };
    },

    /** 读回某个已就绪输入的完整字节（finalize 用）。 */
    async readInputBytes(ctx: CallerContext, inputId: string): Promise<Buffer> {
      assertCanWrite(ctx);
      const row = readInput(db, inputId);
      requireOwnBatch(ctx, row.batch_id);
      if (row.upload_state !== 'ready') throw err.conflict('这个文件还没传完。', { inputId: row.id });
      const chunks = collectChunks(db, row.id);
      const buffers: Buffer[] = [];
      for (const chunk of chunks) {
        const stored = await store.get('imports/' + row.batch_id + '/' + row.id + '/' + chunk.offset);
        if (stored) buffers.push(stored);
      }
      return Buffer.concat(buffers);
    },

    /**
     * 收尾：把所有就绪的 Markdown 变成私有大纲草稿，并把引用到的图片传成站内附件、
     * 改写正文链接。单篇失败不影响其它篇（每篇一个独立事务）。
     */
    async finalizeBatch(
      ctx: CallerContext,
      batchId: string,
    ): Promise<{ created: number; failed: number; skipped: number; issues: Array<{ itemKey: string; issues: string[] }> }> {
      assertCanWrite(ctx);
      requireOwnBatch(ctx, batchId);

      const items = db
        .prepare("SELECT id, item_key FROM batch_job_items WHERE batch_id = ? AND processing_state = 'pending' ORDER BY position ASC, id ASC")
        .all(batchId) as Array<{ id: string; item_key: string }>;

      const inputs = db
        .prepare('SELECT id, input_key, file_kind, upload_state FROM batch_input_files WHERE batch_id = ?')
        .all(batchId) as Array<{ id: string; input_key: string; file_kind: 'markdown' | 'image'; upload_state: string }>;

      const imageInputs = inputs.filter((row) => row.file_kind === 'image' && row.upload_state === 'ready');
      // 服务端存的就是规范化相对路径（首层已剥），不能再让索引削一层。
      const index = buildImageIndex(imageInputs.map((row) => ({ path: row.input_key })), { stripRoot: false });
      const imageById = new Map(imageInputs.map((row) => [row.input_key.toLowerCase(), row.id]));

      const media = createMediaService({ db, store });
      const results: Array<{ itemKey: string; issues: string[] }> = [];
      let created = 0;
      let failed = 0;
      let skipped = 0;

      for (const item of items) {
        const source = inputs.find((row) => row.file_kind === 'markdown' && row.input_key === item.item_key);
        if (!source || source.upload_state !== 'ready') {
          skipped += 1;
          results.push({ itemKey: item.item_key, issues: ['正文文件还没传完，先跳过'] });
          continue;
        }

        const markdown = (await this.readInputBytes(ctx, source.id)).toString('utf8');
        const refs = collectImageRefs(markdown);
        const replacements = new Map<string, string>();
        const issues: string[] = [];
        const usedImageIds: string[] = [];

        for (const ref of refs) {
          if (!ref.url || /^(https?:|data:|mailto:)/i.test(ref.url)) continue;
          const matched = resolveImageReference(ref.url, item.item_key, index);
          if (matched === null) {
            issues.push('图片未匹配：' + ref.url);
            continue;
          }
          const imageInput = imageById.get(matched.toLowerCase());
          if (!imageInput) {
            issues.push('图片未匹配：' + ref.url);
            continue;
          }
          try {
            const bytes = await this.readInputBytes(ctx, imageInput);
            const fileName = matched.split('/').pop() ?? 'image.png';
            // 附件服务需要草稿先存在：先建草稿，再传图，再写正文。
            const draft = await reviewsService.createOrGetDraft(
              ctx,
              { pluginId: null, requestKey: 'review_import:' + batchId + ':' + item.id, fresh: true },
              db,
            );
            const attachment = await media.createAttachment(ctx, {
              draftId: draft.draftId,
              originalFilename: fileName,
              usage: 'body',
            });
            const ready = await media.receiveFile(ctx, {
              attachmentId: attachment.attachmentId,
              bytes,
            });
            if (ready.processingState === 'ready' && ready.displayUrl) {
              replacements.set(ref.url, ready.displayUrl);
              usedImageIds.push(imageInput);
            } else {
              issues.push('图片处理失败：' + ref.url);
            }
          } catch (e) {
            issues.push('图片上传失败：' + ref.url + '（' + (e instanceof Error ? e.message : '未知原因') + '）');
          }
        }

        try {
          const draft = await reviewsService.createOrGetDraft(
            ctx,
            { pluginId: null, requestKey: 'review_import:' + batchId + ':' + item.id, fresh: true },
            db,
          );
          const rewritten = applyImageReplacements(markdown, replacements);
          const title = titleOf(item.item_key, markdown);
          await reviewsService.saveDraft(
            ctx,
            {
              draftId: draft.draftId,
              expectedVersion: draft.saveVersion,
              requestKey: 'review_import_save:' + batchId + ':' + item.id,
              payload: {
                title,
                pluginId: null,
                pluginVersion: { kind: 'unknown' },
                dshVersion: { kind: 'unknown' },
                body: toBodySegments(rewritten.markdown),
                verdict: null,
                evidence: [],
                assessmentLevel: null,
              },
            },
            db,
          );

          withTransaction((tx) => {
            tx.db
              .prepare("UPDATE batch_job_items SET draft_id = ?, processing_state = 'done', issues = ?, state_version = state_version + 1, updated_at = ? WHERE id = ?")
              .run(draft.draftId, JSON.stringify(issues), nowMs(), item.id);
            for (const imageId of new Set(usedImageIds)) {
              tx.db
                .prepare('INSERT OR IGNORE INTO batch_item_input_links (batch_id, item_id, input_id, usage, created_at) VALUES (?, ?, ?, ?, ?)')
                .run(batchId, item.id, imageId, 'referenced_image', nowMs());
            }
            return { ok: true };
          }, db);

          created += 1;
          results.push({ itemKey: item.item_key, issues });
        } catch (e) {
          failed += 1;
          const message = e instanceof Error ? e.message : '生成草稿失败';
          withTransaction((tx) => {
            tx.db
              .prepare("UPDATE batch_job_items SET processing_state = 'failed', issues = ?, state_version = state_version + 1, updated_at = ? WHERE id = ?")
              .run(JSON.stringify(issues.concat(message)), nowMs(), item.id);
            return { ok: true };
          }, db);
          results.push({ itemKey: item.item_key, issues: issues.concat(message) });
        }
      }

      withTransaction((tx) => {
        recordOperationInTx(
          tx.db,
          {
            actionType: 'author.import.finalize',
            operationKey: 'author_import_finalize:' + batchId + ':' + newId(),
            actorKind: 'user',
            actorUserId: ctx.userId ?? '',
            targetType: 'import_batch',
            targetId: batchId,
            targetSnapshot: { items: items.length },
            changes: { created, failed, skipped },
            reason: '作者文件夹导入收尾：生成草稿并改写图片引用',
          },
          nowMs(),
        );
        return { ok: true };
      }, db);

      return { created, failed, skipped, issues: results };
    },

    async getBatch(ctx: CallerContext, batchId: string): Promise<AuthorBatchView> {
      assertCanWrite(ctx);
      requireOwnBatch(ctx, batchId);
      return withRead((conn) => {
        const inputs = conn
          .prepare('SELECT id, input_key, file_kind, upload_state, received_byte_size, declared_byte_size FROM batch_input_files WHERE batch_id = ? ORDER BY file_kind, input_key')
          .all(batchId) as Array<{
          id: string;
          input_key: string;
          file_kind: 'markdown' | 'image';
          upload_state: 'pending' | 'ready' | 'failed';
          received_byte_size: number;
          declared_byte_size: number;
        }>;
        const items = conn
          .prepare('SELECT id, item_key, processing_state, draft_id, issues FROM batch_job_items WHERE batch_id = ? ORDER BY position ASC, id ASC')
          .all(batchId) as Array<{
          id: string;
          item_key: string;
          processing_state: 'pending' | 'done' | 'failed';
          draft_id: string | null;
          issues: string;
        }>;
        const batch = conn.prepare('SELECT created_at FROM batch_jobs WHERE id = ?').get(batchId) as { created_at: number };
        const counts = { total: items.length, done: 0, failed: 0, pending: 0 };
        for (const item of items) counts[item.processing_state] += 1;
        return {
          batchId,
          createdAt: batch.created_at,
          inputs: inputs.map((row) => ({
            inputId: row.id,
            path: row.input_key,
            kind: row.file_kind,
            uploadState: row.upload_state,
            receivedByteSize: Number(row.received_byte_size),
            declaredByteSize: Number(row.declared_byte_size),
          })),
          items: items.map((row) => {
            let issues: string[] = [];
            try {
              const parsed = JSON.parse(row.issues) as unknown;
              if (Array.isArray(parsed)) issues = parsed.filter((x): x is string => typeof x === 'string');
            } catch {
              issues = [];
            }
            return {
              itemId: row.id,
              itemKey: row.item_key,
              state: row.processing_state,
              draftId: row.draft_id,
              issues,
            };
          }),
          counts,
        };
      }, db);
    },
  };

}

/** 标题：首个 # / ## 标题；没有就用文件名（去掉扩展名）。 */
function titleOf(path: string, markdown: string): string {
  const match = markdown.match(/^#{1,2}\s+(.+)$/m);
  if (match) return match[1].trim().slice(0, 80);
  const base = path.split('/').pop() ?? '未命名';
  return base.replace(/\.(md|markdown|txt)$/i, '').slice(0, 80);
}

/** 正文按空行分段（与编辑器同一口径）。 */
function toBodySegments(markdown: string): { key: string; markdown: string }[] {
  return markdown.split(/\n{2,}/).map((text, index) => ({ key: 'p' + index, markdown: text }));
}

export type AuthorImportService = ReturnType<typeof createAuthorImportService>;
