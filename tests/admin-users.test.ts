/**
 * 站内用户管理（服务层 `src/server/modules/identity/admin.ts`）。
 *
 * 规划要求"日常数据管理全部通过后台页面完成，不得要求管理员直接改数据库表"，
 * 这里证明服务层把那件事做**对**了，而不是"看起来有接口"：
 *  1. **最后一名可用管理员**撤销不掉、也禁不掉（否则没人能审内容，而且不做部分写入）；
 *  2. **CAS**：`management_version` / `account_status_version` 不符一律版本冲突，
 *     不静默放过、不改任何数据（版本比对排在"无变更"判定之前）；
 *  3. **原因必填**（禁用/恢复）：空或纯空白 → `input_invalid`；
 *  4. **幂等**：同键同摘要重放不重复执行、不写第二条审计；同键不同摘要 → `request_key_reused`；
 *  5. **审计**：每一次真实变更都留下一条 `operation_records`（含操作者、目标、前后值、原因），
 *     管理员改自己的角色也照记不误；
 *  6. **禁用即踢下线**：撤销该用户所有仍然有效的会话，且不覆盖已有的撤销时间；
 *     被禁用账户既不能建新会话，也不能通过重新登录绕过（登录读 `account_status` 的既有口径未被破坏）；
 *  7. **不提权**：普通用户（含"给自己授予管理员"）在服务层就被拒。
 *
 * 这些用例都是对着"删掉守卫/删掉 CAS/删掉回执"会变红的写法来的。
 * 服务层函数是同步的（better-sqlite3 事务回调必须同步），因此断言用 `expectDomainError`
 * 而不是 `rejects.toMatchObject`。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertUser, type TestDb } from './support/db';
import {
  SET_USER_ROLE_ACTION,
  SET_USER_STATUS_ACTION,
  countActiveAdmins,
  listUsers,
  setUserRole,
  setUserStatus,
  toUserJson,
} from '@/server/modules/identity/admin';
import { createIdentityService } from '@/server/modules/identity';
import type { IdentifiedGithubUser } from '@/server/modules/identity/types';
import { newId } from '@/server/platform/id';

let ctxDb: TestDb | null = null;

afterEach(() => {
  ctxDb?.cleanup();
  ctxDb = null;
});

function setup(): TestDb {
  ctxDb = createTestDb();
  return ctxDb;
}

// ---------------------------------------------------------------- 测试工具

interface DomainErrorShape {
  code: string;
  message: string;
  fields?: Array<{ path: string; message: string }>;
  context?: Record<string, string | number | boolean | null>;
}

/** 断言同步的服务层调用抛出业务错误（DomainError），并把它交出来给用例逐项检查。 */
function expectDomainError(fn: () => unknown): DomainErrorShape {
  try {
    fn();
  } catch (e) {
    const candidate = e as Partial<DomainErrorShape> & { name?: string };
    if (candidate.name !== 'DomainError' || typeof candidate.code !== 'string') {
      throw new Error(`预期抛出 DomainError，实际抛出：${String(e)}`);
    }
    return {
      code: candidate.code,
      message: String(candidate.message),
      fields: candidate.fields,
      context: candidate.context,
    };
  }
  throw new Error('预期抛出业务错误，但操作成功了');
}

/** 绑定一条 GitHub 身份（`users` 行由首次登录建立，这里直接造行以便测列表与登录口径）。 */
function bindGithub(db: TestDb['db'], userId: string, login: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO external_identities
       (id, user_id, provider, provider_user_id, provider_username, profile_url, avatar_url, created_at, synced_at)
     VALUES (?, ?, 'github', ?, ?, ?, NULL, ?, ?)`,
  ).run(newId(now), userId, `gh-${login}`, login, `https://github.com/${login}`, now, now);
}

/**
 * 部署绑定的超级管理员（新架构：授/撤管理员是**超管专属**，且必须带确认昵称）。
 * 给 actor 绑上固定 login，并把同一个 provider_user_id 设进注入的 env。
 */
const SUPER_LOGIN = 'super-admin';
const SUPER_ENV: NodeJS.ProcessEnv = { NODE_ENV: 'test', SUPER_ADMIN_GITHUB_ID: `gh-${SUPER_LOGIN}` };
/** 未配置超级管理员的部署视图（NODE_ENV 是 ProcessEnv 的必填字段）。 */
const NO_SUPER_ENV: NodeJS.ProcessEnv = { NODE_ENV: 'test' };

function insertSuperAdmin(db: TestDb['db'], nickname = '超级管理员'): string {
  const id = insertUser(db, { nickname, role: 'admin' });
  bindGithub(db, id, SUPER_LOGIN);
  return id;
}

function githubIdentity(login: string): IdentifiedGithubUser {
  return {
    providerUserId: `gh-${login}`,
    providerUsername: login,
    profileUrl: `https://github.com/${login}`,
    avatarUrl: null,
    displayName: login,
  };
}

interface UserRow {
  role: 'user' | 'admin';
  account_status: 'active' | 'disabled';
  management_version: number;
  account_status_version: number;
}

function userRow(db: TestDb['db'], userId: string): UserRow {
  return db
    .prepare('SELECT role, account_status, management_version, account_status_version FROM users WHERE id = ?')
    .get(userId) as UserRow;
}

interface AuditRow {
  id: string;
  action_type: string;
  operation_key: string;
  actor_kind: string;
  actor_user_id: string | null;
  target_type: string;
  target_id: string;
  changes: string;
  reason: string;
}

function auditRows(db: TestDb['db'], actionType: string): AuditRow[] {
  return db
    .prepare('SELECT * FROM operation_records WHERE action_type = ? ORDER BY created_at ASC, id ASC')
    .all(actionType) as AuditRow[];
}

function parseChanges(row: AuditRow): Record<string, unknown> {
  return JSON.parse(row.changes) as Record<string, unknown>;
}

// ============================================================
// 1) 列表
// ============================================================

describe('用户管理 · 列表', () => {
  it('列出 GitHub 账号、昵称、角色、账户状态、注册与最近登录时间（管理员在前）', () => {
    const { db } = setup();
    const normal = insertUser(db, { nickname: '普通用户' });
    bindGithub(db, normal, 'normal-user');
    const admin = insertUser(db, { nickname: '管理员', role: 'admin' });
    bindGithub(db, admin, 'liceses');
    insertUser(db, { nickname: '被封的', accountStatus: 'disabled' });
    const loginAt = Date.now();
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(loginAt, admin);

    const users = listUsers(db);
    expect(users).toHaveLength(3);
    // 管理员在前（与 scripts/set-super-admin.mjs --list 同口径）
    expect(users[0]!.userId).toBe(admin);
    expect(users[0]).toMatchObject({
      nickname: '管理员',
      githubLogin: 'liceses',
      role: 'admin',
      accountStatus: 'active',
      managementVersion: 0,
      accountStatusVersion: 0,
      lastLoginAt: loginAt,
    });
    expect(users[1]!.nickname).toBe('普通用户');
    expect(users[2]).toMatchObject({ nickname: '被封的', accountStatus: 'disabled', githubLogin: null });
    expect(countActiveAdmins(db)).toBe(1);
    // 没配 SUPER_ADMIN_GITHUB_ID 时，没有任何人被标成超级管理员（fail-closed）
    expect(users.every((u) => u.isSuperAdmin === false)).toBe(true);

    // 接口层 JSON 形状（GET 与 PATCH 共用一份）
    expect(toUserJson(users[0]!)).toMatchObject({
      user_id: admin,
      github_login: 'liceses',
      role: 'admin',
      account_status: 'active',
      management_version: 0,
      account_status_version: 0,
    });
  });
});

// ============================================================
// 2) 角色变更
// ============================================================

describe('用户管理 · 角色变更', () => {
  it('授予管理员：CAS 通过、版本 +1、写一条审计（含操作者/目标/前后值/原因）', () => {
    const { db } = setup();
    const admin = insertSuperAdmin(db, '管理员');
    const target = insertUser(db, { nickname: '候选人' });

    const result = setUserRole(
      db,
      {
        actorUserId: admin,
        targetUserId: target,
        role: 'admin',
        expectedManagementVersion: 0,
        confirmTargetNickname: '候选人',
        requestKey: 'rk-grant-1',
      },
      SUPER_ENV,
    );

    expect(result).toMatchObject({ changed: true, replayed: false, revokedSessionCount: 0 });
    expect(result.user).toMatchObject({ userId: target, role: 'admin', managementVersion: 1 });
    expect(userRow(db, target)).toMatchObject({ role: 'admin', management_version: 1 });
    expect(countActiveAdmins(db)).toBe(2);

    const audits = auditRows(db, SET_USER_ROLE_ACTION);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      operation_key: 'rk-grant-1',
      actor_kind: 'admin',
      actor_user_id: admin,
      target_type: 'user',
      target_id: target,
      reason: '授予管理员权限。',
    });
    expect(parseChanges(audits[0]!)).toMatchObject({
      from_role: 'user',
      to_role: 'admin',
      management_version_before: 0,
      management_version_after: 1,
    });
  });

  it('超级管理员不可剥夺：连他自己都撤销不了（且不做任何写入）', () => {
    const { db } = setup();
    const superAdmin = insertSuperAdmin(db, '唯一管理员');
    insertUser(db, { nickname: '普通用户' });

    const e = expectDomainError(() =>
      setUserRole(
        db,
        {
          actorUserId: superAdmin,
          targetUserId: superAdmin,
          role: 'user',
          expectedManagementVersion: 0,
          confirmTargetNickname: '唯一管理员',
          requestKey: 'rk-revoke-super',
        },
        SUPER_ENV,
      ),
    );
    expect(e.code).toBe('forbidden');
    expect(e.context?.guard).toBe('super_admin_immutable');
    expect(e.message).toContain('超级管理员');

    // 没有部分写入：角色与版本原样，也没有留下审计
    expect(userRow(db, superAdmin)).toMatchObject({ role: 'admin', management_version: 0 });
    expect(auditRows(db, SET_USER_ROLE_ACTION)).toHaveLength(0);
    expect(countActiveAdmins(db)).toBe(1);
  });

  it('普通管理员没有授予/撤销权：403 super_admin_required（未配置超管时同理）', () => {
    const { db } = setup();
    const normalAdmin = insertUser(db, { nickname: '普通管理员', role: 'admin' });
    bindGithub(db, normalAdmin, 'just-an-admin');
    const target = insertUser(db, { nickname: '候选人' });

    const e = expectDomainError(() =>
      setUserRole(
        db,
        {
          actorUserId: normalAdmin,
          targetUserId: target,
          role: 'admin',
          expectedManagementVersion: 0,
          confirmTargetNickname: '候选人',
          requestKey: 'rk-not-super',
        },
        SUPER_ENV,
      ),
    );
    expect(e.code).toBe('forbidden');
    expect(e.context?.guard).toBe('super_admin_required');
    expect(e.context?.super_admin_configured).toBe(true);
    expect(userRow(db, target).role).toBe('user');
  });

  it('部署没配超级管理员时：谁都不能授予管理员（fail-closed，不是"谁都能提权"）', () => {
    const { db } = setup();
    const admin = insertSuperAdmin(db, '管理员');
    const target = insertUser(db, { nickname: '候选人' });

    const e = expectDomainError(() =>
      setUserRole(
        db,
        {
          actorUserId: admin,
          targetUserId: target,
          role: 'admin',
          expectedManagementVersion: 0,
          confirmTargetNickname: '候选人',
          requestKey: 'rk-unconfigured',
        },
        NO_SUPER_ENV,
      ),
    );
    expect(e.code).toBe('forbidden');
    expect(e.context?.guard).toBe('super_admin_required');
    expect(e.context?.super_admin_configured).toBe(false);
  });

  it('显式确认是硬闸：缺确认或昵称不一致一律 input_invalid，不改数据', () => {
    const { db } = setup();
    const admin = insertSuperAdmin(db, '管理员');
    const target = insertUser(db, { nickname: '候选人' });

    const missing = expectDomainError(() =>
      setUserRole(
        db,
        { actorUserId: admin, targetUserId: target, role: 'admin', expectedManagementVersion: 0, requestKey: 'rk-no-confirm' },
        SUPER_ENV,
      ),
    );
    expect(missing.code).toBe('input_invalid');
    expect(missing.fields?.map((f) => f.path)).toContain('confirm_target_nickname');

    const wrong = expectDomainError(() =>
      setUserRole(
        db,
        {
          actorUserId: admin,
          targetUserId: target,
          role: 'admin',
          expectedManagementVersion: 0,
          confirmTargetNickname: '不是他',
          requestKey: 'rk-wrong-confirm',
        },
        SUPER_ENV,
      ),
    );
    expect(wrong.code).toBe('input_invalid');
    expect(userRow(db, target).role).toBe('user');
    expect(auditRows(db, SET_USER_ROLE_ACTION)).toHaveLength(0);
  });

  it('已禁用的管理员不算"可用管理员"：撤销被禁用的管理员不触发守卫', () => {
    const { db } = setup();
    const active = insertSuperAdmin(db, '在任管理员');
    const asleep = insertUser(db, { nickname: '停用管理员', role: 'admin', accountStatus: 'disabled' });

    const result = setUserRole(
      db,
      {
        actorUserId: active,
        targetUserId: asleep,
        role: 'user',
        expectedManagementVersion: 0,
        confirmTargetNickname: '停用管理员',
        requestKey: 'rk-revoke-disabled-admin',
      },
      SUPER_ENV,
    );
    expect(result.user.role).toBe('user');
    expect(countActiveAdmins(db)).toBe(1);
  });

  it('有第二名可用管理员时，撤销是允许的（守卫不能误伤）', () => {
    const { db } = setup();
    const a = insertUser(db, { nickname: '甲', role: 'admin' });
    const b = insertSuperAdmin(db, '乙');

    const result = setUserRole(
      db,
      {
        actorUserId: b,
        targetUserId: a,
        role: 'user',
        expectedManagementVersion: 0,
        confirmTargetNickname: '甲',
        requestKey: 'rk-revoke-ok',
      },
      SUPER_ENV,
    );
    expect(result.user).toMatchObject({ userId: a, role: 'user', managementVersion: 1 });
    expect(countActiveAdmins(db)).toBe(1);
  });

  it('CAS：management_version 不符一律版本冲突，且不改任何数据', () => {
    const { db } = setup();
    const admin = insertSuperAdmin(db, '管理员');
    const target = insertUser(db, { nickname: '候选人' });

    const e = expectDomainError(() =>
      setUserRole(
        db,
        {
          actorUserId: admin,
          targetUserId: target,
          role: 'admin',
          expectedManagementVersion: 7,
          confirmTargetNickname: '候选人',
          requestKey: 'rk-stale',
        },
        SUPER_ENV,
      ),
    );
    expect(e.code).toBe('version_conflict');
    expect(e.context).toMatchObject({ current_management_version: 0, expected_management_version: 7 });

    expect(userRow(db, target)).toMatchObject({ role: 'user', management_version: 0 });
    expect(auditRows(db, SET_USER_ROLE_ACTION)).toHaveLength(0);
  });

  it('幂等：同键同内容重放不重复执行、不写第二条审计、版本只加一次', () => {
    const { db } = setup();
    const admin = insertSuperAdmin(db, '管理员');
    const target = insertUser(db, { nickname: '候选人' });
    const input = {
      actorUserId: admin,
      targetUserId: target,
      role: 'admin' as const,
      expectedManagementVersion: 0,
      confirmTargetNickname: '候选人',
      requestKey: 'rk-same',
    };

    const first = setUserRole(db, input, SUPER_ENV);
    const second = setUserRole(db, input, SUPER_ENV);

    expect(first).toMatchObject({ changed: true, replayed: false });
    expect(second).toMatchObject({ changed: true, replayed: true });
    expect(second.user).toMatchObject({ userId: target, role: 'admin', managementVersion: 1 });
    expect(userRow(db, target).management_version).toBe(1);
    expect(auditRows(db, SET_USER_ROLE_ACTION)).toHaveLength(1);
  });

  it('同键不同内容 → request_key_reused（不覆盖历史）', () => {
    const { db } = setup();
    const admin = insertSuperAdmin(db, '管理员');
    const target = insertUser(db, { nickname: '候选人' });

    setUserRole(
      db,
      {
        actorUserId: admin,
        targetUserId: target,
        role: 'admin',
        expectedManagementVersion: 0,
        confirmTargetNickname: '候选人',
        requestKey: 'rk-reuse',
      },
      SUPER_ENV,
    );

    const e = expectDomainError(() =>
      setUserRole(
        db,
        {
          actorUserId: admin,
          targetUserId: target,
          role: 'user',
          expectedManagementVersion: 1,
          confirmTargetNickname: '候选人',
          requestKey: 'rk-reuse',
        },
        SUPER_ENV,
      ),
    );
    expect(e.code).toBe('request_key_reused');
    // 历史未被覆盖，角色也没被这次请求改回去
    expect(userRow(db, target)).toMatchObject({ role: 'admin', management_version: 1 });
    expect(auditRows(db, SET_USER_ROLE_ACTION)).toHaveLength(1);
  });

  it('绝不提权：普通用户（含给自己授予管理员）在服务层就被拒', () => {
    const { db } = setup();
    insertUser(db, { nickname: '管理员', role: 'admin' });
    const normal = insertUser(db, { nickname: '普通人' });

    const e = expectDomainError(() =>
      setUserRole(db, {
        actorUserId: normal,
        targetUserId: normal,
        role: 'admin',
        expectedManagementVersion: 0,
        requestKey: 'rk-self-promote',
      }),
    );
    expect(e.code).toBe('forbidden');
    expect(e.context).toBeUndefined();

    expect(userRow(db, normal).role).toBe('user');
    expect(auditRows(db, SET_USER_ROLE_ACTION)).toHaveLength(0);
  });

  it('已禁用的管理员（actor）也不能操作；不存在的 actor 一样是 forbidden', () => {
    const { db } = setup();
    const asleep = insertUser(db, { nickname: '停用管理员', role: 'admin', accountStatus: 'disabled' });
    const target = insertUser(db, { nickname: '候选人' });

    for (const actorUserId of [asleep, newId(), '']) {
      const e = expectDomainError(() =>
        setUserRole(db, {
          actorUserId,
          targetUserId: target,
          role: 'admin',
          expectedManagementVersion: 0,
          requestKey: `rk-actor-${actorUserId || 'empty'}`,
        }),
      );
      expect(['forbidden', 'unauthenticated']).toContain(e.code);
    }
    expect(userRow(db, target).role).toBe('user');
  });

  it('超管撤销另一名管理员：审计记下谁、对谁、前后角色、原因（且标记目标当时是否超管）', () => {
    const { db } = setup();
    const superAdmin = insertSuperAdmin(db, '超管');
    const other = insertUser(db, { nickname: '甲', role: 'admin' });

    const result = setUserRole(
      db,
      {
        actorUserId: superAdmin,
        targetUserId: other,
        role: 'user',
        expectedManagementVersion: 0,
        confirmTargetNickname: '甲',
        requestKey: 'rk-revoke-other',
        reason: '他离职了，收回权限。',
      },
      SUPER_ENV,
    );

    expect(result.user).toMatchObject({ userId: other, role: 'user', managementVersion: 1 });

    const audits = auditRows(db, SET_USER_ROLE_ACTION);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      operation_key: 'rk-revoke-other',
      actor_user_id: superAdmin,
      target_id: other,
      reason: '他离职了，收回权限。',
    });
    expect(parseChanges(audits[0]!)).toMatchObject({
      target_is_super_admin: false,
      from_role: 'admin',
      to_role: 'user',
      management_version_before: 0,
      management_version_after: 1,
    });
  });

  it('不给已禁用账户授予管理员（与 CLI 同口径：否则会造出"是管理员但登不进来"的空位）', () => {
    const { db } = setup();
    const admin = insertSuperAdmin(db, '管理员');
    const asleep = insertUser(db, { nickname: '被封的', accountStatus: 'disabled' });

    const e = expectDomainError(() =>
      setUserRole(
        db,
        {
          actorUserId: admin,
          targetUserId: asleep,
          role: 'admin',
          expectedManagementVersion: 0,
          confirmTargetNickname: '被封的',
          requestKey: 'rk-grant-disabled',
        },
        SUPER_ENV,
      ),
    );
    expect(e.code).toBe('forbidden');
    expect(e.context?.guard).toBe('disabled_account');
    expect(userRow(db, asleep).role).toBe('user');
    expect(auditRows(db, SET_USER_ROLE_ACTION)).toHaveLength(0);
  });
});

// ============================================================
// 3) 账户状态变更
// ============================================================

describe('用户管理 · 账户状态变更', () => {
  it('原因必填：空或纯空白 → input_invalid，且不改数据、不写审计', () => {
    const { db } = setup();
    const admin = insertUser(db, { nickname: '管理员', role: 'admin' });
    const target = insertUser(db, { nickname: '捣乱的' });

    for (const reason of ['', '   ', '\n\t']) {
      const e = expectDomainError(() =>
        setUserStatus(db, {
          actorUserId: admin,
          targetUserId: target,
          status: 'disabled',
          reason,
          expectedAccountStatusVersion: 0,
          requestKey: `rk-noreason-${reason.length}`,
        }),
      );
      expect(e.code).toBe('input_invalid');
      expect(e.fields?.map((f) => f.path)).toContain('reason');
    }

    expect(userRow(db, target).account_status).toBe('active');
    expect(auditRows(db, SET_USER_STATUS_ACTION)).toHaveLength(0);
  });

  it('禁用：撤销该用户所有仍然有效的会话，且不覆盖已有的撤销时间', async () => {
    const { db } = setup();
    const admin = insertUser(db, { nickname: '管理员', role: 'admin' });
    const target = insertUser(db, { nickname: '捣乱的' });
    const identity = createIdentityService({ db });
    const t0 = Date.now();

    const first = await identity.createSession(target, t0);
    const second = await identity.createSession(target, t0);
    await identity.revokeSession(first.sessionId, t0 + 1000); // 早就撤销过的那一个

    const result = setUserStatus(db, {
      actorUserId: admin,
      targetUserId: target,
      status: 'disabled',
      reason: '刷屏',
      expectedAccountStatusVersion: 0,
      requestKey: 'rk-disable-1',
    });

    expect(result).toMatchObject({ changed: true, replayed: false, revokedSessionCount: 1 });
    expect(userRow(db, target)).toMatchObject({ account_status: 'disabled', account_status_version: 1 });

    const sessions = db
      .prepare('SELECT id, revoked_at FROM user_sessions WHERE user_id = ?')
      .all(target) as Array<{ id: string; revoked_at: number | null }>;
    const byId = new Map(sessions.map((s) => [s.id, s.revoked_at]));
    expect(byId.get(first.sessionId)).toBe(t0 + 1000); // 原始撤销时间没被改写
    expect(byId.get(second.sessionId)).not.toBeNull();
    expect(await identity.resolveSession(second.token, t0 + 2000)).toBeNull();

    const audits = auditRows(db, SET_USER_STATUS_ACTION);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      operation_key: 'rk-disable-1',
      actor_user_id: admin,
      target_id: target,
      reason: '刷屏',
    });
    expect(parseChanges(audits[0]!)).toMatchObject({
      from_status: 'active',
      to_status: 'disabled',
      revoked_sessions: 1,
      account_status_version_before: 0,
      account_status_version_after: 1,
    });
  });

  it('幂等：同键同内容重放不重复执行、不写第二条审计（撤销会话数来自回执）', () => {
    const { db } = setup();
    const admin = insertUser(db, { nickname: '管理员', role: 'admin' });
    const target = insertUser(db, { nickname: '捣乱的' });
    const input = {
      actorUserId: admin,
      targetUserId: target,
      status: 'disabled' as const,
      reason: '刷屏',
      expectedAccountStatusVersion: 0,
      requestKey: 'rk-status-same',
    };

    const first = setUserStatus(db, input);
    const second = setUserStatus(db, input);

    expect(first).toMatchObject({ replayed: false, revokedSessionCount: 0 });
    expect(second).toMatchObject({ replayed: true, changed: true, revokedSessionCount: 0 });
    expect(userRow(db, target).account_status_version).toBe(1);
    expect(auditRows(db, SET_USER_STATUS_ACTION)).toHaveLength(1);
  });

  it('同键不同内容（禁用 → 恢复）→ request_key_reused', () => {
    const { db } = setup();
    const admin = insertUser(db, { nickname: '管理员', role: 'admin' });
    const target = insertUser(db, { nickname: '捣乱的' });

    setUserStatus(db, {
      actorUserId: admin,
      targetUserId: target,
      status: 'disabled',
      reason: '刷屏',
      expectedAccountStatusVersion: 0,
      requestKey: 'rk-status-reuse',
    });

    const e = expectDomainError(() =>
      setUserStatus(db, {
        actorUserId: admin,
        targetUserId: target,
        status: 'active',
        reason: '记错了',
        expectedAccountStatusVersion: 1,
        requestKey: 'rk-status-reuse',
      }),
    );
    expect(e.code).toBe('request_key_reused');
    expect(userRow(db, target).account_status).toBe('disabled');
  });

  it('拒绝禁用最后一名可用管理员', () => {
    const { db } = setup();
    const admin = insertUser(db, { nickname: '唯一管理员', role: 'admin' });

    const e = expectDomainError(() =>
      setUserStatus(db, {
        actorUserId: admin,
        targetUserId: admin,
        status: 'disabled',
        reason: '我累了',
        expectedAccountStatusVersion: 0,
        requestKey: 'rk-disable-last',
      }),
    );
    expect(e.code).toBe('forbidden');
    expect(e.context?.guard).toBe('last_active_admin');

    expect(userRow(db, admin)).toMatchObject({ account_status: 'active', account_status_version: 0 });
    expect(auditRows(db, SET_USER_STATUS_ACTION)).toHaveLength(0);
  });

  it('CAS：account_status_version 不符 → version_conflict，不写入', () => {
    const { db } = setup();
    const admin = insertUser(db, { nickname: '管理员', role: 'admin' });
    const target = insertUser(db, { nickname: '捣乱的' });

    const e = expectDomainError(() =>
      setUserStatus(db, {
        actorUserId: admin,
        targetUserId: target,
        status: 'disabled',
        reason: '刷屏',
        expectedAccountStatusVersion: 3,
        requestKey: 'rk-status-stale',
      }),
    );
    expect(e.code).toBe('version_conflict');
    expect(e.context).toMatchObject({ current_account_status_version: 0, expected_account_status_version: 3 });
    expect(userRow(db, target).account_status).toBe('active');
    expect(auditRows(db, SET_USER_STATUS_ACTION)).toHaveLength(0);
  });

  it('目标本来就是该状态 → 无变更（不递增版本、不写审计）', () => {
    const { db } = setup();
    const admin = insertUser(db, { nickname: '管理员', role: 'admin' });
    const target = insertUser(db, { nickname: '本来就好好的' });

    const result = setUserStatus(db, {
      actorUserId: admin,
      targetUserId: target,
      status: 'active',
      reason: '想恢复但没被禁用过',
      expectedAccountStatusVersion: 0,
      requestKey: 'rk-nochange',
    });
    expect(result).toMatchObject({ changed: false, replayed: false, revokedSessionCount: 0 });
    expect(userRow(db, target).account_status_version).toBe(0);
    expect(auditRows(db, SET_USER_STATUS_ACTION)).toHaveLength(0);
  });

  it('禁用后：建不了新会话、登录被拒（读 account_status 的既有口径没被破坏）', async () => {
    const { db } = setup();
    const admin = insertUser(db, { nickname: '管理员', role: 'admin' });
    const target = insertUser(db, { nickname: '捣乱的' });
    bindGithub(db, target, 'trouble');
    const identity = createIdentityService({ db, env: { NODE_ENV: 'test' } });
    const t0 = Date.now();
    const before = await identity.createSession(target, t0);
    expect(await identity.resolveSession(before.token, t0)).not.toBeNull();

    setUserStatus(db, {
      actorUserId: admin,
      targetUserId: target,
      status: 'disabled',
      reason: '刷屏',
      expectedAccountStatusVersion: 0,
      requestKey: 'rk-disable-login',
    });

    // ① 旧令牌立刻失效（会话已撤销 + 账户已禁用）
    expect(await identity.resolveSession(before.token, t0 + 1)).toBeNull();
    // ② 不能建新会话
    await expect(identity.createSession(target, t0 + 2)).rejects.toMatchObject({ code: 'account_disabled' });
    // ③ 重新登录也不能绕过禁用
    await expect(identity.signInWithGithub(githubIdentity('trouble'), t0 + 3)).rejects.toMatchObject({
      code: 'account_disabled',
    });
  });

  it('恢复：撤销过的会话不会复活，但可以重新登录、重新建会话', async () => {
    const { db } = setup();
    const admin = insertUser(db, { nickname: '管理员', role: 'admin' });
    const target = insertUser(db, { nickname: '改过自新' });
    bindGithub(db, target, 'repent');
    const identity = createIdentityService({ db, env: { NODE_ENV: 'test' } });
    const t0 = Date.now();
    const old = await identity.createSession(target, t0);

    setUserStatus(db, {
      actorUserId: admin,
      targetUserId: target,
      status: 'disabled',
      reason: '先封一下',
      expectedAccountStatusVersion: 0,
      requestKey: 'rk-disable-then-restore',
    });
    const restored = setUserStatus(db, {
      actorUserId: admin,
      targetUserId: target,
      status: 'active',
      reason: '查清了，是误封',
      expectedAccountStatusVersion: 1,
      requestKey: 'rk-restore',
    });

    expect(restored.user).toMatchObject({ accountStatus: 'active', accountStatusVersion: 2 });
    // 旧会话是"被撤销"而不是"被暂停"：恢复账户不会把它变回可用
    expect(await identity.resolveSession(old.token, Date.now())).toBeNull();
    // 但可以重新走登录/建会话
    const again = await identity.signInWithGithub(githubIdentity('repent'), Date.now());
    expect(again.created).toBe(false);
    await expect(identity.createSession(target, Date.now())).resolves.toMatchObject({ sessionId: expect.any(String) });
  });
});

// ============================================================
// 5) 超级管理员（部署绑定：唯一、不可剥夺、登录即生效）
// ============================================================

describe('用户管理 · 超级管理员（部署绑定）', () => {
  it('超级管理员不可被禁用（连他自己操作也不行）', () => {
    const { db } = setup();
    const superAdmin = insertSuperAdmin(db, '超管');

    const e = expectDomainError(() =>
      setUserStatus(
        db,
        {
          actorUserId: superAdmin,
          targetUserId: superAdmin,
          status: 'disabled',
          reason: '手滑',
          expectedAccountStatusVersion: 0,
          requestKey: 'rk-disable-super',
        },
        SUPER_ENV,
      ),
    );
    expect(e.code).toBe('forbidden');
    expect(e.context?.guard).toBe('super_admin_immutable');
    expect(userRow(db, superAdmin)).toMatchObject({ account_status: 'active', account_status_version: 0 });
    expect(auditRows(db, SET_USER_STATUS_ACTION)).toHaveLength(0);
  });

  it('列表与 JSON 暴露 is_super_admin：只认部署配置里那一个身份', () => {
    const { db } = setup();
    const superAdmin = insertSuperAdmin(db, '超管');
    const otherAdmin = insertUser(db, { nickname: '普通管理员', role: 'admin' });
    bindGithub(db, otherAdmin, 'just-an-admin');

    const users = listUsers(db, SUPER_ENV);
    expect(users.find((u) => u.userId === superAdmin)?.isSuperAdmin).toBe(true);
    expect(users.find((u) => u.userId === otherAdmin)?.isSuperAdmin).toBe(false);
    expect(toUserJson(users.find((u) => u.userId === superAdmin)!)).toMatchObject({ is_super_admin: true });

    // 同一份数据、未配置超管时：没有人是超管（身份由部署配置决定，不落库）
    expect(listUsers(db, NO_SUPER_ENV).every((u) => u.isSuperAdmin === false)).toBe(true);
  });

  it('部署配置的超管身份登录即绑定为管理员；被降权后再登录仍会恢复（恒定绑定）', async () => {
    const { db } = setup();
    const identity = createIdentityService({ db, env: SUPER_ENV });

    const first = await identity.signInWithGithub(githubIdentity(SUPER_LOGIN), Date.now());
    expect(first.created).toBe(true);
    expect(userRow(db, first.userId).role).toBe('admin');

    // 有人（或历史遗留的直改库）把他降成 user：下次登录仍会回到管理员 ——
    // 因为"谁是超管"是部署配置，不是可以被站内操作改掉的数据库状态。
    db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(first.userId);
    const again = await identity.signInWithGithub(githubIdentity(SUPER_LOGIN), Date.now());
    expect(again.created).toBe(false);
    expect(userRow(db, first.userId).role).toBe('admin');

    // 会话解析也带出超管标志（接口层与界面据此显示"超级管理员"）
    const session = await identity.createSession(first.userId, Date.now());
    const resolved = await identity.resolveSession(session.token, Date.now());
    expect(resolved).toMatchObject({ userId: first.userId, role: 'admin', isSuperAdmin: true });

    // 反例：普通用户的会话里 isSuperAdmin 必须是 false
    const normal = await identity.signInWithGithub(githubIdentity('someone-else'), Date.now());
    const normalSession = await identity.createSession(normal.userId, Date.now());
    await expect(identity.resolveSession(normalSession.token, Date.now())).resolves.toMatchObject({
      isSuperAdmin: false,
    });
  });

  it('配置写成多个 ID → 视为配置错误（fail-closed：谁都不是超管，谁都授不了权）', () => {
    const { db } = setup();
    const a = insertSuperAdmin(db, '超管');
    const target = insertUser(db, { nickname: '候选人' });

    const e = expectDomainError(() =>
      setUserRole(
        db,
        {
          actorUserId: a,
          targetUserId: target,
          role: 'admin',
          expectedManagementVersion: 0,
          confirmTargetNickname: '候选人',
          requestKey: 'rk-multi-config',
        },
        { NODE_ENV: 'test', SUPER_ADMIN_GITHUB_ID: 'gh-super-admin, gh-另一个' },
      ),
    );
    expect(e.code).toBe('forbidden');
    expect(e.context?.guard).toBe('super_admin_required');
    expect(e.context?.super_admin_configured).toBe(false);
  });
});