/**
 * 动效引擎（框架无关，纯 DOM）。
 *
 * 做法照搬参考工作区 `面板\panel\cmd\panel\web\motion.js`（HylabMotion）的骨架，
 * 按本项目的形态重写：那边是"每秒整页重绘"的实时面板，这边是长文阅读站，
 * 但**家规是同一条**，所以 API 也刻意保持一致（见四项纪律）：
 *
 *   1. **入场一次性**：加类 → 动画跑完（或超时兜底）→ 摘类。永不"常驻"，
 *      否则客户端重渲染 / HMR 会把入场重播一次，看着像闪屏；
 *   2. **只动 transform / opacity / color**：绝不动 width/height/top/left 这类布局属性，
 *      动布局会连累滚动位置与命中区域；
 *   3. **一切都是短的**（120–340ms），手感要跟手；
 *   4. `prefers-reduced-motion: reduce` 时**一个类都不加**（不只是靠 CSS 兜底），
 *      连 rAF、计时器都不启动。
 *
 * 与参考实现的差异（我们自己的判断）：
 *   - 面板入场按**视觉顺序**排（`panelTargets` 用 `getBoundingClientRect()` 排序），
 *     因为手机端会把某些区块 `order` 提前，按 DOM 顺序发延时会让"第一眼看到的那块"最后才出来；
 *   - 数字补间只在值真的变了才跑，且保留前后缀与小数位（"3.9%" 还是 "3.9%"）；
 *   - 提供 `slide()` 做"前进/后退"方向感，但用的是**真实容器的 transform**，
 *     不是整页 view transition（参考实现里实测过后者每次掉帧，我们同样不碰）。
 */

/** 减少动效偏好：读一次即可（中途改系统设置的极端情况不值得引入监听）。 */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** 每个节点上一次的"摘类计时器"：连着触发时先清掉旧的，避免提前摘掉新动画。 */
const timers = new WeakMap<Element, number>();

/**
 * 加类 → 等到点 → 摘类。
 *
 * ⚠️ **只听计时器，不听 animationend**：`animationend` 会从子元素冒泡上来，
 * 容器入场时"第一个子元素跑完"就会误触发、把还在错峰中的其它子元素一起摘类
 * （实测就是"后面的卡片闪一下直接跳到终态"）。参考实现也只用 `setTimeout`。
 * `ms` 要覆盖最长的那个（动画时长 + 错峰延迟 + 余量）。
 */
export function playOnce(node: Element | null, className: string, ms: number): void {
  if (!node || prefersReducedMotion()) return;
  const previous = timers.get(node);
  if (previous !== undefined) window.clearTimeout(previous);

  node.classList.remove(className);
  void (node as HTMLElement).offsetWidth; // 上一次还在跑时强制重启
  node.classList.add(className);

  timers.set(
    node,
    window.setTimeout(() => {
      node.classList.remove(className);
      timers.delete(node);
    }, ms),
  );
}

/** 错峰入场：给直接子元素写 `--i`，容器加 `.motion-enter`。 */
export function stagger(root: Element | null, { step = 45, max = 12 } = {}): void {
  if (!root || prefersReducedMotion()) return;
  const kids = Array.from(root.children) as HTMLElement[];
  if (kids.length === 0) return;
  kids.forEach((el, i) => {
    if (i <= max) el.style.setProperty('--i', String(i));
  });
  playOnce(root, 'motion-enter', 400 + Math.min(kids.length, max + 1) * step);
}

/** 列表行错峰：步长更小（行可能很多），容器加 `.motion-rows`。 */
export function staggerRows(group: Element | null, { step = 22, max = 16 } = {}): void {
  if (!group || prefersReducedMotion()) return;
  const rows = Array.from(group.children) as HTMLElement[];
  if (rows.length === 0) return;
  rows.forEach((el, i) => {
    if (i <= max) el.style.setProperty('--i', String(i));
  });
  playOnce(group, 'motion-rows', 380 + Math.min(rows.length, max + 1) * step);
}

/**
 * 面板入场：按**视觉顺序**（上到下、左到右）错峰，每个面板单独加 `.motion-panel`。
 *
 * 用单独加类而不是靠父选择器，是因为真机上这些面板散在不同容器里
 * （文章页是 grid，手机端还会被 `order` 调换），父选择器覆盖不到"跨容器的一组面板"。
 */
export function staggerPanels(
  root: ParentNode | null,
  { selector = '[data-motion-panel]', max = 8, step = 60 } = {},
): void {
  if (!root || prefersReducedMotion()) return;
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(selector))
    .map((el) => ({ el, box: el.getBoundingClientRect() }))
    // 还没布局（高度为 0）的不参与，避免把看不见的节点算进错峰序号
    .filter((entry) => entry.box.height > 0)
    .sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left)
    .slice(0, max)
    .map((entry) => entry.el);

  nodes.forEach((el, i) => {
    el.style.setProperty('--i', String(i));
    playOnce(el, 'motion-panel', 420 + (i + 1) * step);
  });
}

/** 方向感：前进从右滑入、后退从左滑入（只对真实容器做 transform）。 */
export function slide(node: Element | null, direction: 'forward' | 'back' = 'forward'): void {
  playOnce(node, direction === 'forward' ? 'motion-slide-in-right' : 'motion-slide-in-left', 420);
}

/** 值刚变过：闪一下（颜色 + 轻微上浮），用来"指认"哪块内容更新了。 */
export function tick(node: Element | null): void {
  playOnce(node, 'is-tick', 700);
}

/* ------------------------------------------------------------------ 数字补间 */

interface NumberParts {
  pre: string;
  post: string;
  value: number;
  decimals: number;
}

/** 把 "👍 有帮助 12" 这种文本拆成 前缀 / 数字 / 后缀（保留小数位）。 */
function splitNumber(text: string): NumberParts | null {
  const match = /^([^\d.-]*)(-?\d+(?:\.\d+)?)([\s\S]*)$/.exec(text);
  if (match === null) return null;
  return {
    pre: match[1],
    post: match[3],
    value: Number.parseFloat(match[2]),
    decimals: (match[2].split('.')[1] ?? '').length,
  };
}

interface Tween {
  from: number;
  to: number;
  pre: string;
  post: string;
  decimals: number;
  startedAt: number;
  duration: number;
}

const tweens = new Map<HTMLElement, Tween>();
let rafId = 0;

function stepTween(now: number): void {
  rafId = 0;
  for (const [node, tween] of tweens) {
    if (!node.isConnected) {
      tweens.delete(node);
      continue;
    }
    const k = Math.min(1, (now - tween.startedAt) / tween.duration);
    const eased = 1 - Math.pow(1 - k, 3); // easeOutCubic：数字停下来要"软着陆"
    const value = tween.from + (tween.to - tween.from) * eased;
    node.textContent = tween.pre + value.toFixed(tween.decimals) + tween.post;
    if (k >= 1) tweens.delete(node);
  }
  if (tweens.size > 0) rafId = window.requestAnimationFrame(stepTween);
}

/**
 * 数字滚动到目标值。
 *
 * 前后缀或小数位对不上（比如 "暂无" → "12"）就直接写死，不做假补间 ——
 * 硬滚一个语义不同的值比不滚更让人困惑。
 */
export function tweenNumber(
  node: HTMLElement | null,
  target: number | string,
  { ms = 320, threshold = 0 }: { ms?: number; threshold?: number } = {},
): void {
  if (!node) return;
  const next = String(target);
  if (prefersReducedMotion()) {
    node.textContent = next;
    return;
  }
  const to = splitNumber(next);
  const from = splitNumber(node.textContent ?? '');
  if (to === null || from === null || from.pre !== to.pre || from.post !== to.post || from.decimals !== to.decimals) {
    node.textContent = next;
    return;
  }
  if (Math.abs(to.value - from.value) < threshold) return; // 抖动不值一提，别动

  tweens.set(node, {
    from: from.value,
    to: to.value,
    pre: to.pre,
    post: to.post,
    decimals: to.decimals,
    startedAt: performance.now(),
    duration: ms,
  });
  if (rafId === 0) rafId = window.requestAnimationFrame(stepTween);
}

/* -------------------------------------------------------------------- 涟漪 */

/** 能被按压反馈命中的控件（与 CSS 的 `.ripple-host` 名单保持一致）。 */
const RIPPLE_TARGETS =
  'button:not(:disabled), .button, .menu-row, .icon-btn, .back-link, .filters a, .nav-bar-item';

/** 在控件上就地插一个涟漪。返回 false 表示这次没插（不是控件 / 已关动效）。 */
export function rippleAt(event: PointerEvent): boolean {
  if (prefersReducedMotion() || event.button > 0) return false;
  const target = event.target as HTMLElement | null;
  const host = target?.closest<HTMLElement>(RIPPLE_TARGETS);
  if (!host) return false;

  const box = host.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return false; // 不可见控件不插

  const size = Math.max(box.width, box.height) * 2;
  const dot = document.createElement('span');
  dot.className = 'ripple';
  dot.style.width = `${size}px`;
  dot.style.height = `${size}px`;
  dot.style.left = `${event.clientX - box.left - size / 2}px`;
  dot.style.top = `${event.clientY - box.top - size / 2}px`;

  host.classList.add('ripple-host');
  host.appendChild(dot);
  const cleanup = () => {
    dot.remove();
    if (!host.querySelector('.ripple')) host.classList.remove('ripple-host');
  };
  dot.addEventListener('animationend', cleanup, { once: true });
  window.setTimeout(cleanup, 800); // 动画被打断时的兜底
  return true;
}

/** 全局只装一次：pointerdown 时按需插涟漪（鼠标与触屏同一套）。 */
export function installRipple(): () => void {
  const onPointerDown = (event: PointerEvent) => {
    rippleAt(event);
  };
  document.addEventListener('pointerdown', onPointerDown, { passive: true });
  return () => document.removeEventListener('pointerdown', onPointerDown);
}