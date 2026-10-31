/**
 * 个人设置（`页面布局.md` §2 的 `/me/settings`；§10 的个人中心分栏）。
 *
 * 布局与 `/me` 一致：页标题 `h1` 在分栏之外，左侧栏目栏与右侧正文首行平齐。
 *
 * 为什么补这一页：`PATCH /api/me/profile` 早在第三轮就实现了、`ProfileForm` 也写好了，
 * 但**只被 `/onboarding` 用过一次** —— 于是资料表单里那句
 * "之后可以在「我的」页面再改"成了一句没人兑现的承诺：`/me` 页当时没有改资料的入口。
 * 本页把这条路径接通（接口、校验、组件都不新造，只补页面与入口）。
 *
 * 只读展示的角色 / 账户状态**刻意不给编辑控件**：改变它们需要管理版本、原因与去重键，
 * 属"站内还没有管理界面"的缺口（见 `docs/HANDOFF.md` 的 🟡 项），
 * 这里如实标注，不放一个点了会失败的按钮。
 */

import { getDb } from '@/server/platform/db';
import { currentContext } from '../../api/_lib/context';
import { BackLink } from '@/components/back-link';
import { ProfileForm } from '@/components/profile-form';
import { MeNav } from '@/components/me-nav';
import { formatDateTimeOr } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

interface Row {
  nickname: string;
  role: 'user' | 'admin';
  account_status: 'active' | 'disabled';
  created_at: number;
  last_login_at: number | null;
  provider_username: string | null;
  profile_url: string | null;
}

export default async function MeSettingsPage() {
  const ctx = await currentContext();

  if (ctx.userId === null) {
    return (
      <div>
        <BackLink href="/">返回首页</BackLink>
        <h1>个人设置</h1>
        <div className="me-layout">
          <MeNav current="settings" />
          <div style={{ maxWidth: 720 }}>
            <p className="muted" style={{ marginTop: 0 }}>
              需要先登录。请使用页面顶部的登录入口。
            </p>
          </div>
        </div>
      </div>
    );
  }

  const row = getDb()
    .prepare(
      `SELECT u.nickname, u.role, u.account_status, u.created_at, u.last_login_at,
              ei.provider_username, ei.profile_url
         FROM users u
         LEFT JOIN external_identities ei ON ei.user_id = u.id AND ei.provider = 'github'
        WHERE u.id = ?`,
    )
    .get(ctx.userId) as Row | undefined;

  const nickname = row?.nickname ?? '';

  return (
    <div>
      <h1>个人设置</h1>

      <div className="me-layout">
        <MeNav current="settings" />

        <div style={{ maxWidth: 720 }}>
          <section className="panel">
            <div className="section-head">
              <h2>展示昵称</h2>
            </div>
            <ProfileForm initialNickname={nickname} returnTo="/me" mode="settings" />
          </section>

          <section className="panel" style={{ marginTop: 20 }}>
            <div className="section-head">
              <h2>账户信息</h2>
            </div>
            <dl className="facts">
              <dt>登录方式</dt>
              <dd>
                {row?.provider_username ? (
                  row.profile_url ? (
                    <a href={row.profile_url} rel="noreferrer">
                      GitHub @{row.provider_username}
                    </a>
                  ) : (
                    <>GitHub @{row.provider_username}</>
                  )
                ) : (
                  <span className="muted">暂无已绑定身份</span>
                )}
              </dd>
              <dt>角色</dt>
              <dd>{row?.role === 'admin' ? '管理员' : '普通用户'}</dd>
              <dt>账户状态</dt>
              <dd>{row?.account_status === 'disabled' ? '已禁用' : '正常'}</dd>
              <dt>注册时间</dt>
              <dd>{formatDateTimeOr(row?.created_at ?? null, '未知')}</dd>
              <dt>上次登录</dt>
              <dd>{formatDateTimeOr(row?.last_login_at ?? null, '未知')}</dd>
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}