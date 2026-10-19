'use client';

/**
 * 导航栏登录态（任务 7 第 1 项）+ 参照站页头结构：
 * 左侧品牌，中部药丸分段导航（当前所在栏目高亮），右侧通知与账户。
 *
 * 状态**全部来自 `GET /api/session`**，不靠假设、也不靠本地猜测：
 *   - `authenticated` 决定显示"登录"还是"账户"；
 *   - `githubLoginConfigured` 为 false 时，GitHub 按钮**明说未配置**并禁用，
 *     不让用户点进一个 503 HTML 页面才算发现；
 *   - `testLoginEnabled` 为 true 时才出现测试登录入口（开发用，生产恒为 false）。
 *
 * 登录成功后不整页跳转刷新之外的额外状态同步：直接重取会话，
 * 避免"界面说登录了、服务端其实没会话"这种假状态。
 *
 * 视觉全部走 globals.css；这里不出现硬编码颜色。
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, ErrorNotice, apiFetch } from './api-client';
import { AccountMenu } from './account-menu';
import { SignInMenu } from './sign-in-menu';
import { SiteDrawer } from './site-drawer';

interface SessionData {
  authenticated: boolean;
  userId?: string;
  /** 展示昵称（`/api/session` 现在会回它）；缺省时退回显示 userId。 */
  nickname?: string | null;
  role?: 'user' | 'admin' | null;
  accountStatus?: 'active' | 'disabled' | null;
  githubLoginConfigured: boolean;
  testLoginEnabled: boolean;
}

export function SessionNav() {
  const pathname = usePathname();
  const [session, setSession] = useState<SessionData | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  /** 未读通知数（`idea.md §11`：顶部未读数）。未登录/取失败时保持 null = 不显示角标。 */
  const [unread, setUnread] = useState<number | null>(null);

  const loadSession = useCallback(async () => {
    try {
      const data = await apiFetch<SessionData>('/api/session', { cache: 'no-store' });
      setSession(data);
      setError(null);
      if (!data.authenticated) {
        setUnread(null);
        return;
      }
      // 未读数失败不影响登录态展示（角标是锦上添花，不是鉴权信息）。
      try {
        const inbox = await apiFetch<{ unreadCount: number }>('/api/me/notifications?limit=1', { cache: 'no-store' });
        setUnread(inbox.unreadCount);
      } catch {
        setUnread(null);
      }
    } catch (e) {
      setError(e as ApiError);
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  /**
   * 测试登录：只在服务端开关打开时可用（生产恒为 false）。
   *
   * `asAdmin` 走另一个**固定测试身份** `local-admin`。注意管理员**不能**靠登录产生：
   * 站内没有任何自提权入口（这是刻意的），所以这个身份需要运维先用
   * `node scripts/grant-admin.mjs --github-login local-admin` 授予一次管理员。
   * 没授予时它就是一个普通用户 —— 界面如实反映，不做隐式提权。
   */
  const signInForTest = async (asAdmin = false) => {
    setBusy(true);
    try {
      await apiFetch('/api/testing/session', {
        method: 'POST',
        json: asAdmin
          ? { providerUserId: 'local-admin', providerUsername: 'local-admin', displayName: '本地管理员' }
          : { providerUserId: 'local-dev-user', providerUsername: 'local-dev' },
      });
      await loadSession();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await apiFetch('/api/session', { method: 'DELETE' });
      await loadSession();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const inPlugins = pathname === '/plugins' || pathname.startsWith('/plugins/');
  const inReviews = pathname === '/reviews' || pathname.startsWith('/reviews/');

  return (
    <div>
      <nav className="header-inner" aria-label="全站导航">
        <Link href="/" className="brand">
          DSH Plugin Review
        </Link>

        <div className="main-nav">
          <Link href="/plugins" className={inPlugins ? 'active' : ''} aria-current={inPlugins ? 'page' : undefined}>
            插件
          </Link>
          <Link href="/reviews" className={inReviews ? 'active' : ''} aria-current={inReviews ? 'page' : undefined}>
            评测
          </Link>
        </div>

        <div className="account">
          {session === null ? (
            <span className="muted">正在读取登录状态…</span>
          ) : session.authenticated ? (
            /* 页头不再放通知铃铛（主人指定删掉）：未读改为在账户下拉的「通知」行右侧显示红点，
               少一个常驻图标，未读提示跟着"去哪看通知"的动作走。 */
            <AccountMenu
              name={session.nickname ?? session.userId ?? '账户'}
              subtitle={
                /* 只留角色；"会话进行中"这类过程性描述按主人要求去掉，禁用状态仍然如实说明 */
                session.accountStatus === 'disabled'
                  ? `${session.role === 'admin' ? '管理员' : '普通用户'} · 账户已禁用`
                  : session.role === 'admin'
                    ? '管理员'
                    : '普通用户'
              }
              initial={(session.nickname ?? session.userId ?? '?').slice(0, 1).toUpperCase()}
              title={`账户 ${session.userId}`}
              unread={unread}
              busy={busy}
              onSignOut={() => void signOut()}
            />
          ) : (
            /* 未登录：收成一个 filled「登录」按钮 + M3 菜单（真实登录在前，测试通道标"（开发）"）
               —— 这是**桌面**形态；手机上由下面的侧边抽屉承担（CSS 切换显示）。 */
            <SignInMenu
              githubConfigured={session.githubLoginConfigured}
              testLoginEnabled={session.testLoginEnabled}
              busy={busy}
              onTestLogin={() => void signInForTest()}
              onTestAdminLogin={() => void signInForTest(true)}
            />
          )}
          {/*
            手机端的入口：菜单图标 + 侧边抽屉（主人要求把账户入口换成"侧边展开的栏"）。
            桌面端这一段不显示（.drawer-trigger 在宽屏 display:none）。
          */}
          <SiteDrawer
            name={session?.nickname ?? session?.userId ?? '访客'}
            subtitle={
              session?.authenticated
                ? session.accountStatus === 'disabled'
                  ? `${session.role === 'admin' ? '管理员' : '普通用户'} · 账户已禁用`
                  : session.role === 'admin'
                    ? '管理员'
                    : '普通用户'
                : '未登录'
            }
            initial={(session?.nickname ?? session?.userId ?? '?').slice(0, 1).toUpperCase()}
            unread={unread}
            busy={busy}
            authenticated={session?.authenticated === true}
            githubConfigured={session?.githubLoginConfigured === true}
            testLoginEnabled={session?.testLoginEnabled === true}
            onSignOut={() => void signOut()}
            onTestLogin={() => void signInForTest()}
            onTestAdminLogin={() => void signInForTest(true)}
          />
        </div>
      </nav>
      {error ? (
        <div className="header-inner">
          <ErrorNotice error={error} onDismiss={() => setError(null)} />
        </div>
      ) : null}
    </div>
  );
}