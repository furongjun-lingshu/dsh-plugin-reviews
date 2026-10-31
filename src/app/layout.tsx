/**
 * 根布局。视觉层在 src/app/globals.css（Hylab 深色设计系统）统一维护，
 * 这里只搭页头 / 正文 / 页脚骨架，并接入参照站同款的三件事：
 *   1. Google Fonts（Inter / Plus Jakarta Sans / Space Grotesk）—— 与参照
 *      `网站\HTML\index.html` 完全一致的字体栈；取不到时回落到系统中文字体；
 *   2. 「跳至主内容」链接：键盘用户不必逐个 Tab 穿过导航；
 *   3. 阅读进度条：强调色→青的渐变细线，随滚动推进（客户端小组件）。
 */

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SessionNav } from '@/components/session-nav';
import { BambooBackdrop } from '@/components/bamboo-backdrop';
import { ReadingProgress } from '@/components/reading-progress';
import { MotionRuntime } from '@/components/motion-runtime';
import { BackToTop } from '@/components/back-to-top';
import { BottomNav } from '@/components/bottom-nav';
import './globals.css';

/**
 * 字体 CSS 异步加载：Google Fonts 是第三方请求，同步 stylesheet 会卡首屏。
 * 先 media="print" 非阻塞拉取，加载完切回 all；字体本身仍 display=swap。
 */
const GOOGLE_FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;700;800&display=swap';

export const metadata: Metadata = {
  // 站点标题与描述面向访问者，不再带"最小切片"这类项目内部说法。
  title: 'DSH 插件评测',
  description: 'DSH 插件目录与社区评测：收录插件、撰写与阅读评测、参与讨论。',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <meta name="theme-color" content="#f6f8f1" />
        {/* 首屏绘制前定主题：避免刷新时先亮后暗闪一下；只写 data-theme，不改任何行为。 */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('dsh-theme');if(t!=='dark'&&t!=='light'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.dataset.theme=t;var m=document.querySelector('meta[name=\"theme-color\"]');if(m)m.setAttribute('content',t==='dark'?'#121810':'#f6f8f1');}catch(e){}})();",
          }}
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link id="google-fonts" rel="stylesheet" href={GOOGLE_FONTS_HREF} media="print" />
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){var f=document.getElementById('google-fonts');if(!f)return;function on(){f.media='all';}if(f.sheet){on();}else{f.addEventListener('load',on,{once:true});}})();",
          }}
        />
        <noscript>
          <link rel="stylesheet" href={GOOGLE_FONTS_HREF} />
        </noscript>
      </head>
      <body>
        {/* 竹叶感背景装饰：固定底层，永远不挡点击（古风纸面肌理 + 轻量飘叶） */}
        <BambooBackdrop />
        <a className="skip" href="#main-content">
          跳至主内容
        </a>
        <ReadingProgress />
        {/* 动效运行时：入场、行级错峰、按压涟漪、数字跳变（减少动效时自动不参与） */}
        <MotionRuntime />
        {/* 回到顶部：滚过一屏才出现 */}
        <BackToTop />
        <header className="site-header">
          {/* 导航栏由客户端组件渲染：登录态来自 GET /api/session 的真实响应。 */}
          <SessionNav />
        </header>
        <main id="main-content" className="site-main">
          {children}
        </main>
        {/* 底部导航栏（M3 navigation bar）：≤900px 显示，桌面隐藏 */}
        <BottomNav />
        {/* 页脚已按主人要求整块删除（含那条分隔线）。
            "收录 ≠ 已实测可用"这句诚实声明仍在**插件提交页**与**引导页**上出现，没有丢失。 */}
      </body>
    </html>
  );
}