/**
 * 后台页面。
 *
 * 两大块：
 *  1. **站点状态**：管理员在站内看到的完整报告，并把 worker 心跳计入结论
 *     —— worker 不跑，提交就不会被发布，这是管理员最该知道的一件事；
 *  2. **按处理阶段查提交**：可切到任一阶段看历史（默认只显示待办的那几个阶段）。
 */

import Link from 'next/link';
import { getDb, resolveDbPath } from '@/server/platform/db';
import { currentContext } from '../api/_lib/context';
import { isAdmin } from '@/server/platform/context';
import { AdminDecisionForm } from '@/components/admin-decision-form';
import { BackLink } from '@/components/back-link';
import { AdminSettingsForm } from '@/components/admin-settings-form';
import { AdminDiscoveryPanel } from '@/components/admin-discovery-panel';
import { AdminBackupPanel } from '@/components/admin-backup-panel';
import { AdminUserPanel } from '@/components/admin-user-panel';
import { buildHealthReport } from '@/server/platform/health';
import { submissionStateLabels } from '@/packages/common/status-text';
import type { SubmissionState } from '@/packages/common/field-rules';
import { formatDateTime } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

/** 全部处理阶段（供阶段选择器使用）。 */
const ALL_STATES: readonly SubmissionState[] = [
  'pending',
  'checking',
  'needs_changes',
  'manual_review',
  'approved',
  'published',
  'ineligible',
];

/** 默认视图＝待办口径：人工要处理的 + 正在流程中的。 */
const TODO_STATES: readonly SubmissionState[] = ['manual_review', 'pending', 'needs_changes'];

interface Row {
  submission_id: string;
  processing_state: SubmissionState;
  state_version: number;
  submitted_at: number;
  submitter_nickname: string;
  review_title: string | null;
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const ctx = await currentContext();

  if (!isAdmin(ctx)) {
    return (
      <div>
        <h1>后台</h1>
        <p className="muted">
          需要管理员身份。当前
          {ctx.userId === null ? '未登录' : '登录账户不是管理员'}。
        </p>
        <p className="muted">
          <strong>授予/撤销管理员只能由超级管理员在「用户管理」里完成</strong>（还要手打对方昵称确认），
          站内没有自我提权的入口。
        </p>
        <p className="muted">
          超级管理员由<strong>部署配置</strong>绑定：在 <code>.env</code> 里把 <code>SUPER_ADMIN_GITHUB_ID</code>
          设成他的 GitHub 数字 ID，他下次登录即成为管理员，并且这个身份在站内<strong>不可剥夺、不可转移</strong>。
          用 <code>node scripts/set-super-admin.mjs --list</code> 可以查看当前绑定与用户。
        </p>
      </div>
    );
  }

  const db = getDb();
  const requested = (await searchParams).state;
  const selected: SubmissionState | null = ALL_STATES.includes(requested as SubmissionState)
    ? (requested as SubmissionState)
    : null;

  const baseSelect = `SELECT s.id AS submission_id, s.processing_state, s.state_version, s.submitted_at,
                             u.nickname AS submitter_nickname, rev.title AS review_title
                        FROM content_submissions s
                        JOIN users u ON u.id = s.submitted_by
                       LEFT JOIN review_revisions rev ON rev.id = s.review_revision_id`;

  const rows = (
    selected === null
      ? db
          .prepare(
            `${baseSelect}
              WHERE s.processing_state IN (${TODO_STATES.map(() => '?').join(', ')})
              ORDER BY s.submitted_at ASC, s.id ASC`,
          )
          .all(...TODO_STATES)
      : db
          .prepare(`${baseSelect} WHERE s.processing_state = ? ORDER BY s.submitted_at DESC, s.id DESC`)
          .all(selected)
  ) as Row[];

  // 站点状态：管理员看到的完整报告（worker 心跳计入结论）。
  const health = buildHealthReport(db, {
    now: Date.now(),
    dbFile: resolveDbPath(process.env.DSH_REVIEW_DB_PATH),
    requireWorker: true,
  });
  const workerText =
    health.worker.state === 'ok'
      ? `正常（${Math.round((health.worker.age_ms ?? 0) / 1000)} 秒前）`
      : health.worker.state === 'stale'
        ? '卡住（心跳陈旧）'
        : health.worker.state === 'dead'
          ? '疑似已死'
          : '从未写过心跳';
  const statusText = health.status === 'ok' ? '正常' : health.status === 'fail' ? '故障' : '降级';
  // 三种结论三色标注；文字本身也写明结论，不靠颜色单独表意。
  const statusClass =
    health.status === 'ok' ? 'tag site' : health.status === 'fail' ? 'tag danger' : 'tag warn';
  // 磁盘余量按 GB 显示（MB 六位数难判读）
  const diskText =
    health.disk.free_mb === null
      ? '未检查（未给出库文件路径）'
      : health.disk.free_mb >= 1024
        ? `${(health.disk.free_mb / 1024).toFixed(1)} GB`
        : `${health.disk.free_mb} MB`;

  return (
    <div>
      <BackLink href="/">返回首页</BackLink>

      <h1>待处理事项</h1>

      {/* 阶段选择器：默认「待办」，可切到任一阶段看历史。 */}
      <div className="filters" style={{ marginTop: 12 }}>
        <span className="group-label">阶段</span>
        <Link href="/admin" className={selected === null ? 'active' : ''}>
          待办
        </Link>
        {ALL_STATES.map((s) => (
          <Link key={s} href={`/admin?state=${s}`} className={selected === s ? 'active' : ''}>
            {submissionStateLabels[s]}
          </Link>
        ))}
      </div>

      <p className="muted">
        共 {rows.length} 条
        {selected === null ? '（默认：等待人工处理 + 正在流程中）' : `（阶段：${submissionStateLabels[selected]}）`}
      </p>
      {rows.length === 0 ? (
        <p className="empty">
          当前没有
          {selected === null ? '待处理事项' : `处于「${submissionStateLabels[selected]}」的提交`}。
        </p>
      ) : (
        <div className="panel">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line)' }}>
                <th style={{ padding: 8 }}>标题</th>
                <th style={{ padding: 8 }}>提交者</th>
                <th style={{ padding: 8 }}>阶段</th>
                <th style={{ padding: 8 }}>提交时间</th>
                <th style={{ padding: 8 }}>决定</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.submission_id} style={{ borderBottom: '1px solid var(--line)' }}>
                  <td style={{ padding: 8 }}>{r.review_title ?? '(无标题)'}</td>
                  <td style={{ padding: 8 }}>{r.submitter_nickname}</td>
                  <td style={{ padding: 8 }}>{submissionStateLabels[r.processing_state]}</td>
                  <td className="muted" style={{ padding: 8 }}>
                    {formatDateTime(r.submitted_at)}
                  </td>
                  <td style={{ padding: 8 }}>
                    {/*
                      只对 manual_review 给决定按钮：
                        · 还在流程中 → 人工决定会跳过规则校验，所以不给按钮；
                        · needs_changes 等的是作者改稿，不是管理员再决定。
                      这两类如实说明，不摆一个点了也不对的按钮。
                    */}
                    {r.processing_state === 'manual_review' ? (
                      <AdminDecisionForm submissionId={r.submission_id} stateVersion={r.state_version} />
                    ) : (
                      <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                        {r.processing_state === 'pending' || r.processing_state === 'checking'
                          ? '等待检查任务处理，无需人工决定。'
                          : r.processing_state === 'needs_changes'
                            ? '等待作者修改后重新提交。'
                            : '已结束的提交，只作记录查看。'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted" style={{ marginTop: 16 }}>
        「通过并发布」会记录这次决定，<strong>并同时排入一条发布任务</strong>；真正的发布由 worker
        执行——<strong>worker 没在跑，内容就不会公开</strong>。
      </p>

      {/* 站点状态：管理员视角的完整报告。 */}
      <section className="panel" style={{ marginTop: 24 }}>
        <div className="section-head">
          <h2>站点状态</h2>
          <span className={statusClass}>{statusText}</span>
        </div>
        <div className="list-meta" style={{ marginBottom: 12 }}>
          <span>库结构版本：{health.schema_version ?? '未知'}</span>
          <span>检查时间：{formatDateTime(health.checked_at)}</span>
          <span>worker 心跳：{workerText}</span>
          <span>磁盘余量：{diskText}</span>
        </div>
        {/* 检查项：紧凑一行一项（诊断清单，不是内容列表） */}
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
          {health.checks.map((c) => (
            <li key={c.name} style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <code style={{ color: 'var(--accent)', fontSize: 13 }}>{c.name}</code>
              <span style={{ fontSize: 13, color: c.ok ? 'var(--muted)' : 'var(--danger)' }}>
                {c.ok ? '通过' : '异常'}
                {c.detail ? ` · ${c.detail}` : ''}
              </span>
            </li>
          ))}
        </ul>
        <p className="muted" style={{ marginTop: 12, marginBottom: 0, fontSize: 13 }}>
          这份报告<strong>不含任何凭据</strong>，也不做业务统计。这里把 worker 心跳计入结论：
          worker 停着而页面正常，是「看着没事、其实内容发不出去」的典型状态。
        </p>
      </section>

      {/* 顺序按"管理员日常先看什么"排：先看同步有没有跑、再改参数、再看备份、最后管人。 */}
      <AdminDiscoveryPanel />
      <AdminSettingsForm />
      <AdminBackupPanel />
      <AdminUserPanel />
    </div>
  );
}