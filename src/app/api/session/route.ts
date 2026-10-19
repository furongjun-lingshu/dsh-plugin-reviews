/**
 * 会话查询与退出。
 *
 * GET    /api/session   当前登录者
 * DELETE /api/session   退出登录（撤销会话并清 Cookie）
 *
 * ⚠️ 这里**没有**登录 POST。
 * 早先版本在这条路由上提供了"接受请求体身份"的测试登录通道，
 * 那等于一个任何人都能声明自己是某 GitHub 用户的旁路。
 * 现在登录只有一条真实路径：`GET /api/auth/github/start` → GitHub → 回调。
 * 测试需要建会话时，直接调用 identity 服务，不经过 HTTP 旁路。
 */

import { getDb } from '@/server/platform/db';
import { createIdentityService } from '@/server/modules/identity';
import { clearSessionCookie, readSessionToken } from '@/server/platform/session-cookie';
import { createGithubLoginAdapter } from '@/server/adapters/login';
import { currentContext, okJson, errorResponse, requestMeta } from '../_lib/context';
import { testLoginAllowed } from '@/server/platform/test-login';
import { isSuperAdmin } from '@/server/platform/context';
import { configuredSuperAdminId, describeSuperAdminConfig } from '@/server/modules/identity/super-admin';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    // 让前端知道"GitHub 登录是否已配置"，从而显示真实状态而不是点了才报错。
    const githubConfigured = createGithubLoginAdapter().isConfigured();

    // 昵称：导航栏要显示"谁登录了"。此前只回 userId，于是页头挂着一个 UUID 给人看。
    // 昵称是本站唯一的公开身份（评测/评论署名都用它），放在这里并不会多泄露什么。
    let nickname: string | null = null;
    if (ctx.userId !== null) {
      const row = getDb().prepare('SELECT nickname FROM users WHERE id = ?').get(ctx.userId) as
        | { nickname: string }
        | undefined;
      nickname = row?.nickname ?? null;
    }

    return okJson(
      {
        ...(ctx.userId === null
          ? { authenticated: false as const }
          : {
              authenticated: true as const,
              userId: ctx.userId,
              nickname,
              role: ctx.role,
              accountStatus: ctx.accountStatus,
            }),
        githubLoginConfigured: githubConfigured,
        // 诊断字段：让本地能一眼看出测试通道开关是否生效（不含任何秘密）。
        testLoginEnabled: testLoginAllowed(),
        /** 当前登录者是不是**部署绑定的超级管理员**（未登录恒 false）。 */
        isSuperAdmin: isSuperAdmin(ctx),
        /** 超级管理员是否已在部署配置里绑定；未绑定时站内没人能授予管理员。 */
        superAdminConfigured: describeSuperAdminConfig().problem === null && configuredSuperAdminId() !== null,
        /**
         * **仅开发通道打开时**下发：用哪个身份走测试登录就能成为超级管理员。
         * 生产恒为 null —— 不泄露"该盯哪个账号"，测试登录本身在生产也是关的。
         */
        testSuperAdminIdentity: testLoginAllowed() ? configuredSuperAdminId() : null,
      },
      requestId,
    );
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const token = await readSessionToken();
    if (token) {
      const identity = createIdentityService({ db: getDb() });
      const resolved = await identity.resolveSession(token, Date.now());
      if (resolved) await identity.revokeSession(resolved.sessionId, Date.now());
    }
    await clearSessionCookie();
    return okJson({ signedOut: true }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
