/**
 * 超级管理员：**部署时绑定**的唯一管理员身份。
 *
 * 设计取舍（与「把不变量写进数据库」的其它部分不同，这里刻意放在部署配置里）：
 *  1. **谁当超级管理员，由部署决定，不写死**：读环境变量 `SUPER_ADMIN_GITHUB_ID`
 *     （GitHub **稳定数字 ID**；与 `BOOTSTRAP_ADMIN_GITHUB_ID` 同一口径 ——
 *      用户名可以改，认它等于给出一个可伪造的身份）。
 *  2. **唯一**：只接受一个值；出现空白/逗号/分号分隔的多个 ID 一律视为**配置错误**
 *     （fail-closed：当作未配置，并在启动日志与后台明确报出来，不猜谁是超管）。
 *  3. **不可剥夺**：站内**没有任何**入口能授予、撤销或转移这个身份；
 *     配置里绑定的那个账号也不能被降级为普通管理员、不能被禁用（服务层守卫）。
 *     要换人只能改部署配置并重启 —— 那是运维动作，不是站内功能。
 *  4. **登录即绑定**：该身份首次登录会被（幂等地）提升为管理员，
 *     这样"部署时决定"不需要任何人工上机跑命令。
 *
 * 未配置时的行为：**没有任何人是超级管理员** → 站内谁都授予不了管理员
 * （/admin 会明说这一点），而不是退化成"谁都能提权"。
 */

/** 环境变量名（与 BOOTSTRAP_ADMIN_GITHUB_ID 同一命名风格，不带 DSH_REVIEW_ 前缀）。 */
export const SUPER_ADMIN_ENV = 'SUPER_ADMIN_GITHUB_ID';

export interface SuperAdminConfig {
  /** 生效的超级管理员 GitHub 稳定 ID；未配置或配置非法时为 null。 */
  id: string | null;
  /** 配置有问题时给出人话说明（启动日志与后台展示用）；没问题时为 null。 */
  problem: string | null;
}

/** 解析部署配置。唯一性与格式在这里判死，不做"猜一个"的兜底。 */
export function describeSuperAdminConfig(env: NodeJS.ProcessEnv = process.env): SuperAdminConfig {
  const raw = (env[SUPER_ADMIN_ENV] ?? '').trim();
  if (raw === '') {
    return { id: null, problem: null };
  }
  if (/[\s,;]/.test(raw)) {
    return {
      id: null,
      problem: `${SUPER_ADMIN_ENV} 只能填一个 GitHub 稳定数字 ID（当前值里出现空白或分隔符）—— 已按"未配置"处理。`,
    };
  }
  return { id: raw, problem: null };
}

/** 生效的超级管理员 ID（热路径用；配置非法时等价于未配置）。 */
export function configuredSuperAdminId(env: NodeJS.ProcessEnv = process.env): string | null {
  return describeSuperAdminConfig(env).id;
}

/** 某个 GitHub 稳定 ID 是否就是部署绑定的超级管理员。 */
export function isSuperAdminProviderId(
  providerUserId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const id = configuredSuperAdminId(env);
  return id !== null && typeof providerUserId === 'string' && providerUserId === id;
}
