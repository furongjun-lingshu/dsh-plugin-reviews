'use client';

/**
 * 评测页的「插件评测 ↔ 整合包评测」切换。
 *
 * 为什么需要客户端：
 *   两个页签共用 `/reviews` 这一个路径，只有 `?tab=` 不同。App Router 在 pathname
 *   不变时不会重挂页面，`MotionRuntime` 的入场动画也不会重跑，于是切换看起来是
 *   "啪"一下整块换掉。这里补两件事：
 *     1. **离场**：点标题先把当前面板按方向淡出 + 滑出（120ms），再 push 新 URL；
 *     2. **入场**：新面板挂载时从反方向滑入并淡入（方向记在 sessionStorage，跨导航传递）。
 *
 * 三条纪律（与 `globals.css` 的动效层一致）：
 *   - 只动 transform / opacity，不动布局属性；
 *   - `prefers-reduced-motion: reduce` 时既不加类也不延时，直接导航；
 *   - 修饰键点击（⌘/Ctrl/Shift/Alt、中键）不拦截，交给浏览器开新标签页。
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, type MouseEvent, type ReactNode } from 'react';
import { prefersReducedMotion } from './motion/engine';

/** 离场方向存在 sessionStorage 里，因为它要跨过一次客户端导航。 */
const DIR_KEY = 'reviews-switch-dir';

/** 离场动画时长；入场动画的时长写在 CSS 里（medium2 = 300ms）。 */
const LEAVE_MS = 120;

/** 方向只在刚点完的这一下有效：超过这个时间还没被用掉就当作陈旧数据丢掉。 */
const DIR_TTL_MS = 2000;

type Direction = 'fwd' | 'back';


/**
 * 读取（但**不**立刻删除）上一步记下的方向。
 *
 * 为什么读的时候不删：开发模式开了 StrictMode，effect 会挂载 → 卸载 → 再挂载，
 * 第一次读就删掉的话第二次读到 null，入场动画在 dev 里永远不播（线上正常，最难查的一类 bug）。
 * 真正的清理放在动画结束/兜底超时里，顺便用时间戳把陈旧的值挡掉。
 */
function readDirection(): Direction | null {
  try {
    const raw = sessionStorage.getItem(DIR_KEY);
    if (raw === null) return null;
    const [dir, stamp] = raw.split('|');
    if (dir !== 'fwd' && dir !== 'back') return null;
    if (!Number.isFinite(Number(stamp)) || Date.now() - Number(stamp) > DIR_TTL_MS) {
      sessionStorage.removeItem(DIR_KEY);
      return null;
    }
    return dir;
  } catch {
    return null;
  }
}

function clearDirection(): void {
  try {
    sessionStorage.removeItem(DIR_KEY);
  } catch {
    // 隐私模式禁用了 sessionStorage：本来也没存上
  }
}

/**
 * 页签的切换入口，同一份逻辑渲染成两种样子：
 *
 *  - `title`：标题本身（可见文字是当前页签 + 箭头）。读者看到的是"我在哪、往哪走"，
 *    而不是一个写着别处名字的按钮；
 *  - `chip`：标题旁的说明胶囊（「切到「整合包评测」」）。它长得像按钮，所以也真的能点 ——
 *    一个点了没反应的胶囊会让人以为站点坏了。
 *
 * `label` / `target` 只是两边可见文字的原料，真正拦住默认跳转、播动画、再 push 的是 onClick。
 */
export function ReviewsTabSwitchLink({
  href,
  label,
  target,
  direction,
  variant = 'title',
}: {
  href: string;
  label: string;
  target: string;
  direction: Direction;
  /** `title` 是标题里那条（可见文字是当前页签），`chip` 是标题旁的说明胶囊。 */
  variant?: 'title' | 'chip';
}) {
  const router = useRouter();
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();

    const panel = document.querySelector<HTMLElement>('[data-reviews-panel]');
    if (prefersReducedMotion() || panel === null) {
      router.push(href);
      return;
    }

    try {
      sessionStorage.setItem(DIR_KEY, `${direction}|${Date.now()}`);
    } catch {
      // 隐私模式禁用了 sessionStorage：那就只做离场，入场按默认淡入
    }

    panel.classList.remove('reviews-tab-out-fwd', 'reviews-tab-out-back');
    void panel.offsetWidth; // 上一次还在跑时强制重启
    panel.classList.add(direction === 'fwd' ? 'reviews-tab-out-fwd' : 'reviews-tab-out-back');

    timer.current = window.setTimeout(() => router.push(href), LEAVE_MS);
  };

  if (variant === 'chip') {
    return (
      <Link
        href={href}
        className="reviews-switch-hint"
        data-dir={direction}
        aria-label={`切换到${target}`}
        title="点这里或标题都能切换"
        onClick={onClick}
      >
        {direction === 'fwd' ? `切到「${target}」` : `切回「${target}」`}
      </Link>
    );
  }

  return (
    <Link
      href={href}
      className="reviews-switch-link"
      data-dir={direction}
      aria-label={`${label}，点击切换到${target}`}
      onClick={onClick}
    >
      {label}
    </Link>
  );
}

/**
 * 页签内容外壳：挂载时按上一步记下的方向播放入场。
 *
 * 调用方要给 `key={tab}` —— 页签切换只有 query 变化，不换 key 的话 React 复用同一个
 * DOM 节点，入场类名加在一个"还是旧内容"的节点上，动画就白做了。
 */
export function ReviewsTabPanel({ tab, children }: { tab: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  // useLayoutEffect：入场类要在绘制前挂上，否则新面板先亮一帧再跳回 opacity:0（闪一下）
  useLayoutEffect(() => {
    const panel = ref.current;
    if (panel === null) return;

    // 上一次的离场类名可能还挂在这个节点上（热更新 / 后退缓存），先摘干净再入场
    panel.classList.remove('reviews-tab-out-fwd', 'reviews-tab-out-back');

    const direction = prefersReducedMotion() ? null : readDirection();
    if (direction === null) {
      clearDirection();
      return;
    }

    const cls = direction === 'fwd' ? 'reviews-tab-in-fwd' : 'reviews-tab-in-back';
    panel.classList.add(cls);
    const done = () => {
      panel.classList.remove(cls);
      clearDirection();
    };
    panel.addEventListener('animationend', done, { once: true });
    // 兜底：动画被打断（切标签页、动画禁用）时别把内容留在透明态
    const timer = window.setTimeout(done, 600);
    return () => {
      window.clearTimeout(timer);
      panel.removeEventListener('animationend', done);
      panel.classList.remove(cls);
    };
  }, [tab]);

  return (
    <div className="reviews-tab-panel" data-reviews-panel ref={ref}>
      {children}
    </div>
  );
}