/**
 * 后台：分区管理
 *
 *   GET  /api/admin/forum/boards/{boardId}                       分区本体 + 任职名单
 *   POST /api/admin/forum/boards/{boardId}                       管理员动作（见下）
 *
 * 动作（body.action）：
 *   appoint_moderator  { userId }              任命协管（owner / 站方管理员）
 *   remove_moderator   { userId }              罢免协管或区长（区长只能由站方管理员撤）
 *   transfer_owner     { userId }              转移区长（仅站方管理员）
 *   set_posting_policy { policy }              改发帖策略（owner / 站方管理员）
 *   set_posting_rule   { userId, mode }        mode = 'allow' | 'deny' | null（清除）
 *   set_status         { status }              'active' | 'archived'（仅站方管理员）
 *
 * 服务层（modules/forum/boards.ts）本来就把这六件事写全了，却没有任何入口调用——
 * 区长的任命、白黑名单、归档、转移在真实产品里根本走不到。这里补上 HTTP 面。
 *
 * 权限不在这一层再判一遍：各方法自己调 assertBoardManager / assertCanAdmin，
 * 路由只做"把 body 拆成参数"。两处各判一套正是权限判定漂移的来源。
 */

import { getDb } from '@/server/platform/db';
import { createForumBoardService } from '@/server/modules/forum/boards';
import { err } from '@/packages/common/errors';
import { assertCanWrite, isAdmin } from '@/server/platform/context';
import { currentContext, okJson, errorResponse, requestMeta, readJson, assertForumEnabled } from '../../../../_lib/context';

export const runtime = 'nodejs';

interface Body {
  action?: unknown;
  userId?: unknown;
  policy?: unknown;
  mode?: unknown;
  status?: unknown;
}

function str(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

export async function GET(request: Request, { params }: { params: Promise<{ boardId: string }> }): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    // 讨论区关站时接口表现为不存在（与其它 forum 接口同一口径）
    assertForumEnabled();
    const ctx = await currentContext();
    // 名单里含 user_id / 授予人，只给本区管理者与站方管理员看。
    //
    // 这条规则原本只写在注释里、代码没实现——匿名也能拿到整个任职名单（含谁任命的谁）。
    // 现在按「本区管理者与站方管理员」落实：先挡匿名，再判是否为管理员或本区成员。
    //
    // 为什么不能像 POST 那样统一 assertCanAdmin：POST 的六个动作确实都只给
    // owner / 站方管理员，但「看名单」区长与协管本就该能看——这是读，不是管。
    assertCanWrite(ctx);
    const { boardId } = await params;
    const service = createForumBoardService({ db: getDb() });
    const role = await service.boardRoleOf(boardId, ctx.userId);
    if (!isAdmin(ctx) && role === null) {
      throw err.forbidden('只有本区管理者与站方管理员可以查看任职名单。');
    }
    const members = await service.listMembers(ctx, boardId);
    return okJson({ boardId, myRole: role, members }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ boardId: string }> }): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    assertForumEnabled();
    const ctx = await currentContext();
    const { boardId } = await params;
    const body = ((await readJson(request)) ?? {}) as Body;
    const service = createForumBoardService({ db: getDb() });

    switch (str(body.action)) {
      case 'appoint_moderator': {
        const userId = str(body.userId);
        if (userId.length === 0) throw err.input('缺少 userId。', [{ path: 'userId', message: '必填' }]);
        await service.appointModerator(ctx, boardId, userId);
        return okJson({ ok: true }, requestId);
      }
      case 'remove_moderator': {
        const userId = str(body.userId);
        if (userId.length === 0) throw err.input('缺少 userId。', [{ path: 'userId', message: '必填' }]);
        await service.removeModerator(ctx, boardId, userId);
        return okJson({ ok: true }, requestId);
      }
      case 'transfer_owner': {
        const userId = str(body.userId);
        if (userId.length === 0) throw err.input('缺少 userId。', [{ path: 'userId', message: '必填' }]);
        await service.transferOwner(ctx, boardId, userId);
        return okJson({ ok: true }, requestId);
      }
      case 'set_posting_policy': {
        const policy = str(body.policy);
        if (policy !== 'everyone' && policy !== 'whitelist' && policy !== 'admin_only') {
          throw err.input('policy 只能是 everyone / whitelist / admin_only。', [
            { path: 'policy', message: '取值不合法' },
          ]);
        }
        await service.setPostingPolicy(ctx, boardId, policy);
        return okJson({ ok: true }, requestId);
      }
      case 'set_posting_rule': {
        const userId = str(body.userId);
        if (userId.length === 0) throw err.input('缺少 userId。', [{ path: 'userId', message: '必填' }]);
        // null 表示清除；'allow' / 'deny' 是白 / 黑名单
        const mode = body.mode === null ? null : str(body.mode);
        if (mode !== null && mode !== 'allow' && mode !== 'deny') {
          throw err.input('mode 只能是 allow / deny / null。', [{ path: 'mode', message: '取值不合法' }]);
        }
        await service.setPostingRule(ctx, boardId, userId, mode);
        return okJson({ ok: true }, requestId);
      }
      case 'set_status': {
        const status = str(body.status);
        if (status !== 'active' && status !== 'archived') {
          throw err.input('status 只能是 active / archived。', [{ path: 'status', message: '取值不合法' }]);
        }
        await service.setBoardStatus(ctx, boardId, status);
        return okJson({ ok: true }, requestId);
      }
      default:
        throw err.input('未知动作。', [{ path: 'action', message: '取值不合法' }]);
    }
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
