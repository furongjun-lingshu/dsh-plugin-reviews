/**
 * 作者文件夹导入 + 断点续传：登记、分片续传、摘要校验、生成草稿。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertUser, type TestDb } from './support/db';
import { createAuthorImportService } from '../src/server/modules/imports/author';
import { createLocalFileStore } from '../src/server/platform/file-store';
import type { CallerContext } from '@/server/platform/context';
import { ErrorCodes, isDomainError } from '../src/packages/common/errors';

let ctx: TestDb | null = null;
let dir: string | null = null;
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

function caller(db: TestDb['db'], userId: string): CallerContext {
  const row = db.prepare('SELECT role, account_status FROM users WHERE id = ?').get(userId) as {
    role: 'user' | 'admin';
    account_status: 'active' | 'disabled';
  };
  return { userId, role: row.role, accountStatus: row.account_status };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function png(): Promise<Buffer> {
  return sharp({ create: { width: 120, height: 80, channels: 3, background: { r: 10, g: 120, b: 200 } } })
    .png()
    .toBuffer();
}

function setup() {
  ctx = createTestDb();
  dir = mkdtempSync(join(tmpdir(), 'dsh-author-import-'));
  const store = createLocalFileStore({ root: join(dir, 'media') });
  const service = createAuthorImportService({ db: ctx.db, store });
  return { db: ctx.db, store, service };
}

describe('作者文件夹导入', () => {
  it('登记清单：每篇 Markdown 一个条目，图片不建条目', async () => {
    const { db, service } = setup();
    const user = insertUser(db);
    const md = Buffer.from('# 我的评测\n\n正文段落。', 'utf8');
    const image = await png();

    const created = await service.createBatch(caller(db, user), {
      inputs: [
        { path: '综述/我的评测.md', kind: 'markdown', byteSize: md.byteLength, sha256: sha256(md) },
        { path: '综述/images/a.png', kind: 'image', byteSize: image.byteLength, sha256: sha256(image) },
      ],
      requestKey: 'batch-1',
    });

    expect(created.inputs).toBe(2);
    expect(created.items).toBe(1);

    const view = await service.getBatch(caller(db, user), created.batchId);
    expect(view.items).toHaveLength(1);
    // 路径已剥掉选择目录的首层名字
    expect(view.items[0].itemKey).toBe('我的评测.md');
    expect(view.inputs.map((i) => i.path).sort()).toEqual(['images/a.png', '我的评测.md']);
    expect(view.inputs.every((i) => i.uploadState === 'pending')).toBe(true);
  });

  it('分片续传：按 offset 追加、位置不符给出断点、传完校验摘要', async () => {
    const { db, service } = setup();
    const user = insertUser(db);
    const md = Buffer.from('# 标题\n\n' + 'x'.repeat(40), 'utf8');
    const created = await service.createBatch(caller(db, user), {
      inputs: [{ path: 'a.md', kind: 'markdown', byteSize: md.byteLength, sha256: sha256(md) }],
      requestKey: 'batch-2',
    });
    const view = await service.getBatch(caller(db, user), created.batchId);
    const inputId = view.inputs[0].inputId;

    const half = Math.floor(md.byteLength / 2);
    const first = await service.uploadChunk(caller(db, user), {
      inputId,
      offset: 0,
      bytes: md.subarray(0, half),
    });
    expect(first.received).toBe(half);

    // 位置不符 → 冲突里带"应该从哪继续"
    try {
      await service.uploadChunk(caller(db, user), { inputId, attemptId: first.attemptId, offset: 0, bytes: md.subarray(0, 1) });
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) {
        expect(e.code).toBe(ErrorCodes.VERSION_CONFLICT);
        expect((e.context as { received?: number }).received).toBe(half);
      }
    }

    const second = await service.uploadChunk(caller(db, user), {
      inputId,
      attemptId: first.attemptId,
      offset: half,
      bytes: md.subarray(half),
    });
    expect(second.received).toBe(md.byteLength);

    const finished = await service.finishInput(caller(db, user), { inputId, attemptId: first.attemptId });
    expect(finished.uploadState).toBe('ready');

    const bytes = await service.readInputBytes(caller(db, user), inputId);
    expect(sha256(bytes)).toBe(sha256(md));
  });

  it('摘要不符 → 明确失败，不把旧字节当原输入', async () => {
    const { db, service } = setup();
    const user = insertUser(db);
    const md = Buffer.from('# 标题\n\n正文', 'utf8');
    const created = await service.createBatch(caller(db, user), {
      inputs: [{ path: 'a.md', kind: 'markdown', byteSize: md.byteLength, sha256: 'f'.repeat(64) }],
      requestKey: 'batch-3',
    });
    const inputId = (await service.getBatch(caller(db, user), created.batchId)).inputs[0].inputId;

    const chunk = await service.uploadChunk(caller(db, user), { inputId, offset: 0, bytes: md });
    const finished = await service.finishInput(caller(db, user), { inputId, attemptId: chunk.attemptId });
    expect(finished.uploadState).toBe('failed');
    expect(finished.issues.join()).toContain('摘要');
  });

  it('尝试过期后新建尝试：已接收字节保留，从断点继续', async () => {
    const { db, service } = setup();
    const user = insertUser(db);
    const md = Buffer.from('y'.repeat(64), 'utf8');
    const created = await service.createBatch(caller(db, user), {
      inputs: [{ path: 'a.md', kind: 'markdown', byteSize: md.byteLength, sha256: sha256(md) }],
      requestKey: 'batch-4',
    });
    const inputId = (await service.getBatch(caller(db, user), created.batchId)).inputs[0].inputId;

    const first = await service.uploadChunk(caller(db, user), { inputId, offset: 0, bytes: md.subarray(0, 20) });
    // 把这一轮的绝对期限改成过去
    db.prepare('UPDATE batch_input_upload_attempts SET absolute_deadline_at = ? WHERE id = ?').run(
      Date.now() - 1000,
      first.attemptId,
    );

    try {
      await service.uploadChunk(caller(db, user), {
        inputId,
        attemptId: first.attemptId,
        offset: 20,
        bytes: md.subarray(20, 40),
      });
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.VERSION_CONFLICT);
    }

    // 新建尝试：从 20 继续（已接收字节保留）
    const resumed = await service.uploadChunk(caller(db, user), {
      inputId,
      offset: 20,
      bytes: md.subarray(20, 40),
    });
    expect(resumed.received).toBe(40);
    expect(resumed.attemptId).not.toBe(first.attemptId);
  });

  it('收尾：Markdown → 草稿，图片上传为附件并改写引用；未传完的跳过', async () => {
    const { db, service } = setup();
    const user = insertUser(db);
    const image = await png();
    const md = Buffer.from('# 带图评测\n\n![图](images/a.png)\n\n正文段落。', 'utf8');

    const created = await service.createBatch(caller(db, user), {
      inputs: [
        { path: 'set/a.md', kind: 'markdown', byteSize: md.byteLength, sha256: sha256(md) },
        { path: 'set/images/a.png', kind: 'image', byteSize: image.byteLength, sha256: sha256(image) },
      ],
      requestKey: 'batch-5',
    });
    const view = await service.getBatch(caller(db, user), created.batchId);
    const mdInput = view.inputs.find((i) => i.kind === 'markdown');
    const imgInput = view.inputs.find((i) => i.kind === 'image');
    if (!mdInput || !imgInput) throw new Error('fixture 异常');

    for (const [inputId, bytes] of [
      [mdInput.inputId, md],
      [imgInput.inputId, image],
    ] as const) {
      const chunk = await service.uploadChunk(caller(db, user), { inputId, offset: 0, bytes });
      await service.finishInput(caller(db, user), { inputId, attemptId: chunk.attemptId });
    }

    const result = await service.finalizeBatch(caller(db, user), created.batchId);
    expect(result.created).toBe(1);
    expect(result.failed).toBe(0);

    const after = await service.getBatch(caller(db, user), created.batchId);
    expect(after.items[0].state).toBe('done');
    expect(after.items[0].draftId).toBeTruthy();

    // 草稿正文里的图片已改写成站内地址
    const draft = db
      .prepare('SELECT payload FROM content_drafts WHERE id = ?')
      .get(after.items[0].draftId as string) as { payload: string };
    const payload = JSON.parse(draft.payload) as { body: Array<{ markdown: string }>; title: string };
    expect(payload.title).toBe('带图评测');
    expect(payload.body.map((s) => s.markdown).join('\n\n')).toContain('/media/');
    expect(payload.body.map((s) => s.markdown).join('\n\n')).not.toContain('images/a.png');
  });

  it('同一批多篇 Markdown 生成**各自独立**的草稿（不复用同一份）', async () => {
    const { db, service } = setup();
    const user = insertUser(db);
    const first = Buffer.from('# 第一篇\n\n甲正文', 'utf8');
    const second = Buffer.from('# 第二篇\n\n乙正文', 'utf8');

    const created = await service.createBatch(caller(db, user), {
      inputs: [
        { path: 'set/a.md', kind: 'markdown', byteSize: first.byteLength, sha256: sha256(first) },
        { path: 'set/b.md', kind: 'markdown', byteSize: second.byteLength, sha256: sha256(second) },
      ],
      requestKey: 'batch-multi',
    });
    const view = await service.getBatch(caller(db, user), created.batchId);
    for (const input of view.inputs) {
      const bytes = input.path === 'a.md' ? first : second;
      const chunk = await service.uploadChunk(caller(db, user), { inputId: input.inputId, offset: 0, bytes });
      await service.finishInput(caller(db, user), { inputId: input.inputId, attemptId: chunk.attemptId });
    }

    const result = await service.finalizeBatch(caller(db, user), created.batchId);
    expect(result.created).toBe(2);

    const after = await service.getBatch(caller(db, user), created.batchId);
    const drafts = after.items.map((item) => item.draftId);
    expect(drafts.filter((id) => id !== null)).toHaveLength(2);
    expect(new Set(drafts).size).toBe(2);

    const rows = db.prepare("SELECT payload FROM content_drafts WHERE draft_type = 'review'").all() as Array<{
      payload: string;
    }>;
    const titles = rows.map((row) => (JSON.parse(row.payload) as { title: string }).title).sort();
    expect(titles).toEqual(['第一篇', '第二篇']);
  });

  it('别人的批次不能操作（403）', async () => {
    const { db, service } = setup();
    const owner = insertUser(db);
    const other = insertUser(db);
    const md = Buffer.from('z', 'utf8');
    const created = await service.createBatch(caller(db, owner), {
      inputs: [{ path: 'a.md', kind: 'markdown', byteSize: md.byteLength, sha256: sha256(md) }],
      requestKey: 'batch-6',
    });
    const inputId = (await service.getBatch(caller(db, owner), created.batchId)).inputs[0].inputId;

    try {
      await service.uploadChunk(caller(db, other), { inputId, offset: 0, bytes: md });
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.FORBIDDEN);
    }
  });
});
