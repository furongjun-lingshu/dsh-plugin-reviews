/**
 * 站内用户管理 · 单用户变更（单一入口，body 里区分改角色还是改状态）。
 *
 * PATCH /api/admin/users/{userId}
 *
 * body（字段与项目其它路由一致用 snake_case）：
 *   { action: 'set_role',   role: 'admin'|'user',     expected_management_version: <int>,
 *     confirm_target_nickname: <str 必填>, request_key: <str>, reason?: <str> }
 *   { action: 'set_status', account_status: 'active'|'disabled', reason: <str 必填>,
 *     expected_account_status_version: <int>, request_key: <str> }
 *
 * 权限：非管理员一律 403（**绝不提权**：普通用户改不了自己的角色，也改不了别人的）。
 * **授予或撤销管理员是超级管理员专属**（403 + context.guard='super_admin_required'），
 * 且必须带 `confirm_target_nickname`（原样重复目标昵称），否则 400。
 * 版本冲突 409（`version_conflict`）；同键不同内容 409（`request_key_reused`）；
 * 幂等重放返回原结果（`replayed: true`，本次不重复执行）。
 * 被"最后一名可用管理员"等守卫拦住时是 403 + `error.context.guard`（稳定标记，不必匹配中文）。
 */

import { getDb } from '@/server/platform/db';
import { isAdmin } from '@/server/platform/context';
import { err } from '@/packages/common/errors';
import {
  setUserRole,
  setUserStatus,
  toUserJson,
  type AdminUserJson,
  type UserAdminChangeResult,
} from '@/server/modules/identity/admin';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../_lib/context';

export const runtime = 'nodejs';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    if (ctx.userId === null) throw err.unauthenticated('该操作需要登录。');
    if (!isAdmin(ctx)) throw err.forbidden('该操作需要管理员权限。');

    const { userId } = await params;
    const body = (await readJson(request)) as {
      action?: unknown;
      role?: unknown;
      confirm_target_nickname?: unknown;
      account_status?: unknown;
      reason?: unknown;
      expected_management_version?: unknown;
      expected_account_status_version?: unknown;
      request_key?: unknown;
    };

    if (typeof body.request_key !== 'string' || body.request_key.trim() === '') {
      throw err.input('缺少请求标识。', [{ path: 'request_key', message: '必填且不能为纯空白。' }]);
    }

    const actorUserId = ctx.userId;
    const db = getDb();

    if (body.action === 'set_role') {
      if (body.role !== 'admin' && body.role !== 'user') {
        throw err.input('角色只能是 admin 或 user。', [{ path: 'role', message: '取值不合法。' }]);
      }
      if (!Number.isInteger(body.expected_management_version)) {
        throw err.input('缺少预期管理版本。', [
          { path: 'expected_management_version', message: '必须是非负整数。' },
        ]);
      }
      const result = setUserRole(db, {
        actorUserId,
        targetUserId: userId,
        role: body.role,
        expectedManagementVersion: body.expected_management_version as number,
        requestKey: body.request_key,
        // 授予/撤销管理员的显式确认（服务层强校验；缺失或不一致一律 400）。
        ...(typeof body.confirm_target_nickname === 'string'
          ? { confirmTargetNickname: body.confirm_target_nickname }
          : {}),
        // 角色变更的原因可选：省略时服务层按动作生成（审计的 reason 不允许为空）。
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      });
      return okJson(mutationJson(result), requestId);
    }

    if (body.action === 'set_status') {
      if (body.account_status !== 'active' && body.account_status !== 'disabled') {
        throw err.input('账户状态只能是 active 或 disabled。', [{ path: 'account_status', message: '取值不合法。' }]);
      }
      if (typeof body.reason !== 'string' || body.reason.trim() === '') {
        throw err.input('必须填写变更原因。', [{ path: 'reason', message: '必填且不能为纯空白。' }]);
      }
      if (!Number.isInteger(body.expected_account_status_version)) {
        throw err.input('缺少预期账户状态版本。', [
          { path: 'expected_account_status_version', message: '必须是非负整数。' },
        ]);
      }
      const result = setUserStatus(db, {
        actorUserId,
        targetUserId: userId,
        status: body.account_status,
        reason: body.reason,
        expectedAccountStatusVersion: body.expected_account_status_version as number,
        requestKey: body.request_key,
      });
      return okJson(mutationJson(result), requestId);
    }

    throw err.input('action 必须是 set_role 或 set_status。', [{ path: 'action', message: '取值不合法。' }]);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

/** 两种变更共用同一响应形状：变更后的用户视图 + 是否真的有变更 / 是否重放 / 撤销了几个会话。 */
function mutationJson(result: UserAdminChangeResult): {
  user: AdminUserJson;
  changed: boolean;
  replayed: boolean;
  revoked_sessions: number;
} {
  return {
    user: toUserJson(result.user),
    changed: result.changed,
    replayed: result.replayed,
    revoked_sessions: result.revokedSessionCount,
  };
}