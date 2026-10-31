'use client';

/**
 * 手机端侧边抽屉（M3 modal navigation drawer）。
 *
 * 为什么要有它：主人要求把右上角那个账户入口（图二）换成"侧边展开的栏"，并把底部导航里的
 * 「我的」删掉 —— 于是个人中心相关入口（评测／通知／个人设置／登录／登出）统一收进这个抽屉，
 * 底部只留"去哪里找内容"的目的地。
 *
 * 分工（沿用 M3 的惯例，两种断点各用各的形态）：
 *   ≤900px：一个菜单图标 + 侧边抽屉（本组件）；
 *   >900px：右上角账户 chip + 下拉菜单（`account-menu.tsx` / `sign-in-menu.tsx`，由 CSS 隐藏/显示切换）。
 *
 * 可访问性：`aria-haspopup="dialog"` / `aria-expanded`；抽屉 `role="dialog" aria-modal="true"`；
 * Esc 关闭、点遮罩关闭、打开时焦点移到关闭键、关闭后焦点还给触发键。
 */

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ThemeMenuRow } from './theme-switch';

type GlyphName = 'review' | 'bell' | 'settings' | 'logout' | 'login' | 'menu' | 'close' | 'chevron';

function Glyph({ name }: { name: GlyphName }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.9,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (name) {
    case 'menu':
      return (
        <svg {...common} width={24} height={24}>
          <line x1="4" y1="7" x2="20" y2="7" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="17" x2="20" y2="17" />
        </svg>
      );
    case 'close':
      return (
        <svg {...common}>
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      );
    case 'review':
      return (
        <svg {...common}>
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <polyline points="14 3 14 8 19 8" />
        </svg>
      );
    case 'bell':
      return (
        <svg {...common}>
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...common}>
          <line x1="4" y1="8" x2="20" y2="8" />
          <line x1="4" y1="16" x2="20" y2="16" />
          <circle cx="9" cy="8" r="2.4" />
          <circle cx="15" cy="16" r="2.4" />
        </svg>
      );
    case 'logout':
      return (
        <svg {...common}>
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <polyline points="16 17 21 12 16 7" />
          <line x1="21" y1="12" x2="9" y2="12" />
        </svg>
      );
    case 'login':
      return (
        <svg {...common}>
          <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
          <polyline points="10 17 15 12 10 7" />
          <line x1="15" y1="12" x2="3" y2="12" />
        </svg>
      );
    case 'chevron':
      return (
        <svg {...common} width={16} height={16} strokeWidth={2.2}>
          <polyline points="9 6 15 12 9 18" />
        </svg>
      );
  }
}

export function SiteDrawer({
  name,
  subtitle,
  initial,
  unread,
  busy,
  authenticated,
  githubConfigured,
  testLoginEnabled,
  onSignOut,
  onTestLogin,
}: {
  name: string;
  subtitle: string;
  initial: string;
  unread: number | null;
  busy: boolean;
  authenticated: boolean;
  githubConfigured: boolean;
  testLoginEnabled: boolean;
  onSignOut: () => void;
  onTestLogin: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const close = (returnFocus = false) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const row = (glyph: GlyphName, label: ReactNode, extra?: ReactNode) => (
    <>
      <Glyph name={glyph} />
      <span className="menu-row-label">{label}</span>
      {/*
        右侧值：**传 undefined 才用默认的箭头**；传 null 表示"右侧什么都不放"。
        用 `extra ?? <chevron/>` 会把 null 也当成"没传"而补上箭头（登出那一行因此多了个箭头）。
      */}
      {extra === undefined ? <Glyph name="chevron" /> : extra}
    </>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="icon-btn drawer-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="打开站点菜单"
        onClick={() => setOpen(true)}
      >
        <Glyph name="menu" />
      </button>

      {open ? (
        <>
          <div className="drawer-scrim" onClick={() => close(true)} />
          <aside className="site-drawer" role="dialog" aria-modal="true" aria-label="站点菜单">
            <div className="account-head">
              <span className="account-avatar" aria-hidden="true">
                {initial}
              </span>
              <div className="account-head-text">
                <p className="account-name truncate">{name}</p>
                <p className="account-sub truncate">{subtitle}</p>
              </div>
              <button
                ref={closeRef}
                type="button"
                className="account-close"
                aria-label="关闭菜单"
                onClick={() => close(true)}
              >
                <Glyph name="close" />
              </button>
            </div>

            {authenticated ? (
              <>
                <p className="menu-label">我的</p>
                <Link href="/me" role="menuitem" className="menu-row" onClick={() => close()}>
                  {row('review', '评测')}
                </Link>
                <Link
                  href="/me/notifications"
                  role="menuitem"
                  className="menu-row"
                  aria-label={unread !== null && unread > 0 ? `通知（${unread} 条未读）` : '通知'}
                  onClick={() => close()}
                >
                  {row(
                    'bell',
                    '通知',
                    unread !== null && unread > 0 ? <span className="menu-dot" aria-hidden="true" /> : undefined,
                  )}
                </Link>
                <Link href="/me/settings" role="menuitem" className="menu-row" onClick={() => close()}>
                  {row('settings', '个人设置')}
                </Link>

                <div className="divider" />
                <p className="menu-label">账户</p>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-row danger"
                  disabled={busy}
                  onClick={() => {
                    close();
                    onSignOut();
                  }}
                >
                  {row('logout', busy ? '正在登出…' : '登出', null)}
                </button>
              </>
            ) : (
              <>
                <p className="menu-label">账户</p>
                {githubConfigured ? (
                  <a href="/api/auth/github/start" role="menuitem" className="menu-row" onClick={() => close()}>
                    {row('login', '用 GitHub 登录')}
                  </a>
                ) : (
                  <p className="menu-note">
                    GitHub 登录未配置：服务端还没有设置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET。
                  </p>
                )}
                {testLoginEnabled ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="menu-row"
                    disabled={busy}
                    onClick={() => {
                      close();
                      onTestLogin();
                    }}
                  >
                    {row('login', busy ? '登录中…' : '测试登录（开发）', null)}
                  </button>
                ) : null}
              </>
            )}

            <div className="divider" />
            <p className="menu-label">外观</p>
            <ThemeMenuRow />

            <p className="menu-label">站点</p>
            <Link href="/spec" role="menuitem" className="menu-row" onClick={() => close()}>
              {row('review', '测评规范')}
            </Link>
          </aside>
        </>
      ) : null}
    </>
  );
}