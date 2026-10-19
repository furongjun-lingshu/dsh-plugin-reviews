/**
 * 站内用户管理（服务层）：列出用户 / 授予或撤销管理员 / 禁用或恢复账户。
 *
 * ## 为什么必须有这个文件
 *
 * 规划要求"日常数据管理全部通过后台页面完成，不得要求管理员直接改数据库表"，
 * 而在它之前，改变用户角色/状态的**唯一**途径是上机脚本（或手拼 SQL：
 * 验收脚本就这么干过 `UPDATE users SET role='admin'`）。本文件把那条 CLI 的口径
 * 搬进服务层，再由 `GET/PATCH /api/admin/users` 暴露给后台页面。
 *
 * ## 与上机脚本一致的口径
 *
 *  1. **至少保留一名可用管理员**（可用 = `role='admin' AND account_status='active'`）：
 *     撤销或禁用会把最后一个可用管理员拿掉时**拒绝执行**，并且不做部分写入（在事务里抛错回滚）；
 *  2. 不给**已禁用**的账户授予管理员：否则会造出一个"是管理员但登不进来"的空位；
 *  3. 目标"本来就是这个状态"不算一次变更（不递增版本、不写审计）。
 *
 * ## 三条与后台路由共用的纪律
 *
 *  - **CAS**：角色用 `users.management_version`、状态用 `users.account_status_version`。
 *    版本不符一律 `version_conflict`（409），且不改任何数据。
 *    （版本比对在"无变更"判定**之前**：版本不对外加静默放过，否则 CAS 就成了摆设。）
 *  - **幂等**：`operation_records(action_type, operation_key=request_key)` 既是审计也是回执。
 *    同键同摘要 → 返回原结果且**不重复执行**；同键不同摘要 → `request_key_reused`（409）。
 *  - **审计**：每一次真实变更在同一事务内写一条 `operation_records`。这里是内联 INSERT，
 *    没有走 `operations.service.record()` —— 后者是 `async`，而 better-sqlite3 的事务回调
 *    必须是同步函数，混用会破坏"业务变更与审计同事务"（与 `modules/catalog/service.ts` 同一处理）。
 *
 * ## 绝不提权
 *
 * 服务层**自己**再校验一次 actor 是不是（仍然在任的）管理员，不依赖路由层：
 * 一个普通用户既不能把自己变成管理员，也不能改别人的角色/状态。
 */

import type { SqliteDatabase } from '@/server/platform/db';
import { getDb } from '@/server/platform/db';
import { withTransaction } from '@/server/platform/tx';
import { newId } from '@/server/platform/id';
import { digest } from '@/server/platform/digest';
import { nowMs } from '@/server/platform/time';
import { SUPER_ADMIN_ENV, configuredSuperAdminId, isSuperAdminProviderId } from './super-admin';
import { DomainError, ErrorCodes, err } from '@/packages/common/errors';

export type UserRole = 'user' | 'admin';
export type AccountStatus = 'active' | 'disabled';

/**
 * 审计动作名（`operation_records.action_type`）。
 *
 * 授予与撤销**共用一个** action_type：这样同一个 `request_key` 先用于授予、
 * 后被复用于撤销时，摘要不同 → 立刻被判 `request_key_reused`，
 * 而不是因为动作名不同而各写一条、悄悄执行两次。禁用/恢复同理。
 */
export const SET_USER_ROLE_ACTION = 'identity.set_user_role';
export const SET_USER_STATUS_ACTION = 'identity.set_user_status';

/** 后台需要的用户视图（服务层类型；接口层用 `toUserJson` 转成 snake_case）。 */
export interface AdminUserView {
  userId: string;
  nickname: string;
  avatarUrl: string | null;
  /** GitHub 登录名（未绑定 GitHub 时为 null）。 */
  githubLogin: string | null;
  /** 是否部署绑定的超级管理员（由 SUPER_ADMIN_GITHUB_ID 决定，不落库）。 */
  isSuperAdmin: boolean;
  role: UserRole;
  accountStatus: AccountStatus;
  managementVersion: number;
  accountStatusVersion: number;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface SetUserRoleInput {
  /** 谁在操作（必须是仍在任的管理员）。 */
  actorUserId: string;
  targetUserId: string;
  role: UserRole;
  /** CAS：调用方读到并期望的 `users.management_version`。 */
  expectedManagementVersion: number;
  /** 幂等键：同一个键重放同一次操作。 */
  requestKey: string;
  /**
   * **显式确认**：授予或撤销管理员时，必须原样重复目标用户的昵称。
   * 不符 → `input_invalid`。这是服务端的一道闸，直接打 API 也绕不过界面上的"手打昵称"。
   */
  confirmTargetNickname?: string;
  /** 可选说明；省略时按动作生成（审计的 reason 不允许为空）。 */
  reason?: string;
}

export interface SetUserStatusInput {
  actorUserId: string;
  targetUserId: string;
  status: AccountStatus;
  /** 禁用/恢复原因，**必填**（空或纯空白一律 `input_invalid`）。 */
  reason: string;
  /** CAS：调用方读到并期望的 `users.account_status_version`。 */
  expectedAccountStatusVersion: number;
  requestKey: string;
}

export interface UserAdminChangeResult {
  /** 变更**之后**（重放时是**当前**）的用户视图，带最新版本号供下一次操作使用。 */
  user: AdminUserView;
  /** 本次请求是否真的改动了数据（重放时表示"原始请求确实变更过"）。 */
  changed: boolean;
  /** 是否是幂等重放（本次没有再次执行）。 */
  replayed: boolean;
  /** 本次撤销的会话数（只有禁用才可能非 0）。 */
  revokedSessionCount: number;
}

/** 接口层共用的用户 JSON 形状（GET 列表与 PATCH 响应**同一份**，避免两处漂移）。 */
export interface AdminUserJson {
  user_id: string;
  nickname: string;
  avatar_url: string | null;
  github_login: string | null;
  is_super_admin: boolean;
  role: UserRole;
  account_status: AccountStatus;
  management_version: number;
  account_status_version: number;
  created_at: number;
  last_login_at: number | null;
}

export function toUserJson(user: AdminUserView): AdminUserJson {
  return {
    user_id: user.userId,
    nickname: user.nickname,
    avatar_url: user.avatarUrl,
    github_login: user.githubLogin,
    is_super_admin: user.isSuperAdmin,
    role: user.role,
    account_status: user.accountStatus,
    management_version: user.managementVersion,
    account_status_version: user.accountStatusVersion,
    created_at: user.createdAt,
    last_login_at: user.lastLoginAt,
  };
}

interface UserViewRow {
  user_id: string;
  nickname: string;
  avatar_url: string | null;
  role: UserRole;
  account_status: AccountStatus;
  management_version: number;
  account_status_version: number;
  created_at: number;
  last_login_at: number | null;
  github_login: string | null;
  github_provider_user_id: string | null;
}

/** 用户视图的**唯一定义**：列出与单条读取共用，避免两处 SQL 漂移。 */
const USER_VIEW_SELECT = `SELECT u.id AS user_id, u.nickname, u.avatar_url, u.role, u.account_status,
                                 u.management_version, u.account_status_version, u.created_at, u.last_login_at,
                                 ei.provider_username AS github_login,
                                 ei.provider_user_id AS github_provider_user_id
                            FROM users u
                            LEFT JOIN external_identities ei ON ei.user_id = u.id AND ei.provider = 'github'`;

function toView(row: UserViewRow, env: NodeJS.ProcessEnv = process.env): AdminUserView {
  return {
    userId: row.user_id,
    nickname: row.nickname,
    avatarUrl: row.avatar_url,
    githubLogin: row.github_login,
    // 超管身份从部署配置现算，不落库：改配置 + 重启即生效，不需要数据修补。
    isSuperAdmin: isSuperAdminProviderId(row.github_provider_user_id, env),
    role: row.role,
    accountStatus: row.account_status,
    managementVersion: row.management_version,
    accountStatusVersion: row.account_status_version,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

function loadUserView(
  handle: SqliteDatabase,
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): AdminUserView | undefined {
  const row = handle.prepare(`${USER_VIEW_SELECT} WHERE u.id = ?`).get(userId) as UserViewRow | undefined;
  return row ? toView(row, env) : undefined;
}

/**
 * 列出全部用户（含 GitHub 账号、昵称、角色、账户状态、注册/最近登录时间）。
 * 排序与 `scripts/set-super-admin.mjs --list` 一致：管理员在前，再按注册时间。
 */
export function listUsers(db: SqliteDatabase = getDb(), env: NodeJS.ProcessEnv = process.env): AdminUserView[] {
  const rows = db
    .prepare(`${USER_VIEW_SELECT} ORDER BY (u.role = 'admin') DESC, u.created_at ASC, u.id ASC`)
    .all() as UserViewRow[];
  return rows.map((row) => toView(row, env));
}

/** 当前**可用**管理员数（`role='admin' AND account_status='active'`）——守卫与界面提示共用。 */
export function countActiveAdmins(db: SqliteDatabase = getDb()): number {
  return (
    db
      .prepare(`SELECT count(*) AS c FROM users WHERE role = 'admin' AND account_status = 'active'`)
      .get() as { c: number }
  ).c;
}

// ---------------------------------------------------------------- 内部工具

function requireRequestKey(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw err.input('缺少请求标识，无法安全重放该操作。', [
      { path: 'request_key', message: '必填且不能为纯空白。' },
    ]);
  }
  return raw;
}

function requireTargetUserId(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw err.input('缺少目标用户。', [{ path: 'target_user_id', message: '必填。' }]);
  }
  return raw;
}

function requireVersion(raw: unknown, path: string, label: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw err.input(`缺少预期${label}。`, [{ path, message: '必须是非负整数。' }]);
  }
  return raw;
}

/**
 * 策略性拒绝（不是权限不足，也不是版本冲突）：用 `forbidden` + `context.guard`
 * 让调用方能靠稳定标记区分"被守卫拦住"，而不必去匹配中文提示。
 */
function guardRefusal(
  message: string,
  guard: string,
  extra?: Record<string, string | number | boolean | null>,
): DomainError {
  return new DomainError({
    code: ErrorCodes.FORBIDDEN,
    message,
    context: { guard, ...(extra ?? {}) },
  });
}

/** actor 必须在任管理员：服务层自查，不依赖路由层（自我提权连服务层都进不去）。 */
function assertActorIsActiveAdmin(handle: SqliteDatabase, actorUserId: string): void {
  const actor = handle
    .prepare('SELECT id, role, account_status FROM users WHERE id = ?')
    .get(actorUserId) as { id: string; role: UserRole; account_status: AccountStatus } | undefined;
  if (!actor) throw err.forbidden('该操作需要管理员权限。');
  if (actor.role !== 'admin' || actor.account_status !== 'active') {
    throw err.forbidden('该操作需要管理员权限（账户须为正常状态的管理员）。');
  }
}

/** 目标用户绑定的 GitHub 稳定 ID（未绑定为 null）。 */
function githubProviderUserId(handle: SqliteDatabase, userId: string): string | null {
  const row = handle
    .prepare("SELECT provider_user_id FROM external_identities WHERE user_id = ? AND provider = 'github'")
    .get(userId) as { provider_user_id: string } | undefined;
  return row?.provider_user_id ?? null;
}

/** 该用户是否就是部署绑定的超级管理员。 */
export function isDeploymentSuperAdmin(
  handle: SqliteDatabase,
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isSuperAdminProviderId(githubProviderUserId(handle, userId), env);
}

/** 授予/撤销管理员是**超管专属**：普通管理员连服务层都进不去。 */
function assertActorIsSuperAdmin(handle: SqliteDatabase, actorUserId: string, env: NodeJS.ProcessEnv): void {
  if (!isDeploymentSuperAdmin(handle, actorUserId, env)) {
    throw guardRefusal('该操作需要超级管理员权限：只有部署绑定的超级管理员能授予或撤销管理员。', 'super_admin_required', {
      super_admin_configured: configuredSuperAdminId(env) !== null,
    });
  }
}

/**
 * 授予/撤销管理员必须**显式确认**：请求体里原样重复目标用户昵称。
 * 为什么放服务端：界面上"手打昵称"只是防误点，直接打 API 的人不该绕过这道闸。
 */
function requireTargetNicknameConfirmation(raw: unknown, nickname: string): void {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw err.input('授予或撤销管理员必须显式确认：请原样填写目标用户的昵称。', [
      { path: 'confirm_target_nickname', message: '必填且不能为纯空白。' },
    ]);
  }
  if (raw.trim() !== nickname) {
    throw err.input('确认昵称与目标用户不一致，操作已拒绝。', [
      { path: 'confirm_target_nickname', message: `必须与目标用户昵称完全一致（${nickname}）。` },
    ]);
  }
}

interface ReceiptRow {
  targetId: string;
  requestDigest: string | null;
  changes: Record<string, unknown>;
}

/** 读幂等回执（= 审计行）。同键不同摘要由调用方判 `request_key_reused`。 */
function readReceipt(handle: SqliteDatabase, actionType: string, operationKey: string): ReceiptRow | null {
  const row = handle
    .prepare('SELECT target_id, changes FROM operation_records WHERE action_type = ? AND operation_key = ?')
    .get(actionType, operationKey) as { target_id: string; changes: string } | undefined;
  if (!row) return null;

  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(row.changes) as unknown;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    // changes 有 json_valid CHECK，进不来；真进来了也只是"摘要缺失"，会在上面被判为不同摘要。
  }
  return {
    targetId: row.target_id,
    requestDigest: typeof parsed.request_digest === 'string' ? parsed.request_digest : null,
    changes: parsed,
  };
}

/** 审计行内联写入（与业务变更同事务）。`actor_kind='admin'` 已由 `assertActorIsActiveAdmin` 保证。 */
function insertAudit(
  handle: SqliteDatabase,
  input: {
    actionType: string;
    operationKey: string;
    actorUserId: string;
    targetUserId: string;
    targetSnapshot: unknown;
    changes: unknown;
    reason: string;
    now: number;
  },
): void {
  handle
    .prepare(
      `INSERT INTO operation_records
         (id, action_type, operation_key, actor_kind, actor_user_id, target_type, target_id,
          target_snapshot, changes, reason, task_id, created_at)
       VALUES (?, ?, ?, 'admin', ?, 'user', ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      newId(input.now),
      input.actionType,
      input.operationKey,
      input.actorUserId,
      input.targetUserId,
      JSON.stringify(input.targetSnapshot ?? null),
      JSON.stringify(input.changes ?? null),
      input.reason,
      input.now,
    );
}

/** 把当前视图重新读出来（变更后返回给调用方，附带最新版本号）。 */
function reread(handle: SqliteDatabase, userId: string, env: NodeJS.ProcessEnv = process.env): AdminUserView {
  const view = loadUserView(handle, userId, env);
  if (!view) throw err.internal('用户视图读取失败：目标用户在事务内消失。');
  return view;
}

// ---------------------------------------------------------------- 角色变更

/**
 * 授予 / 撤销管理员。
 *
 * 顺序（每一步都对应一个必须变红的用例分支）：
 *  1. 入参校验 → `input_invalid`；
 *  2. actor 仍在任管理员 → `forbidden`；
 *  3. 幂等回执：同键同摘要 → 原结果（`replayed=true`）；同键不同摘要 → `request_key_reused`；
 *  4. 目标存在 → `target_unavailable`；
 *  5. CAS：`management_version` 不符 → `version_conflict`；
 *  6. 目标"本来就是这个角色" → 无变更（不递增版本、不写审计）；
 *  7. 守卫：不给已禁用账户授予；撤销后至少要留下一名可用管理员；
 *  8. 写库 + 审计（同一事务）。
 */
export function setUserRole(
  db: SqliteDatabase = getDb(),
  input: SetUserRoleInput,
  /** 部署配置视图（默认 process.env）。测试注入，避免改进程环境。 */
  env: NodeJS.ProcessEnv = process.env,
): UserAdminChangeResult {
  const requestKey = requireRequestKey(input.requestKey);
  const targetUserId = requireTargetUserId(input.targetUserId);
  if (input.role !== 'admin' && input.role !== 'user') {
    throw err.input('角色只能是 admin 或 user。', [{ path: 'role', message: '取值不合法。' }]);
  }
  const expectedVersion = requireVersion(input.expectedManagementVersion, 'expected_management_version', '管理版本');
  if (typeof input.actorUserId !== 'string' || input.actorUserId.trim() === '') {
    throw err.unauthenticated('该操作需要管理员权限，请先登录。');
  }

  const grant = input.role === 'admin';
  const reason = (typeof input.reason === 'string' ? input.reason.trim() : '') || (grant ? '授予管理员权限。' : '撤销管理员权限。');
  const requestDigest = digest({
    action_type: SET_USER_ROLE_ACTION,
    actor_user_id: input.actorUserId,
    target_user_id: targetUserId,
    role: input.role,
    reason,
  });

  return withTransaction(
    (tx) => {
      const handle = tx.db;
      assertActorIsActiveAdmin(handle, input.actorUserId);

      const receipt = readReceipt(handle, SET_USER_ROLE_ACTION, requestKey);
      if (receipt) {
        if (receipt.requestDigest !== requestDigest) {
          throw err.keyReused('同一请求标识已用于另一次角色变更。');
        }
        // 重放：不重复执行、不写第二条审计。返回**当前**视图（不做历史快照还原 ——
        // 那会把已被后续操作改过的现状伪装成原样）。
        return {
          user: reread(handle, receipt.targetId, env),
          changed: true,
          replayed: true,
          revokedSessionCount: 0,
        };
      }

      const target = loadUserView(handle, targetUserId, env);
      if (!target) throw err.unavailable('目标用户不存在。');

      // 权限矩阵：**只有超级管理员**能授予或撤销管理员。
      // 放在 CAS 之前 —— 没资格的人不该靠错误码差异反推出目标用户的版本号。
      if (grant || target.role === 'admin') {
        assertActorIsSuperAdmin(handle, input.actorUserId, env);
        requireTargetNicknameConfirmation(input.confirmTargetNickname, target.nickname);
      }

      // CAS 在"无变更"判定之前：版本不符一律冲突，绝不静默放过。
      if (target.managementVersion !== expectedVersion) {
        throw err.conflict('用户角色已被其他操作改变，请刷新后重试。', {
          user_id: target.userId,
          current_management_version: target.managementVersion,
          expected_management_version: expectedVersion,
        });
      }

      if (target.role === input.role) {
        return { user: target, changed: false, replayed: false, revokedSessionCount: 0 };
      }

      // 部署绑定的超级管理员**不可被剥夺**：他本身就是管理员，所以任何"降到 user"的
      // 变更都在这里被拒。要换人只能改部署配置（SUPER_ADMIN_GITHUB_ID）并重启。
      if (target.isSuperAdmin) {
        throw guardRefusal(
          `拒绝执行：${target.nickname} 是部署绑定的超级管理员，站内不能撤销。要换人请修改 ${SUPER_ADMIN_ENV} 并重启服务。`,
          'super_admin_immutable',
          { target_user_id: target.userId },
        );
      }

      if (grant && target.accountStatus !== 'active') {
        // 与 CLI 同口径：否则会造出一个"是管理员但登不进来"的空位。
        throw guardRefusal(
          `拒绝执行：${target.nickname} 的账户状态是「已禁用」，不能授予管理员。请先恢复该账户。`,
          'disabled_account',
          { target_user_id: target.userId },
        );
      }

      if (!grant) {
        const remaining = (
          handle
            .prepare(
              `SELECT count(*) AS c FROM users
                WHERE role = 'admin' AND account_status = 'active' AND id <> ?`,
            )
            .get(target.userId) as { c: number }
        ).c;
        if (remaining === 0) {
          throw guardRefusal(
            `拒绝执行：${target.nickname} 是最后一个可用管理员，撤销后没人能审核内容。请先指定另一名管理员。`,
            'last_active_admin',
            { remaining_active_admins: 0 },
          );
        }
      }

      const nextVersion = target.managementVersion + 1;
      const now = nowMs();
      const info = handle
        .prepare(
          `UPDATE users SET role = ?, management_version = ?, updated_at = ?
            WHERE id = ? AND management_version = ?`,
        )
        .run(input.role, nextVersion, now, target.userId, expectedVersion);
      if (info.changes !== 1) {
        throw err.conflict('用户角色并发更新冲突，请刷新后重试。', {
          user_id: target.userId,
          expected_management_version: expectedVersion,
        });
      }

      insertAudit(handle, {
        actionType: SET_USER_ROLE_ACTION,
        operationKey: requestKey,
        actorUserId: input.actorUserId,
        targetUserId: target.userId,
        targetSnapshot: target,
        changes: {
          request_digest: requestDigest,
          target_is_super_admin: target.isSuperAdmin,
          from_role: target.role,
          to_role: input.role,
          management_version_before: target.managementVersion,
          management_version_after: nextVersion,
        },
        reason,
        now,
      });

      return { user: reread(handle, target.userId, env), changed: true, replayed: false, revokedSessionCount: 0 };
    },
    db,
  );
}

// ---------------------------------------------------------------- 状态变更

/**
 * 禁用 / 恢复账户。
 *
 * 与角色变更同构，差别在三处：
 *  - 原因**必填**（空或纯空白 → `input_invalid`）；
 *  - CAS 用 `account_status_version`；
 *  - 禁用时在同一事务里**撤销该用户所有仍然有效的会话**（只写 `revoked_at IS NULL` 的行，
 *    不覆盖已有的撤销时间）；被禁用账户的登录/建会话早在 identity 服务里就被拒（那条口径不动）。
 */
export function setUserStatus(
  db: SqliteDatabase = getDb(),
  input: SetUserStatusInput,
  env: NodeJS.ProcessEnv = process.env,
): UserAdminChangeResult {
  const requestKey = requireRequestKey(input.requestKey);
  const targetUserId = requireTargetUserId(input.targetUserId);
  if (input.status !== 'disabled' && input.status !== 'active') {
    throw err.input('账户状态只能是 active 或 disabled。', [{ path: 'account_status', message: '取值不合法。' }]);
  }
  if (typeof input.reason !== 'string' || input.reason.trim() === '') {
    throw err.input('必须填写变更原因（禁用还是恢复、为什么）。', [{ path: 'reason', message: '必填且不能为纯空白。' }]);
  }
  const expectedVersion = requireVersion(
    input.expectedAccountStatusVersion,
    'expected_account_status_version',
    '账户状态版本',
  );
  if (typeof input.actorUserId !== 'string' || input.actorUserId.trim() === '') {
    throw err.unauthenticated('该操作需要管理员权限，请先登录。');
  }

  const reason = input.reason.trim();
  const requestDigest = digest({
    action_type: SET_USER_STATUS_ACTION,
    actor_user_id: input.actorUserId,
    target_user_id: targetUserId,
    status: input.status,
    reason,
  });

  return withTransaction(
    (tx) => {
      const handle = tx.db;
      assertActorIsActiveAdmin(handle, input.actorUserId);

      const receipt = readReceipt(handle, SET_USER_STATUS_ACTION, requestKey);
      if (receipt) {
        if (receipt.requestDigest !== requestDigest) {
          throw err.keyReused('同一请求标识已用于另一次账户状态变更。');
        }
        const revoked = receipt.changes['revoked_sessions'];
        return {
          user: reread(handle, receipt.targetId, env),
          changed: true,
          replayed: true,
          revokedSessionCount: typeof revoked === 'number' && Number.isInteger(revoked) ? revoked : 0,
        };
      }

      const target = loadUserView(handle, targetUserId, env);
      if (!target) throw err.unavailable('目标用户不存在。');

      if (target.accountStatusVersion !== expectedVersion) {
        throw err.conflict('账户状态已被其他操作改变，请刷新后重试。', {
          user_id: target.userId,
          current_account_status_version: target.accountStatusVersion,
          expected_account_status_version: expectedVersion,
        });
      }

      if (target.accountStatus === input.status) {
        return { user: target, changed: false, replayed: false, revokedSessionCount: 0 };
      }

      // 超级管理员**不可被禁用**：禁掉他等于让整个站点失去唯一能授权的人。
      if (input.status === 'disabled' && target.isSuperAdmin) {
        throw guardRefusal(
          `拒绝执行：${target.nickname} 是部署绑定的超级管理员，站内不能禁用。要换人请修改 ${SUPER_ADMIN_ENV} 并重启服务。`,
          'super_admin_immutable',
          { target_user_id: target.userId },
        );
      }

      if (input.status === 'disabled' && target.role === 'admin') {
        const remaining = (
          handle
            .prepare(
              `SELECT count(*) AS c FROM users
                WHERE role = 'admin' AND account_status = 'active' AND id <> ?`,
            )
            .get(target.userId) as { c: number }
        ).c;
        if (remaining === 0) {
          throw guardRefusal(
            `拒绝执行：${target.nickname} 是最后一个可用管理员，禁用后没人能审核内容。请先指定或恢复另一名管理员。`,
            'last_active_admin',
            { remaining_active_admins: 0 },
          );
        }
      }

      const now = nowMs();
      const nextVersion = target.accountStatusVersion + 1;
      const info = handle
        .prepare(
          `UPDATE users SET account_status = ?, account_status_version = ?, updated_at = ?
            WHERE id = ? AND account_status_version = ?`,
        )
        .run(input.status, nextVersion, now, target.userId, expectedVersion);
      if (info.changes !== 1) {
        throw err.conflict('账户状态并发更新冲突，请刷新后重试。', {
          user_id: target.userId,
          expected_account_status_version: expectedVersion,
        });
      }

      // 禁用 = 立刻踢下线：撤销该用户所有**仍然有效**的会话（重复撤销是幂等的，不覆盖原始时间）。
      let revokedSessionCount = 0;
      if (input.status === 'disabled') {
        const revoked = handle
          .prepare('UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
          .run(now, target.userId);
        revokedSessionCount = revoked.changes;
      }

      insertAudit(handle, {
        actionType: SET_USER_STATUS_ACTION,
        operationKey: requestKey,
        actorUserId: input.actorUserId,
        targetUserId: target.userId,
        targetSnapshot: target,
        changes: {
          request_digest: requestDigest,
          from_status: target.accountStatus,
          to_status: input.status,
          reason,
          account_status_version_before: target.accountStatusVersion,
          account_status_version_after: nextVersion,
          revoked_sessions: revokedSessionCount,
        },
        reason,
        now,
      });

      return {
        user: reread(handle, target.userId, env),
        changed: true,
        replayed: false,
        revokedSessionCount,
      };
    },
    db,
  );
}