'use client';

/**
 * 后台「用户管理」组：授予/撤销管理员、禁用/恢复账户。
 *
 * 三条界面纪律：
 *  1. **不假装成功**：失败原样显示服务端的错误码与说明（含"最后一个可用管理员"这类拒绝）；
 *  2. **版本号来自刚读到的列表**，不缓存；版本不符时提示刷新；
 *  3. **一次用户操作一个键，重试复用同一个**，避免重试变成第二次操作。
 *
 * 唯一可用管理员的按钮提前置灰并写明原因，是为了不摆一个点下去必然失败的按钮
 * （服务端仍然会拒绝）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatDateTime } from '@/packages/common/time';
import { ApiError, ErrorNotice, apiFetch, newRequestKey } from './api-client';
import { SkeletonLines } from './skeleton';

interface AdminUserJson {
  user_id: string;
  nickname: string;
  avatar_url: string | null;
  github_login: string | null;
  /** 部署绑定的超级管理员：站内不可撤销、不可禁用（服务端同样会拒）。 */
  is_super_admin: boolean;
  role: 'user' | 'admin';
  account_status: 'active' | 'disabled';
  management_version: number;
  account_status_version: number;
  created_at: number;
  last_login_at: number | null;
}

interface UsersResponse {
  users: AdminUserJson[];
  active_admin_count: number;
  /** 观看者是不是超级管理员：只有他能授予/撤销管理员。 */
  viewer_is_super_admin: boolean;
  /** 部署是否绑定了超级管理员（没绑定 → 站内谁都授不了权）。 */
  super_admin_configured: boolean;
  /** 配置写错时的人话说明（例如填了多个 ID）。 */
  super_admin_config_problem: string | null;
}

interface UserMutationResponse {
  user: AdminUserJson;
  changed: boolean;
  replayed: boolean;
  revoked_sessions: number;
}

/** 一次用户操作的键缓存：失败保留（重试复用），成功丢弃（下次点击是新操作）。 */
type KeyStore = Map<string, string>;

export function AdminUserPanel() {
  const [data, setData] = useState<UsersResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 正在进行的操作键（`<userId>:<action>`）；非空时禁用按钮，避免同一用户并发两次操作。 */
  const [busy, setBusy] = useState<string | null>(null);
  /** 每个用户的禁用原因输入（禁用时必须非空）。 */
  const [reasons, setReasons] = useState<Record<string, string>>({});
  /** 待确认的角色变更：必须手打目标昵称才能提交（服务端还会再校验一次）。 */
  const [pendingRole, setPendingRole] = useState<{ user: AdminUserJson; nextRole: 'admin' | 'user' } | null>(null);
  const [typedNickname, setTypedNickname] = useState('');
  const keysRef = useRef<KeyStore>(new Map());

  const load = useCallback(async () => {
    try {
      const result = await apiFetch<UsersResponse>('/api/admin/users', { cache: 'no-store' });
      setData(result);
      setError(null);
    } catch (e) {
      setError(e as ApiError);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 唯一的写入入口：两种变更共用（body 里用 action 区分）。 */
  const mutate = useCallback(
    async (user: AdminUserJson, action: 'set_role' | 'set_status', body: Record<string, unknown>) => {
      const opKey = `${user.user_id}:${action}`;
      setBusy(opKey);
      setError(null);
      setNotice(null);
      try {
        if (!keysRef.current.has(opKey)) keysRef.current.set(opKey, newRequestKey());
        const requestKey = keysRef.current.get(opKey) as string;
        const result = await apiFetch<UserMutationResponse>(`/api/admin/users/${encodeURIComponent(user.user_id)}`, {
          method: 'PATCH',
          json: { action, ...body, request_key: requestKey },
        });
        // 成功了：这次操作结束，下一次点击必须重新开始。
        keysRef.current.delete(opKey);
        setNotice(describeOutcome(user, result));
        setReasons((prev) => ({ ...prev, [user.user_id]: '' }));
        await load();
        return true;
      } catch (e) {
        // 失败：保留同一个键，用户重试时复用同一个操作。
        setError(e as ApiError);
        return false;
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const viewerIsSuperAdmin = data?.viewer_is_super_admin === true;
  const activeAdminCount = data?.active_admin_count ?? 0;
  const lastActiveAdminId = useMemo(() => {
    if (data === null || activeAdminCount !== 1) return null;
    const only = data.users.find((u) => u.role === 'admin' && u.account_status === 'active');
    return only?.user_id ?? null;
  }, [data, activeAdminCount]);

  return (
    <section style={{ marginTop: 32, borderTop: '1px solid var(--line)', paddingTop: 16 }}>
      <h2 style={{ fontSize: 18 }}>用户管理</h2>
      <p className="muted">
        授予/撤销管理员、禁用/恢复账户 —— 全部在站内完成，不需要上机跑命令或手改数据库。
        每次变更都会记下<strong>谁、对谁、改了什么、为什么</strong>；这里的操作<strong>不能</strong>
        让普通用户把自己变成管理员。
      </p>

      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
      {notice ? <p className="notice success">{notice}</p> : null}

      {data === null ? (
        <SkeletonLines lines={3} label="正在读取用户…" />
      ) : (
        <>
          <div className="list-meta" style={{ marginBottom: 8 }}>
            <span>共 {data.users.length} 名用户</span>
            <span>可用管理员 {data.active_admin_count} 名</span>
          </div>

          {data.super_admin_config_problem !== null ? (
            <p className="notice warn">
              超级管理员配置有误：{data.super_admin_config_problem}
              <br />
              修正部署配置（<code>SUPER_ADMIN_GITHUB_ID</code>）并重启服务后才会生效。
            </p>
          ) : !data.super_admin_configured ? (
            <p className="notice warn">
              部署未绑定超级管理员（<code>SUPER_ADMIN_GITHUB_ID</code> 为空）：
              当前<strong>没有任何人</strong>能授予或撤销管理员。这是刻意的 fail-closed ——
              没配置就不放权，而不是退化成谁都能提权。
            </p>
          ) : !data.viewer_is_super_admin ? (
            <p className="notice">
              你当前是<strong>管理员</strong>：可以审核内容、处理用户状态，但
              <strong>授予/撤销管理员只由超级管理员执行</strong>（他是部署时绑定的那一个身份）。
            </p>
          ) : null}

          {data.active_admin_count <= 1 ? (
            <p className="notice warn">
              当前只有 {data.active_admin_count} 名可用管理员：撤销或禁用<strong>最后一名可用管理员</strong>会被拒绝
              （系统必须至少保留一名能审核内容的管理员）。
            </p>
          ) : null}

          {data.users.length === 0 ? (
            <p className="empty">还没有任何用户 —— 第一次 GitHub 登录会建立用户。</p>
          ) : (
            <ul className="item-list panel" style={{ padding: '4px 16px' }}>
              {data.users.map((user) => {
                const rowBusy = busy !== null;
                const isLastActiveAdmin = lastActiveAdminId === user.user_id;
                const reason = reasons[user.user_id] ?? '';
                const isAdmin = user.role === 'admin';
                const isActive = user.account_status === 'active';

                return (
                  <li className="item" key={user.user_id}>
                    <div className="item-body">
                      <h3>{user.nickname}</h3>

                      <div className="list-meta">
                        <span>GitHub：{user.github_login ?? '未绑定'}</span>
                        <span>注册：{formatDateTime(user.created_at)}</span>
                        <span>
                          最近登录：{user.last_login_at === null ? '从未登录' : formatDateTime(user.last_login_at)}
                        </span>
                        <span>
                          版本：管理 {user.management_version} · 状态 {user.account_status_version}
                        </span>
                      </div>

                      <div style={{ marginTop: 6 }}>
                        <span className={isAdmin ? 'tag site' : 'tag'}>{isAdmin ? '管理员' : '普通用户'}</span>
                        <span className={isActive ? 'tag' : 'tag danger'}>{isActive ? '账户正常' : '已禁用'}</span>
                        {isLastActiveAdmin ? <span className="tag warn">唯一可用管理员</span> : null}
                      </div>

                      <div
                        style={{
                          display: 'flex',
                          gap: 10,
                          alignItems: 'center',
                          flexWrap: 'wrap',
                          marginTop: 8,
                          fontSize: 14,
                        }}
                      >
                        {/* ---- 角色 ---- */}
                        {user.is_super_admin ? (
                          <span className="muted" style={{ fontSize: 13 }}>
                            部署绑定的超级管理员：站内不可撤销、不可禁用（要换人只能改部署配置并重启）。
                          </span>
                        ) : !viewerIsSuperAdmin ? (
                          <span className="muted" style={{ fontSize: 13 }}>
                            只有超级管理员能授予/撤销管理员。
                          </span>
                        ) : user.account_status === 'disabled' && !isAdmin ? (
                          <span className="muted" style={{ fontSize: 13 }}>
                            账户已禁用：先恢复才能授予管理员。
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="link-btn"
                            disabled={rowBusy || (isAdmin && isLastActiveAdmin)}
                            title={isAdmin && isLastActiveAdmin ? '最后一名可用管理员不能被撤销' : undefined}
                            onClick={() => {
                              // 不直接提交：先弹确认，要求手打对方昵称（服务端也会校验）。
                              setTypedNickname('');
                              setPendingRole({ user, nextRole: isAdmin ? 'user' : 'admin' });
                            }}
                          >
                            {isAdmin ? '撤销管理员' : '授予管理员'}
                          </button>
                        )}

                        {/* ---- 账户状态 ---- */}
                        <input
                          aria-label={`${user.nickname} 的状态变更原因`}
                          placeholder={isActive ? '禁用原因（必填，会记入记录）' : '恢复原因（必填）'}
                          value={reason}
                          onChange={(e) => setReasons((prev) => ({ ...prev, [user.user_id]: e.target.value }))}
                          style={{ flex: '1 1 220px', minWidth: 180 }}
                        />
                        <button
                          type="button"
                          className={isActive ? 'link-btn danger' : 'link-btn'}
                          disabled={
                            rowBusy ||
                            reason.trim() === '' ||
                            // 超级管理员不可禁用（服务端也会拒绝）
                            (isActive && user.is_super_admin) ||
                            // 最后一名可用管理员：禁用会被拒绝。恢复操作不做限制。
                            (isActive && user.role === 'admin' && isLastActiveAdmin)
                          }
                          title={
                            isActive && user.is_super_admin
                              ? '部署绑定的超级管理员不可禁用'
                              : isActive && user.role === 'admin' && isLastActiveAdmin
                              ? '最后一名可用管理员不能被禁用'
                              : reason.trim() === ''
                                ? '原因必填'
                                : undefined
                          }
                          onClick={() =>
                            void mutate(user, 'set_status', {
                              account_status: isActive ? 'disabled' : 'active',
                              reason,
                              expected_account_status_version: user.account_status_version,
                            })
                          }
                        >
                          {isActive ? '禁用账户' : '恢复账户'}
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="muted" style={{ fontSize: 13 }}>
            禁用会<strong>同时撤销该用户所有会话</strong>（立刻踢下线，旧 Cookie 不再可用），并阻止其重新登录；
            恢复后旧会话不会复活，需要重新登录。按钮对"最后一名可用管理员"提前置灰，
            服务端也会拒绝这类操作（错误码 <code>forbidden</code>，附{' '}
            <code>error.context.guard = last_active_admin</code>）。
          </p>
        </>
      )}

      {/*
        授予/撤销管理员的确认框：**必须手打目标昵称**才能提交。
        这是"防误点"那一层；真正的闸在服务端（confirm_target_nickname 必须与目标昵称一致），
        所以直接打 API 也绕不过去。
      */}
      {pendingRole !== null ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={pendingRole.nextRole === 'admin' ? '确认授予管理员' : '确认撤销管理员'}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.35)',
            display: 'grid',
            placeItems: 'center',
            padding: 16,
            zIndex: 50,
          }}
          onClick={() => setPendingRole(null)}
        >
          <div
            className="panel"
            style={{ maxWidth: 460, width: '100%', background: 'var(--md-sys-color-surface)' }}
            onClick={(event) => event.stopPropagation()}
          >
            <h3 style={{ marginTop: 0 }}>
              {pendingRole.nextRole === 'admin' ? '授予管理员权限' : '撤销管理员权限'}
            </h3>
            <p className="muted" style={{ fontSize: 14 }}>
              {pendingRole.nextRole === 'admin' ? '把' : '把'}{' '}
              <strong>「{pendingRole.user.nickname}」</strong>{' '}
              {pendingRole.nextRole === 'admin'
                ? '提升为管理员？他将能审核内容、处理用户与站点配置。'
                : '的管理员权限撤销？撤销后他仍是普通用户，可以正常浏览与发言。'}
            </p>
            <label style={{ display: 'block', fontSize: 13, margin: '10px 0 4px' }}>
              请原样输入对方昵称以确认：<code>{pendingRole.user.nickname}</code>
            </label>
            <input
              autoFocus
              aria-label="确认昵称"
              placeholder={pendingRole.user.nickname}
              value={typedNickname}
              onChange={(event) => setTypedNickname(event.target.value)}
              style={{ width: '100%' }}
            />
            <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
              <button
                type="button"
                className="button primary"
                disabled={typedNickname.trim() !== pendingRole.user.nickname || busy !== null}
                onClick={() => {
                  const p = pendingRole;
                  void mutate(p.user, 'set_role', {
                    role: p.nextRole,
                    expected_management_version: p.user.management_version,
                    confirm_target_nickname: typedNickname.trim(),
                  }).then((done) => {
                    // 成功才关框；失败保持打开，错误显示在面板顶部，可直接改了重试
                    if (done) setPendingRole(null);
                  });
                }}
              >
                确认{pendingRole.nextRole === 'admin' ? '授予' : '撤销'}
              </button>
              <button type="button" className="button" onClick={() => setPendingRole(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** 结果文案：重放与新执行分开说，避免"点了没变"看起来像失败。 */
function describeOutcome(before: AdminUserJson, result: UserMutationResponse): string {
  const who = `「${before.nickname}」`;
  const suffix = result.replayed ? '（重放：这一次没有重复执行）' : '';
  const roleChanged = before.role !== result.user.role;
  const statusChanged = before.account_status !== result.user.account_status;

  if (result.user.role === 'admin' && roleChanged) return `已授予 ${who} 管理员权限${suffix}。`;
  if (result.user.role === 'user' && roleChanged) return `已撤销 ${who} 的管理员权限${suffix}。`;
  if (result.user.account_status === 'disabled' && statusChanged) {
    return `已禁用 ${who}${suffix}，并撤销了 ${result.revoked_sessions} 个登录会话。`;
  }
  if (result.user.account_status === 'active' && statusChanged) return `已恢复 ${who}${suffix}。`;

  if (result.replayed) {
    return `${who} 的这次变更此前已执行过（重放），本次没有重复执行${suffix}。`;
  }
  if (!result.changed) return `${who} 的现状与请求一致，没有产生变更。`;
  return `已更新 ${who}${suffix}。`;
}