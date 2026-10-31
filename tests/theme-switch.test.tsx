// @vitest-environment jsdom
/**
 * 用户菜单里的深色模式开关：太阳/月亮 + 开关，点击切换 data-theme 并记住 localStorage。
 *
 * 鉴别方式：把 ThemeMenuRow 的 applyTheme 去掉 → 点后 data-theme 不变，用例红。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeMenuRow } from '../src/components/theme-switch';

beforeEach(() => {
  document.documentElement.dataset.theme = 'dark';
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe('用户菜单主题切换', () => {
  it('暗色时开关为开，点击切到亮色并记住', async () => {
    render(<ThemeMenuRow />);

    const row = await screen.findByRole('menuitemcheckbox', { name: '深色模式' });
    expect(row.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(row);

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('dsh-theme')).toBe('light');
    expect(row.getAttribute('aria-checked')).toBe('false');
  });

  it('由亮色再点回暗色', async () => {
    document.documentElement.dataset.theme = 'light';
    render(<ThemeMenuRow />);

    const row = await screen.findByRole('menuitemcheckbox', { name: '深色模式' });
    expect(row.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(row);

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('dsh-theme')).toBe('dark');
    expect(row.getAttribute('aria-checked')).toBe('true');
  });
});