// @vitest-environment jsdom
/**
 * 评测页「插件评测 ↔ 整合包评测」切换。
 *
 * 这个功能的难点不在 UI，而在**两个页签共用 `/reviews` 一个路径**（只有 ?tab 不同）：
 * App Router 不重挂页面，入场动画必须靠"点一下记方向、新面板挂载时读回来"来驱动。
 * 所以用例盯的是这几条：
 *  - 点标题先播离场动画，再 push（不是立刻跳）；
 *  - 方向跨导航传递（sessionStorage），新面板确实加上入场类；
 *  - ⌘/Ctrl 点击不拦截（交给浏览器开新标签页）；
 *  - 减少动效时一步到位：不加类、不延时直接 push。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReviewsTabPanel, ReviewsTabSwitchLink } from '../src/components/reviews-tab-switch';

const push = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

function renderTitleAndPanel(direction: 'fwd' | 'back' = 'fwd') {
  const props =
    direction === 'fwd'
      ? { href: '/reviews?tab=packs', label: '插件评测', target: '整合包评测' }
      : { href: '/reviews', label: '整合包评测', target: '插件评测' };
  render(
    <ReviewsTabPanel tab={direction === 'fwd' ? 'plugins' : 'packs'}>
      <ReviewsTabSwitchLink {...props} direction={direction} />
    </ReviewsTabPanel>,
  );
  return document.querySelector<HTMLElement>('[data-reviews-panel]')!;
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  push.mockReset();
  vi.useRealTimers();
  // @ts-expect-error 清掉用例临时装的替身
  delete window.matchMedia;
});

describe('评测页页签切换', () => {
  it('点标题：先加离场类，延时后才 push', () => {
    vi.useFakeTimers();
    const panel = renderTitleAndPanel('fwd');

    fireEvent.click(screen.getByRole('link'));

    expect(panel.className).toContain('reviews-tab-out-fwd');
    expect(push).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(push).toHaveBeenCalledWith('/reviews?tab=packs');
  });

  it('方向记在 sessionStorage 里，跨导航交给新面板', () => {
    vi.useFakeTimers();
    renderTitleAndPanel('back');
    fireEvent.click(screen.getByRole('link'));
    expect(sessionStorage.getItem('reviews-switch-dir')).toMatch(/^back\|/);
  });

  it('新面板读到方向就播入场动画（前进 / 后退方向相反）', () => {
    sessionStorage.setItem('reviews-switch-dir', `fwd|${Date.now()}`);
    const { unmount } = render(<ReviewsTabPanel tab="packs">内容</ReviewsTabPanel>);
    const panel = document.querySelector<HTMLElement>('[data-reviews-panel]')!;
    expect(panel.className).toContain('reviews-tab-in-fwd');

    unmount();
    sessionStorage.setItem('reviews-switch-dir', `back|${Date.now()}`);
    render(<ReviewsTabPanel tab="plugins">内容</ReviewsTabPanel>);
    expect(document.querySelector<HTMLElement>('[data-reviews-panel]')!.className).toContain(
      'reviews-tab-in-back',
    );
  });

  it('没有方向记录（直接打开页面）时不播入场动画', () => {
    render(<ReviewsTabPanel tab="plugins">内容</ReviewsTabPanel>);
    const panel = document.querySelector<HTMLElement>('[data-reviews-panel]')!;
    expect(panel.className).toBe('reviews-tab-panel');
  });

  it('⌘/Ctrl 点击不拦截，交给浏览器', () => {
    // href 用页内锚点：jsdom 对 anchor 的"真"导航只会往 stderr 打一行 Not implemented，
    // 用它测不到东西还脏输出；这里要验的只是"处理器有没有拦下来"。
    render(
      <ReviewsTabSwitchLink
        href="#stay"
        label="插件评测"
        target="整合包评测"
        direction="fwd"
      />,
    );
    fireEvent.click(screen.getByRole('link'), { metaKey: true });
    fireEvent.click(screen.getByRole('link'), { ctrlKey: true });
    expect(push).not.toHaveBeenCalled();
  });

  it('说明胶囊写着去向，且和标题指向同一个地址', () => {
    render(
      <ReviewsTabSwitchLink
        href="/reviews?tab=packs"
        label="插件评测"
        target="整合包评测"
        direction="fwd"
        variant="chip"
      />,
    );
    const chip = screen.getByRole('link');
    expect(chip.textContent).toContain('切到「整合包评测」');
    expect(chip.getAttribute('href')).toBe('/reviews?tab=packs');
    expect(chip.getAttribute('aria-label')).toBe('切换到整合包评测');
  });

  it('减少动效：不加类、不延时，直接跳', () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    const panel = renderTitleAndPanel('fwd');
    fireEvent.click(screen.getByRole('link'));

    expect(panel.className).not.toContain('reviews-tab-out');
    expect(push).toHaveBeenCalledWith('/reviews?tab=packs');
  });
});