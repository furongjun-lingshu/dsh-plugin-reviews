/**
 * identity 服务（工作包 GI，契约 已删除的设计稿《模块签名契约》 第 1 节）。
 *
 * 关键不变量（这些是测试必须能证明的，不是注释装饰）：
 *  1. **一个 GitHub 稳定 ID 只对应一个站内用户**：重复回调复用既有用户，
 *     `created=false`，不新建 users 行，也不新建第二条 external_identities。
 *  2. **明文凭证不入库**：库里只有 `digestText(token)`（64 位十六进制）。
 *  3. **角色与账户状态每次从库里读**，不缓存在会话里 —— 撤销管理员后，
 *     其旧会话立刻失去管理权限；账户被禁用后旧会话立刻失效。
 *  4. **续期受 24 小时间隔与 absolute 上限双重约束**：间隔未到不动 expires_at；
 *     续期结果不得超过 absolute_expires_at。
 *  5. 撤销是单向的：撤销后的会话不能再被续期"复活"。
 *
 * 连接获取：优先使用注入的 db（测试传真实临时库），否则回退平台单例。
 * 本模块不 new Database，不建表，不读 Cookie。
 */

import type { SqliteDatabase } from '@/server/platform/db';
import { getDb } from '@/server/platform/db';
import { withRead, withTransaction } from '@/server/platform/tx';
import { digestText } from '@/server/platform/digest';
import { newId, newOpaqueToken } from '@/server/platform/id';
import { DAY, HOUR } from '@/server/platform/time';
import { isSuperAdminProviderId } from './super-admin';
import { err } from '@/packages/common/errors';
import type { CallerContext } from '@/server/platform/context';
import {
  DEFAULT_SESSION_POLICY,
  type CreatedSession,
  type IdentifiedGithubUser,
  type IdentityService,
  type ResolvedSession,
  type SessionPolicy,
  type SignInResult,
} from './types';

export interface IdentityServiceDeps {
  /** 显式连接（测试用真实临时库）。省略时回退平台单例。 */
  db?: SqliteDatabase;
  /** 时限参数覆盖（默认取架构第 105 节初始值）。 */
  policy?: Partial<SessionPolicy>;
  /** 部署配置视图（默认 process.env）。首个管理员的引导开关从这里读。 */
  env?: NodeJS.ProcessEnv;
}

interface UserRow {
  id: string;
  nickname: string;
  avatar_url: string | null;
  role: 'user' | 'admin';
  account_status: 'active' | 'disabled';
}

interface IdentityRow {
  id: string;
  user_id: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  expires_at: number;
  absolute_expires_at: number;
  last_seen_at: number;
  last_renewed_at: number;
  revoked_at: number | null;
}

/**
 * 昵称生成：GitHub displayName → providerUsername → 兜底。
 * users.nickname 有 `trim(nickname) <> ''` 约束，因此这里必须给出**非空白**结果，
 * 不能把空串或纯空白交给数据库去撞约束。
 */
function deriveNickname(input: IdentifiedGithubUser): string {
  const candidates = [input.displayName, input.providerUsername];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
  }
  return `github-${input.providerUserId}`;
}

/**
 * 部署时指定的**首个管理员**（`.env.example` 的 `BOOTSTRAP_ADMIN_GITHUB_ID`）。
 *
 * 语义刻意收紧成"引导"而不是"永久提权"：
 *  1. 只有 `provider_user_id`（GitHub 稳定数字 ID）与该变量**完全相同**的账号才可能被提升
 *     —— 用户名可以改，不能当身份；
 *  2. 且**当前一个可用管理员都没有**时才生效。否则被别的管理员降过权的账号，
 *     下次登录会自动变回管理员，"撤销"就永远无效了（idea.md：撤销权限要真的生效）；
 *  3. 已禁用（disabled）的账户不提升。
 *
 * 返回是否真的提升了（仅供测试与日志；登录流程不因它失败 —— 引导不该挡住正常登录）。
 */
export function bootstrapAdminWithin(
  db: SqliteDatabase,
  input: { userId: string; providerUserId: string; now: number; env: NodeJS.ProcessEnv },
): boolean {
  const wanted = input.env.BOOTSTRAP_ADMIN_GITHUB_ID?.trim();
  if (!wanted || wanted !== input.providerUserId) return false;

  const admins = (
    db.prepare(`SELECT count(*) AS c FROM users WHERE role = 'admin' AND account_status = 'active'`).get() as {
      c: number;
    }
  ).c;
  if (admins > 0) return false;

  const result = db
    .prepare(
      `UPDATE users SET role = 'admin', management_version = management_version + 1, updated_at = ?
        WHERE id = ? AND role = 'user' AND account_status = 'active'`,
    )
    .run(input.now, input.userId);
  return result.changes === 1;
}

/**
 * **部署绑定的超级管理员**：登录即（幂等地）提升为管理员。
 *
 * 为什么在登录时做：这样"部署时决定谁当超管"不需要任何人工上机跑脚本 ——
 * 配好 `SUPER_ADMIN_GITHUB_ID`、该账号登录一次，绑定就生效了。
 * 与 `bootstrapAdminWithin` 的区别：引导只在"一个管理员都没有"时生效；
 * 超管绑定是**恒定**的（被别的管理员降过权，下次登录仍会恢复），
 * 因为它的语义是"这个身份由部署决定"，不是"一次性引导"。
 */
export function bindSuperAdminWithin(
  db: SqliteDatabase,
  input: { userId: string; providerUserId: string; now: number; env: NodeJS.ProcessEnv },
): boolean {
  if (!isSuperAdminProviderId(input.providerUserId, input.env)) return false;
  const result = db
    .prepare(
      `UPDATE users SET role = 'admin', management_version = management_version + 1, updated_at = ?
        WHERE id = ? AND role = 'user' AND account_status = 'active'`,
    )
    .run(input.now, input.userId);
  return result.changes === 1;
}

export function createIdentityService(deps: IdentityServiceDeps = {}): IdentityService {
  // 惰性解析：省略 deps.db 时才回退单例；显式传连接（测试）绝不触碰单例与 DSH_REVIEW_DB_PATH。
  const db: SqliteDatabase = deps.db ?? getDb();
  const env: NodeJS.ProcessEnv = deps.env ?? process.env;
  const policy: SessionPolicy = { ...DEFAULT_SESSION_POLICY, ...(deps.policy ?? {}) };

  const validityMs = policy.validityDays * DAY;
  const absoluteLifetimeMs = policy.absoluteLifetimeDays * DAY;
  const renewIntervalMs = policy.renewIntervalHours * HOUR;

  function findUser(userId: string): UserRow | undefined {
    return db
      .prepare('SELECT id, nickname, avatar_url, role, account_status FROM users WHERE id = ?')
      .get(userId) as UserRow | undefined;
  }

  return {
    async signInWithGithub(input: IdentifiedGithubUser, now: number): Promise<SignInResult> {
      // 输入前置校验：GitHub 稳定 ID 是身份唯一性的根，缺它就没有幂等可言。
      if (typeof input.providerUserId !== 'string' || input.providerUserId.trim().length === 0) {
        throw err.input('缺少 GitHub 稳定 ID，无法完成登录。', [
          { path: 'provider_user_id', message: '必填且不能为纯空白。' },
        ]);
      }
      if (typeof input.providerUsername !== 'string' || input.providerUsername.trim().length === 0) {
        throw err.input('缺少 GitHub 用户名，无法完成登录。', [
          { path: 'provider_username', message: '必填且不能为纯空白。' },
        ]);
      }

      // 身份查询与建档必须在**同一事务**内完成：
      // 先查后插若分处两个事务，并发回调会各查到"不存在"并各建一个用户。
      return withTransaction(
        (tx) => {
          const existing = tx.db
            .prepare(
              `SELECT id, user_id FROM external_identities
               WHERE provider = 'github' AND provider_user_id = ?`,
            )
            .get(input.providerUserId) as IdentityRow | undefined;

          if (existing) {
            const user = tx.db
              .prepare('SELECT id, role, account_status FROM users WHERE id = ?')
              .get(existing.user_id) as Pick<UserRow, 'id' | 'role' | 'account_status'> | undefined;
            if (!user) {
              // 外键 ON DELETE RESTRICT 下不该出现；出现即为数据损坏，明确失败而不是悄悄新建用户。
              throw err.internal('身份记录指向的站内用户不存在。');
            }
            if (user.account_status === 'disabled') {
              // 已禁用账户不得通过重新登录"绕过"禁用。
              throw err.disabled();
            }
            // 复用既有用户：只同步资料，不建 users 行、不建身份行。
            tx.db
              .prepare(
                `UPDATE external_identities
                   SET provider_username = ?, profile_url = ?, avatar_url = ?, synced_at = ?
                 WHERE id = ?`,
              )
              .run(input.providerUsername, input.profileUrl, input.avatarUrl, now, existing.id);
            tx.db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(now, now, user.id);
            // 部署时指定的首个管理员（只在"一个可用管理员都没有"时生效）。
            bootstrapAdminWithin(tx.db, { userId: user.id, providerUserId: input.providerUserId, now, env });
            // 部署绑定的超级管理员：恒定、幂等。
            bindSuperAdminWithin(tx.db, { userId: user.id, providerUserId: input.providerUserId, now, env });
            return { userId: user.id, created: false };
          }

          const userId = newId(now);
          tx.db
            .prepare(
              `INSERT INTO users (id, nickname, avatar_url, role, account_status, created_at, updated_at, last_login_at)
               VALUES (?, ?, ?, 'user', 'active', ?, ?, ?)`,
            )
            .run(userId, deriveNickname(input), input.avatarUrl, now, now, now);

          tx.db
            .prepare(
              `INSERT INTO external_identities
                 (id, user_id, provider, provider_user_id, provider_username, profile_url, avatar_url, created_at, synced_at)
               VALUES (?, ?, 'github', ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              newId(now),
              userId,
              input.providerUserId,
              input.providerUsername,
              input.profileUrl,
              input.avatarUrl,
              now,
              now,
            );

          // 首次登录就可能在同一个事务里被提升为首个管理员 / 绑定为超级管理员。
          bootstrapAdminWithin(tx.db, { userId, providerUserId: input.providerUserId, now, env });
          bindSuperAdminWithin(tx.db, { userId, providerUserId: input.providerUserId, now, env });

          return { userId, created: true };
        },
        db,
      );
    },

    async createSession(userId: string, now: number): Promise<CreatedSession> {
      const user = findUser(userId);
      if (!user) throw err.unavailable('用户不存在，无法建立会话。');
      if (user.account_status === 'disabled') throw err.disabled();

      // 明文只存在于这个局部变量与返回值里；落库的是摘要。
      const token = newOpaqueToken();
      const tokenDigest = digestText(token);
      const sessionId = newId(now);
      const expiresAt = now + validityMs;
      const absoluteExpiresAt = now + absoluteLifetimeMs;

      withTransaction(
        (tx) => {
          tx.db
            .prepare(
              `INSERT INTO user_sessions
                 (id, user_id, token_digest, created_at, expires_at, absolute_expires_at, last_seen_at, last_renewed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(sessionId, userId, tokenDigest, now, expiresAt, absoluteExpiresAt, now, now);
        },
        db,
      );

      return { sessionId, token, expiresAt, absoluteExpiresAt };
    },

    async resolveSession(token: string, now: number): Promise<ResolvedSession | null> {
      if (typeof token !== 'string' || token.length === 0) return null;

      return withRead((conn) => {
        const session = conn
          .prepare(
            `SELECT id, user_id, expires_at, absolute_expires_at, last_seen_at, last_renewed_at, revoked_at
               FROM user_sessions WHERE token_digest = ?`,
          )
          .get(digestText(token)) as SessionRow | undefined;

        // 逐条显式判断，不用一个 || 串起来：每一条都对应一个必须变红的用例分支。
        if (!session) return null;
        if (session.revoked_at !== null) return null;
        if (session.expires_at <= now) return null;
        if (session.absolute_expires_at <= now) return null;

        // 角色与账户状态**每次从库里读**，不缓存在会话行里。
        const user = conn
          .prepare('SELECT id, role, account_status FROM users WHERE id = ?')
          .get(session.user_id) as Pick<UserRow, 'id' | 'role' | 'account_status'> | undefined;
        if (!user) return null;
        if (user.account_status !== 'active') return null;

        // 超级管理员身份**每次请求**从部署配置现算（不落库、不缓存）：
        // 改了 SUPER_ADMIN_GITHUB_ID 并重启，绑定立刻跟着变，不需要迁移或数据修补。
        const identity = conn
          .prepare("SELECT provider_user_id FROM external_identities WHERE user_id = ? AND provider = 'github'")
          .get(session.user_id) as { provider_user_id: string } | undefined;

        return {
          userId: user.id,
          role: user.role,
          accountStatus: user.account_status,
          isSuperAdmin: isSuperAdminProviderId(identity?.provider_user_id ?? null, env),
          sessionId: session.id,
        };
      }, db);
    },

    async touchSession(sessionId: string, now: number): Promise<void> {
      withTransaction(
        (tx) => {
          const session = tx.db
            .prepare(
              `SELECT id, user_id, expires_at, absolute_expires_at, last_seen_at, last_renewed_at, revoked_at
                 FROM user_sessions WHERE id = ?`,
            )
            .get(sessionId) as SessionRow | undefined;
          if (!session) return;
          // 已撤销 / 已过期 / 已过绝对上限：一律不续期。
          // 与退出并发时不能把已撤销会话重新延长为可用（架构第 53 节）。
          if (session.revoked_at !== null) return;
          if (session.expires_at <= now) return;
          if (session.absolute_expires_at <= now) return;

          const lastRenewedAt = session.last_renewed_at;
          const sinceRenew = now - lastRenewedAt;

          if (sinceRenew < renewIntervalMs) {
            // 距上次续期不足 24 小时：expires_at 与 last_renewed_at 都不动。
            // last_seen_at 按 activity_write_interval_seconds 控制写入频率，避免每请求一次写。
            if (now - session.last_seen_at >= policy.activityWriteIntervalSeconds * 1000) {
              tx.db.prepare('UPDATE user_sessions SET last_seen_at = ? WHERE id = ?').run(now, sessionId);
            }
            return;
          }

          // 续期：expires_at = 访问时间 + 7 天，但不得超过 absolute_expires_at。
          const renewed = Math.min(now + validityMs, session.absolute_expires_at);
          tx.db
            .prepare('UPDATE user_sessions SET expires_at = ?, last_renewed_at = ?, last_seen_at = ? WHERE id = ?')
            .run(renewed, now, now, sessionId);
        },
        db,
      );
    },

    async revokeSession(sessionId: string, now: number): Promise<void> {
      withTransaction(
        (tx) => {
          // 只撤销仍然有效的会话；重复调用是幂等的，不覆盖原始撤销时间。
          tx.db
            .prepare('UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
            .run(now, sessionId);
        },
        db,
      );
    },

    async updateProfile(ctx: CallerContext, input: { nickname?: string; avatarUrl?: string | null }): Promise<void> {
      if (ctx.userId === null) throw err.unauthenticated();
      if (ctx.accountStatus !== 'active') throw err.disabled();

      const sets: string[] = [];
      const params: unknown[] = [];

      if (input.nickname !== undefined) {
        if (typeof input.nickname !== 'string' || input.nickname.trim().length === 0) {
          throw err.input('昵称不能为空或纯空白。', [{ path: 'nickname', message: '必填且不能为纯空白。' }]);
        }
        sets.push('nickname = ?');
        params.push(input.nickname.trim());
      }
      if (input.avatarUrl !== undefined) {
        sets.push('avatar_url = ?');
        params.push(input.avatarUrl);
      }
      if (sets.length === 0) {
        throw err.input('没有需要保存的资料变更。');
      }

      const now = Date.now();
      withTransaction(
        (tx) => {
          // 条件里再带上 account_status：避免校验与写入之间账户被禁用。
          const info = tx.db
            .prepare(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND account_status = 'active'`)
            .run(...params, now, ctx.userId);
          if (info.changes === 0) throw err.disabled();
        },
        db,
      );
    },
  };
}
