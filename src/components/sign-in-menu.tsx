'use client';

/**
 * 登录入口（M3 菜单形态）。
 *
 * 之前未登录时顶栏并列着两个按钮："用 GitHub 登录" 与 "测试登录（开发）"，
 * 在手机上它们会把顶栏挤成两行（实测截图确认），而且"测试登录"本就是开发向的东西，
 * 不该和真实登录并排摆给访问者看。
 *
 * 现在收成一个 filled 按钮 + 菜单：真实登录在第一位；测试通道只有在服务端开关打开时才出现，
 * 并明确标注"（开发）"。GitHub 未配置时**如实说明未配置**（不给一个点了会 503 的链接）。
 */

import { useEffect, useRef, useState } from 'react';
import { ThemeMenuRow } from './theme-switch';

export function SignInMenu({
  githubConfigured,
  testLoginEnabled,
  busy,
  onTestLogin,
}: {
  githubConfigured: boolean;
  testLoginEnabled: boolean;
  busy: boolean;
  onTestLogin: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="account-menu" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="button primary"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        登录
      </button>

      {open ? (
        <div className="account-dropdown" role="menu" aria-label="登录方式">
          {githubConfigured ? (
            <a href="/api/auth/github/start" role="menuitem" className="menu-row" onClick={() => setOpen(false)}>
              <span className="menu-row-label">用 GitHub 登录</span>
            </a>
          ) : (
            <>
              <p className="menu-label">登录</p>
              <p className="menu-note">GitHub 登录未配置：服务端还没有设置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET。</p>
            </>
          )}

          {testLoginEnabled ? (
            <>
              <div className="divider" />
              <p className="menu-label">开发</p>
              <button
                type="button"
                role="menuitem"
                className="menu-row"
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  onTestLogin();
                }}
              >
                <span className="menu-row-label">{busy ? '登录中…' : '测试登录（开发）'}</span>
              </button>
            </>
          ) : null}

          <div className="divider" />
          <p className="menu-label">外观</p>
          <ThemeMenuRow />
        </div>
      ) : null}
    </div>
  );
}