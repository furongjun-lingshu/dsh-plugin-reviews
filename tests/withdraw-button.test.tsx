// @vitest-environment jsdom
/**
 * 撤回按钮：只撤回评测，不删除草稿。
 *
 * 鉴别方式：把 deleteDraft 字段重新加回请求体 → 第二条断言红。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WithdrawButton } from '../src/components/withdraw-button';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

interface Call {
  url: string;
  body: string | null;
}

function stubFetch(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: typeof init?.body === 'string' ? init.body : null,
      });
      return {
        json: async () => ({ ok: true, data: { withdrawnAt: 1 }, request_id: 'r' }),
      };
    }),
  );
  return calls;
}

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('撤回按钮 · 仅撤回评测', () => {
  it('确认撤回：请求体只有撤回字段，没有 deleteDraft；提示历史保留', async () => {
    const calls = stubFetch();
    render(<WithdrawButton reviewId="review-1" expectedControlVersion={1} />);

    fireEvent.click(screen.getByRole('button', { name: '撤回这篇评测' }));
    fireEvent.click(screen.getByRole('button', { name: '确认撤回' }));

    await waitFor(() => expect(screen.getByText(/已撤回/)).toBeTruthy());
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0].body ?? '{}') as { deleteDraft?: boolean };
    expect(body.deleteDraft).toBeUndefined();
    expect(screen.getByText(/历史修订仍然保留/)).toBeTruthy();
  });

  it('取消确认：不发请求', () => {
    (window.confirm as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const calls = stubFetch();
    render(<WithdrawButton reviewId="review-1" expectedControlVersion={1} />);

    fireEvent.click(screen.getByRole('button', { name: '撤回这篇评测' }));
    fireEvent.click(screen.getByRole('button', { name: '确认撤回' }));

    expect(calls).toHaveLength(0);
  });
});
