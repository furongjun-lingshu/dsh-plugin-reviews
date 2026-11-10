'use client';

/**
 * 动效运行时（React 侧胶水）。
 *
 * 真正的规则在 `./motion/engine.ts`（纯 DOM，照参考工作区 `面板…/motion.js` 的骨架重写）。
 * 这里只负责"什么时候播"：
 *
 *   1. **顶栏栏目切换**（插件 / 整合包 / 评测 / 精选 / 讨论区 / 规范之间）：按左右顺序做
 *      shared axis X —— 前进从右滑入、后退从左滑入；
 *   2. **页面入场**：页面根容器的直接子元素错峰升起；
 *   3. **列表行**：`.item-list` / 表格 `tbody` 的行按更小步长错峰；
 *   4. **详情页面板**：带 `data-motion-panel` 的区块按**视觉顺序**错峰（手机端 `order` 调换也跟得上）；
 *   5. **按压涟漪**：全局只装一次（`installRipple`），不再跟着每次导航反复增删监听。
 *
 * 为什么用 `usePathname` 作依赖：App Router 里布局只挂载一次，页面切换不会重挂这个组件；
 * 以路径为 key 重跑，才能让"每次进入新页面都有一次入场"。
 * 只有 query 变化的切换（如 `/reviews?tab=packs`）不归这里管 —— 那是 `reviews-tab-switch.tsx`
 * 自己节奏（先离场再入场），两套逻辑不要抢同一个节点。
 */

import { useEffect, useLayoutEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import {
  installRipple,
  prefersReducedMotion,
  slide,
  stagger,
  staggerPanels,
  staggerRows,
} from './motion/engine';

/** 顶栏栏目在导航里的左右顺序：插件 → 整合包 → 评测 → 精选 → 讨论区 → 规范。 */
function sectionIndex(pathname: string): number | null {
  if (pathname === '/plugins' || pathname.startsWith('/plugins/')) return 0;
  if (pathname === '/packs' || pathname.startsWith('/packs/')) return 1;
  if (pathname === '/reviews' || pathname.startsWith('/reviews/')) return 2;
  if (pathname === '/featured' || pathname.startsWith('/featured/')) return 3;
  if (pathname === '/forum' || pathname.startsWith('/forum/')) return 4;
  if (pathname === '/spec' || pathname.startsWith('/spec/')) return 5;
  return null;
}

export function MotionRuntime() {
  const pathname = usePathname();
  const previousPath = useRef(pathname);

  /* 涟漪：装一次，卸载时摘掉（不跟导航走）。 */
  useEffect(() => installRipple(), []);

  /*
   * 用 useLayoutEffect 而不是 useEffect：入场类必须在**浏览器绘制之前**挂上，
   * 否则新页面先正常显示一帧、再跳回 opacity:0 开始动画 —— 看着就是"闪一下"。
   *
   * 只有**路径真的变了**才放：首次挂载（整页加载/刷新）时 SSR 的内容在 hydration
   * 之前就已经画出来了，这时候再补一个淡入，等于"先看见、又消失、再出现"。
   * 用"路径变了没有"判断而不是 `firstMount` 标记，是因为开发模式的 StrictMode 会把
   * effect 跑两遍：第一遍把标记翻掉，第二遍就又"不是首次"了（实测踩到）。
   */
  useLayoutEffect(() => {
    const previous = previousPath.current;
    previousPath.current = pathname;
    if (previous === pathname) return;
    if (prefersReducedMotion()) return;

    const main = document.getElementById('main-content');
    /* 动画施加在页面根节点（main 的第一个子元素）上；main 自己负责 overflow-x: clip，
       否则被平移的 main 本身会把文档撑宽，手机底栏会跟着 innerHeight 跳。 */
    const pageRoot = (main?.firstElementChild as HTMLElement | null) ?? null;

    const from = sectionIndex(previous);
    const to = sectionIndex(pathname);
    const changedSection = from !== null && to !== null && from !== to;

    if (changedSection && pageRoot) {
      slide(pageRoot, to > from ? 'forward' : 'back');
      return;
    }

    /* 详情页有 `data-motion-panel` 时按视觉顺序逐个入场；
       否则退回"页面根容器的直接子元素错峰"。
       两者只选一个 —— 同时做会让父块与子块套着动，看着像抖两下。 */
    if (pageRoot && pageRoot.querySelector('[data-motion-panel]') !== null) {
      staggerPanels(pageRoot);
    } else if (pageRoot) {
      stagger(pageRoot);
    }
    document.querySelectorAll('.item-list, .panel table tbody').forEach((group) => staggerRows(group));
  }, [pathname]);

  return null;
}