/**
 * 分页的纯判定（列表页与测试共用）。
 *
 * 「页面不存在」= 请求页 > 实际总页数。总页数为 0 表示列表本身为空，
 * 由各页的「目录为空」空状态处理，不算越界。
 */
export function isPageOutOfRange(page: number, totalPages: number): boolean {
  return totalPages > 0 && page > totalPages;
}
