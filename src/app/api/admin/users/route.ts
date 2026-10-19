/**
 * 站内用户管理 · 列表（规划要求"日常数据管理全部通过后台页面完成，不得要求管理员直接改数据库表"）。
 *
 * GET /api/admin/users   全部用户（GitHub 账号、昵称、角色、账户状态、版本号、注册/最近登录时间）
 *
 * 权限每次从库里读（不缓存角色）；非管理员 403。
 * 只回可公开的管理字段：**不含**会话摘要、身份 ID 等任何凭据类数据。
 *
 * 同时给出 `active_admin_count`：后台据此提示"现在只有一名可用管理员，
 * 撤销/禁用会被服务端拒绝"，而不是等用户点下去才报错。
 */

import { getDb } from '@/server/platform/db';
import { isAdmin, isSuperAdmin } from '@/server/platform/context';
import { err } from '@/packages/common/errors';
import { countActiveAdmins, listUsers, toUserJson } from '@/server/modules/identity/admin';
import { configuredSuperAdminId, describeSuperAdminConfig } from '@/server/modules/identity/super-admin';
import { currentContext, okJson, errorResponse, requestMeta } from '../../_lib/context';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    if (!isAdmin(ctx)) throw err.forbidden('该操作需要管理员权限。');

    const db = getDb();
    return okJson(
      {
        users: listUsers(db).map(toUserJson),
        active_admin_count: countActiveAdmins(db),
        /** 观看者是不是超级管理员 —— 界面据此决定"授予/撤销管理员"的按钮给不给。 */
        viewer_is_super_admin: isSuperAdmin(ctx),
        /** 部署是否绑定了超级管理员；没绑定时后台要明说"现在谁都授不了权"。 */
        super_admin_configured: describeSuperAdminConfig().problem === null && configuredSuperAdminId() !== null,
        /** 配置写错时把原因带出来（例如填了多个 ID），而不是静默当成没配。 */
        super_admin_config_problem: describeSuperAdminConfig().problem,
      },
      requestId,
    );
  } catch (e) {
    return errorResponse(e, requestId);
  }
}