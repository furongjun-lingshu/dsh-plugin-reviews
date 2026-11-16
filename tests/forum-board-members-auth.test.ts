/**
 * 讨论区 · 后台分区管理 GET 的鉴权回归（安全修复单 §6.1）。
 *
 * 起因：`GET /api/admin/forum/boards/{boardId}` 曾经**匿名可读**整份任职名单
 * （含 userId / 昵称 / 头像 / 谁任命的）。规则只写在代码注释里，实现没做。
 *
 * 修复按「本区管理者与站方管理员都能看」落实（使用者 2026-11-16 裁定方案 C）：
 *   - 匿名                → 401
 *   - 登录但无关          → 403
 *   - 本区 owner / 协管   → 200
 *   - 站方管理员          → 200
 *
 * 这一组用例钉的是**鉴权边界**，不是返回体字段。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 会话 Cookie 的可变桩：读取时按当前值返回。 */
const auth = vi.hoisted(() => ({ token: null as string | null }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (auth.token === null ? undefined : { name, value: auth.token }),
  }),
}));

import { GET } from '../src/app/api/admin/forum/boards/[boardId]/route';
import { closeDb, type SqliteDatabase } from '../src/server/platform/db';
import { createIdentityService } from '../src/server/modules/identity';
import { createForumBoardService, ensureDefaultBoards } from '../src/server/modules/forum/boards';
import { createTestDb, insertUser, type TestDb } from './support/db';

let h: TestDb;
let db: SqliteDatabase;

beforeEach(() => {
  h = createTestDb();
  db = h.db;
  process.env.DSH_REVIEW_DB_PATH = h.file;
  closeDb();
  auth.token = null;
});

afterEach(() => {
  closeDb();
  h.cleanup();
  delete process.env.DSH_REVIEW_DB_PATH;
  auth.token = null;
});

/** 以指定用户开一个真实会话，并把它的明文凭证塞进 Cookie 桩。 */
async function signIn(userId: string): Promise<void> {
  const identity = createIdentityService({ db });
  const session = await identity.createSession(userId, Date.now());
  auth.token = session.token;
}

function boardParams(boardId: string): { params: Promise<{ boardId: string }> } {
  return { params: Promise.resolve({ boardId }) };
}

interface ErrorBody {
  ok: false;
  error: { code: string; message: string };
}

function setup() {
  // ⚠️ 顺序不能反：ensureDefaultBoards 要求库里已有用户，否则直接 return 不建分区。
  const admin = insertUser(db, { role: 'admin' });
  const owner = insertUser(db);
  const moderator = insertUser(db);
  const stranger = insertUser(db);
  ensureDefaultBoards(db);
  const service = createForumBoardService({ db });
  const board = db.prepare("SELECT id FROM forum_boards WHERE slug = 'general'").get() as { id: string };
  return { admin, owner, moderator, stranger, service, boardId: board.id };
}

describe('GET 后台分区管理：任职名单的读取边界', () => {
  it('匿名 → 401（不是 200，也不是 403）', async () => {
    const { boardId } = setup();
    const res = await GET(new Request('https://review.test/x'), boardParams(boardId));
    const body = (await res.json()) as ErrorBody;
    expect(res.status).toBe(401);
    expect(body.error.code).toBe('unauthenticated');
  });

  it('登录但既非管理员也非本区成员 → 403', async () => {
    const { stranger, boardId } = setup();
    await signIn(stranger);
    const res = await GET(new Request('https://review.test/x'), boardParams(boardId));
    const body = (await res.json()) as ErrorBody;
    expect(res.status).toBe(403);
    expect(body.error.code).toBe('forbidden');
  });

  it('本区区长 → 200，能拿到名单', async () => {
    const { admin, owner, boardId } = setup();
    // granted_by 是 NOT NULL：任命人必须有，这里用管理员。
    db.prepare("INSERT INTO forum_board_moderators (board_id, user_id, role, granted_by, created_at) VALUES (?, ?, 'owner', ?, ?)")
      .run(boardId, owner, admin, Date.now());

    await signIn(owner);
    const res = await GET(new Request('https://review.test/x'), boardParams(boardId));
    expect(res.status).toBe(200);
    // 成功体是 { ok, data, request_id } 的包装，内容在 data 里。
    const body = (await res.json()) as { ok: boolean; data: { members: unknown[] } };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data.members)).toBe(true);
  });

  it('本区协管 → 200（读名单不是管理动作，协管也该能看）', async () => {
    const { admin, moderator, boardId } = setup();
    db.prepare("INSERT INTO forum_board_moderators (board_id, user_id, role, granted_by, created_at) VALUES (?, ?, 'moderator', ?, ?)")
      .run(boardId, moderator, admin, Date.now());

    await signIn(moderator);
    const res = await GET(new Request('https://review.test/x'), boardParams(boardId));
    expect(res.status).toBe(200);
  });

  it('站方管理员 → 200', async () => {
    const { admin, boardId } = setup();
    await signIn(admin);
    const res = await GET(new Request('https://review.test/x'), boardParams(boardId));
    expect(res.status).toBe(200);
  });
});