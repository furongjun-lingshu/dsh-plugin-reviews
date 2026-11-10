// @vitest-environment jsdom
/**
 * 动效引擎的"家规"测试。
 *
 * 参考工作区用 `_tools/motion-check.cjs`（真浏览器 + 20 条断言）钉这些行为；
 * 这里是同一套规矩的轻量版，跑在 jsdom 里，专门盯那些"改一行就可能悄悄破坏"的性质：
 *   1. `prefers-reduced-motion` 时**一个类都不加**（不只是 CSS 兜底）；
 *   2. 入场类一定是**一次性**的：跑完（或兜底超时）就摘掉；
 *   3. 面板入场按**视觉顺序**（top → left）排，不看 DOM 顺序；
 *   4. 数字补间在单位/小数位对不上时直接写值，不硬滚；
 *   5. 涟漪只插进能按的控件，且会自己清理。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installRipple,
  prefersReducedMotion,
  stagger,
  staggerPanels,
  tweenNumber,
} from '../src/components/motion/engine';

afterEach(() => {
  document.body.innerHTML = '';
  // @ts-expect-error 每个用例装的 matchMedia 替身要还原
  delete window.matchMedia;
  vi.useRealTimers();
});

function stubReducedMotion(reduced: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduced && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

describe('动效引擎：减少动效', () => {
  it('开启减少动效时不加任何入场类', () => {
    stubReducedMotion(true);
    const root = document.createElement('div');
    root.innerHTML = '<p>a</p><p>b</p>';
    document.body.appendChild(root);

    stagger(root);
    expect(root.className).not.toContain('motion-enter');
    expect(prefersReducedMotion()).toBe(true);
  });

  it('常规情况下加类，并在超时兜底后自己摘掉（一次性）', () => {
    stubReducedMotion(false);
    vi.useFakeTimers();
    const root = document.createElement('div');
    root.innerHTML = '<p>a</p><p>b</p>';
    document.body.appendChild(root);

    stagger(root, { step: 10 });
    expect(root.className).toContain('motion-enter');
    expect(root.children[0].getAttribute('style')).toContain('--i');

    vi.advanceTimersByTime(2000);
    expect(root.className).not.toContain('motion-enter');
  });
});

describe('动效引擎：面板入场顺序', () => {
  it('按视觉位置（top 再 left）排，而不是 DOM 顺序', () => {
    stubReducedMotion(false);
    const root = document.createElement('div');
    // DOM 顺序：下面那块在前；视觉顺序：上面那块在前（手机端 order 调换就是这个场景）
    root.innerHTML =
      '<section data-motion-panel id="low"></section><section data-motion-panel id="high"></section>';
    document.body.appendChild(root);
    const [low, high] = Array.from(root.querySelectorAll<HTMLElement>('section'));
    low.getBoundingClientRect = () => ({ top: 400, left: 0, height: 100, width: 100 }) as DOMRect;
    high.getBoundingClientRect = () => ({ top: 100, left: 0, height: 100, width: 100 }) as DOMRect;

    staggerPanels(root, { step: 10 });

    // 视觉更靠上的那块拿到 --i=0，慢的那块拿 1
    expect(high.style.getPropertyValue('--i')).toBe('0');
    expect(low.style.getPropertyValue('--i')).toBe('1');
  });
});

describe('动效引擎：数字补间', () => {
  it('单位/小数位对不上时直接写值', () => {
    stubReducedMotion(false);
    const node = document.createElement('span');
    node.textContent = '暂无';
    tweenNumber(node, '12');
    expect(node.textContent).toBe('12');
  });

  it('开启减少动效时不做补间，直接写值', () => {
    stubReducedMotion(true);
    const node = document.createElement('span');
    node.textContent = '3';
    tweenNumber(node, '9');
    expect(node.textContent).toBe('9');
  });
});

describe('动效引擎：涟漪', () => {
  it('只插进能按的控件，并自己清理', () => {
    stubReducedMotion(false);
    vi.useFakeTimers();
    const button = document.createElement('button');
    button.getBoundingClientRect = () =>
      ({ top: 0, left: 0, width: 80, height: 32, right: 80, bottom: 32 }) as DOMRect;
    document.body.appendChild(button);

    const stop = installRipple();
    const event = new Event('pointerdown', { bubbles: true }) as PointerEvent;
    Object.defineProperty(event, 'clientX', { value: 10 });
    Object.defineProperty(event, 'clientY', { value: 10 });
    button.dispatchEvent(event);

    expect(button.querySelector('.ripple')).not.toBeNull();
    expect(button.className).toContain('ripple-host');

    vi.advanceTimersByTime(1000);
    expect(button.querySelector('.ripple')).toBeNull();
    expect(button.className).not.toContain('ripple-host');

    stop();
  });

  it('普通容器上不插涟漪', () => {
    stubReducedMotion(false);
    const div = document.createElement('div');
    document.body.appendChild(div);
    const stop = installRipple();
    const event = new Event('pointerdown', { bubbles: true }) as PointerEvent;
    div.dispatchEvent(event);
    expect(div.querySelector('.ripple')).toBeNull();
    stop();
  });
});