'use client';

/**
 * 底部导航栏（M3 navigation bar）—— 移动端主导航。
 *
 * 为什么要有它：之前手机端把"插件 / 评测"两个导航胶囊塞在顶栏下面，
 * 占满一整行还压住了正文（实测截图确认）。M3 的做法是——顶栏只放标题与动作，
 * 主导航沉到底部，落在拇指自然可达的区域。
 *
 * M3 标准规格：容器色 surface-container、高 80dp、
 * 图标 24dp + label 12sp、选中项有一个 64×32 的指示药丸（secondary-container）。
 * 桌面（>900px）由 CSS 隐藏，主导航回到顶栏的 primary tabs。
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

interface Destination {
  href: string;
  label: string;
  /** 命中该前缀即认为选中（`/plugins/xxx` 也应点亮"插件"）。 */
  match: string[];
  icon: ReactNode;
}

const STROKE = {
  width: 24,
  height: 24,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

const DESTINATIONS: Destination[] = [
  {
    href: '/plugins',
    label: '插件',
    match: ['/plugins'],
    icon: (
      <svg {...STROKE}>
        <rect x="3" y="3" width="7" height="7" rx="2" />
        <rect x="14" y="3" width="7" height="7" rx="2" />
        <rect x="3" y="14" width="7" height="7" rx="2" />
        <rect x="14" y="14" width="7" height="7" rx="2" />
      </svg>
    ),
  },
  {
    href: '/packs',
    label: '整合包',
    match: ['/packs'],
    icon: (
      <svg {...STROKE}>
        <path d="M21 8 12 3 3 8l9 5 9-5z" />
        <path d="m3 12 9 5 9-5" />
        <path d="m3 16 9 5 9-5" />
      </svg>
    ),
  },
  {
    href: '/reviews',
    label: '评测',
    match: ['/reviews'],
    icon: (
      <svg {...STROKE}>
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <polyline points="14 3 14 8 19 8" />
        <line x1="9" y1="13" x2="15" y2="13" />
        <line x1="9" y1="17" x2="13" y2="17" />
      </svg>
    ),
  },
  /*
   * 原来第三个是「我的」。主人要求删掉：个人中心相关入口（评测/通知/个人设置/登出）
   * 都收进右上角那个**侧边抽屉**里，底部只留"去哪里找内容"这两个目的地。
   */
];

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="nav-bar" aria-label="主导航">
      <div className="nav-bar-inner">
        {DESTINATIONS.map((item) => {
          const active = item.match.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={active ? 'nav-bar-item active' : 'nav-bar-item'}
              aria-current={active ? 'page' : undefined}
            >
              <span className="nav-bar-indicator">{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}