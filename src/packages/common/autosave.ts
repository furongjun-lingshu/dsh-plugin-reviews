/**
 * 草稿自动保存的可选间隔（服务端校验与客户端下拉共用同一份）。
 *
 * 放在 common 而不是各写一遍：白名单两处漂移的后果是"设置页能选、保存时被拒"，
 * 或者"服务端接受、客户端不认识"。
 */

/** 可选间隔（秒）。**0 = 关闭自动保存**（只手动存）。 */
export const AUTOSAVE_SECONDS_OPTIONS = [0, 3, 5, 10, 30] as const;

/** 默认间隔：停笔 5 秒（规划 §2.2）。 */
export const DEFAULT_AUTOSAVE_SECONDS = 5;

export function isAutosaveSeconds(value: unknown): value is number {
  return typeof value === 'number' && (AUTOSAVE_SECONDS_OPTIONS as readonly number[]).includes(value);
}

/** 下拉选项文案（0 单独说清楚是"关闭"）。 */
export function autosaveOptionLabel(seconds: number): string {
  return seconds === 0 ? '关闭（只手动保存）' : `${seconds} 秒`;
}

/**
 * 读取当前用户的自动保存间隔（客户端）。
 *
 * 缓存一份模块级结果：编辑器里"打开页面 → 载入偏好 → 计时"只该发生一次；
 * 设置页改完会调 `invalidateAutosaveCache()`，避免同一标签页里编辑器还用旧值。
 *
 * 读失败（未登录 / 网络错误 / 表还没迁移）一律回落默认值：偏好读不到不该让编辑器不可用。
 */
