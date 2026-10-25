// @vitest-environment jsdom
/**
 * 草稿删除的提示文案必须与行为一致：只删草稿，不撤回、不影响已发布评测。
 *
 * 鉴别方式：把确认文案改回「会同时撤回已发布的评测」→ 对应用例红。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DraftList } from '../src/components/draft-list';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const messages: string[] = [];

beforeEach(() => {
  messages.length = 0;
  vi.spyOn(window, 'confirm').mockImplementation((message?: string) => {
    messages.push(String(message ?? ''));
    return false;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const DRAFTS = [
  {
    draftId: 'draft-1',
    title: '一篇草稿',
    saveVersion: 1,
    savedAt: 1_700_000_000_000,
    published: true,
    withdrawn: false,
  },
];

describe('草稿删除提示', () => {
  it('草稿区小字与单删确认都不再提「撤回」', () => {
    render(<DraftList drafts={DRAFTS} />);

    expect(screen.getByText('删除草稿只移除草稿，不影响已发布的评测。')).toBeTruthy();
    expect(screen.queryByText(/删除即撤回/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '删除草稿' }));
    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toContain('撤回');
    expect(messages[0]).toContain('不会受影响');
  });

  it('批量删除确认说明不会撤回已发布评测', () => {
    render(<DraftList drafts={DRAFTS} />);

    fireEvent.click(screen.getByRole('checkbox', { name: '全选' }));
    fireEvent.click(screen.getByRole('button', { name: /批量删除/ }));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('不会撤回');
    expect(messages[0]).not.toContain('会同时撤回');
  });
});
