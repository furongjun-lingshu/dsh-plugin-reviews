// @vitest-environment jsdom
/**
 * 页码跳转：输入页数 + 「跳转」。
 *
 * 关键行为：
 *  - 合法页码 → router.push 目标 URL（保留筛选条件）；
 *  - 越界页码 → 照常 push（由服务端显示「您输入的页面不存在」，客户端不 clamp）；
 *  - 非数字 / 小于 1 → 客户端提示，不导航。
 *
 * 鉴别方式：把 submit 里的越界 clamp 加回来 → 「越界页码照常导航」用例红。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PageJump } from '../src/components/page-jump';

const push = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

afterEach(() => {
  cleanup();
  push.mockReset();
});

function renderJump() {
  render(
    <PageJump
      page={2}
      totalPages={5}
      hrefTemplate="/reviews?q=dsh&page=__PAGE__"
    />,
  );
}

describe('PageJump', () => {
  it('输入合法页码：跳到目标页并保留筛选条件', () => {
    renderJump();
    const input = screen.getByLabelText('输入页码（共 5 页）');
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: '跳转' }));

    expect(push).toHaveBeenCalledWith('/reviews?q=dsh&page=4');
  });

  it('越界页码照常导航（不在客户端 clamp）', () => {
    renderJump();
    const input = screen.getByLabelText('输入页码（共 5 页）');
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: '跳转' }));

    expect(push).toHaveBeenCalledWith('/reviews?q=dsh&page=99');
  });

  it('非数字 / 小于 1：提示且不导航', () => {
    renderJump();
    const input = screen.getByLabelText('输入页码（共 5 页）');
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: '跳转' }));

    expect(screen.getByRole('alert').textContent).toContain('请输入有效页码');
    expect(push).not.toHaveBeenCalled();
  });
});
