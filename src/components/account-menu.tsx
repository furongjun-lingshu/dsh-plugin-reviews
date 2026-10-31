'use client';

/**
 * 页头账户下拉栏。
 *
 * 结构与参照工作区 `面板` 的账户菜单同类（头像 + 昵称 + 副标题 + 关闭键的头部、分组标签、
 * 每行一个图标 + 右侧箭头/数值），但**样式与图标是我们自己的**（沿用本站的深色 token 与线性 SVG）。
 *
 * 内容分两组：
 *   「我的」——评测 / 通知（右侧带未读数值）/ 个人设置，与个人中心左侧栏目同名；
 *   「账户」——登出（用警示色，与面板里"退出登录"的处理一致）。
 *
 * 可访问性：`aria-haspopup` / `aria-expanded`；点外部关闭；Esc 关闭并把焦点还给触发键；
 * 头部有独立的关闭按钮（触屏上比"点外部"更明确）。
 */

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ThemeMenuRow } from './theme-switch';

type GlyphName = 'review' | 'star' | 'bell' | 'settings' | 'logout' | 'close' | 'chevron';

/** 线性图标：与页头铃铛同一套画法（stroke=currentColor，视觉重量一致）。 */
function Glyph({ name }: { name: GlyphName }) {
  const common = {
    width: 17,
    height: 17,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.9,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (name) {
    case 'review':
      // 一篇带折角的文稿
      return (
        <svg {...common}>
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <polyline points="14 3 14 8 19 8" />
          <line x1="9" y1="13" x2="15" y2="13" />
          <line x1="9" y1="17" x2="13" y2="17" />
        </svg>
      );
    case 'star':
      // 收藏：五角星
      return (
        <svg {...common}>
          <path d="M12 3l2.7 5.5 6 .9-4.3 4.2 1 6-5.4-2.8-5.4 2.8 1-6L3.3 9.4l6-.9z" />
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
      // 一排可调项（比齿轮更"设置"且更轻）
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
    case 'close':
      return (
        <svg {...common}>
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      );
    case 'chevron':
      return (
        <svg {...common} width={15} height={15} strokeWidth={2.2}>
          <polyline points="9 6 15 12 9 18" />
        </svg>
      );
  }
}

export function AccountMenu({
  name,
  subtitle,
  initial,
  title,
  unread,
  busy,
  onSignOut,
}: {
  name: string;
  subtitle: string;
  initial: string;
  title?: string;
  unread: number | null;
  busy: boolean;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = (returnFocus = false) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(true);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div className="account-menu" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="account-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="account-avatar account-avatar-sm" aria-hidden="true">
          {initial}
        </span>
        <span className="truncate">{name}</span>
        <svg
          className="chevron"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open ? (
        <div className="account-dropdown" role="menu" aria-label="账户">
          <div className="account-head">
            <span className="account-avatar" aria-hidden="true">
              {initial}
            </span>
            <div className="account-head-text">
              <p className="account-name truncate">{name}</p>
              <p className="account-sub truncate">{subtitle}</p>
            </div>
            <button type="button" className="account-close" aria-label="关闭菜单" onClick={() => close(true)}>
              <Glyph name="close" />
            </button>
          </div>

          <p className="menu-label">我的</p>
          <Link href="/me" role="menuitem" className="menu-row" onClick={() => close()}>
            <Glyph name="review" />
            <span className="menu-row-label">评测</span>
            <Glyph name="chevron" />
          </Link>
          <Link href="/me/favorites" role="menuitem" className="menu-row" onClick={() => close()}>
            <Glyph name="star" />
            <span className="menu-row-label">收藏</span>
            <Glyph name="chevron" />
          </Link>
          <Link
            href="/me/notifications"
            role="menuitem"
            className="menu-row"
            /* 未读数量写进 aria-label：视觉上只给一个红点，读屏用户仍能听到具体条数 */
            aria-label={unread !== null && unread > 0 ? `通知（${unread} 条未读）` : '通知'}
            onClick={() => close()}
          >
            <Glyph name="bell" />
            <span className="menu-row-label">通知</span>
            {unread !== null && unread > 0 ? <span className="menu-dot" aria-hidden="true" /> : <Glyph name="chevron" />}
          </Link>
          <Link href="/me/settings" role="menuitem" className="menu-row" onClick={() => close()}>
            <Glyph name="settings" />
            <span className="menu-row-label">个人设置</span>
            <Glyph name="chevron" />
          </Link>

          <p className="menu-label">外观</p>
          <ThemeMenuRow />

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
            <Glyph name="logout" />
            <span className="menu-row-label">{busy ? '正在登出…' : '登出'}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}