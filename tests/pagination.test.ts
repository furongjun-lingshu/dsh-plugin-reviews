/**
 * 分页越界判定：给 /plugins 与 /reviews 的「您输入的页面不存在」共用。
 *
 * 鉴别方式：把 `totalPages > 0 && page > totalPages` 改成 `page > totalPages`，
 * 「空目录不算越界」用例会红（空列表会误报页面不存在）。
 */

import { describe, expect, it } from 'vitest';
import { isPageOutOfRange } from '../src/packages/common/pagination';

describe('isPageOutOfRange', () => {
  it('超过总页数为 true，等于/小于为 false', () => {
    expect(isPageOutOfRange(3, 2)).toBe(true);
    expect(isPageOutOfRange(2, 2)).toBe(false);
    expect(isPageOutOfRange(1, 1)).toBe(false);
  });

  it('总页数为 0 时不算越界（空目录走空状态，不报页面不存在）', () => {
    expect(isPageOutOfRange(2, 0)).toBe(false);
    expect(isPageOutOfRange(1, 0)).toBe(false);
  });
});
