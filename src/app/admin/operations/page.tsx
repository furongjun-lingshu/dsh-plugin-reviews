/**
 * 后台：操作记录 / 审核决定 查询。
 *
 * 两块内容，同一个页面两个视图：
 *   - **操作记录**（`operation_records`）：谁在什么时候对什么对象做了什么（含原因）；
 *   - **审核决定**（`content_moderation_records`）：每篇提交在哪个阶段被判成什么。
 *
 * 为什么并列：管理员排查「这篇为什么没发出去」时，两类记录都可能是线索——审核决定说明
 * 规则/人工怎么判的，操作记录说明之后谁又动过它。分在两个菜单里反而要来回跳。
 *
 * 口径（写清避免误读）：
 *   - **只读**：不提供修改/删除，历史记录不可变；
 *   - 操作记录可按动作类型与操作人筛选；审核决定只分页（数量本就不大）；
 *   - `changes` 是 JSON，按需展开看原文，不做智能解释；
 *   - 目标对象能解析出页面时给链接（评测 / 整合包版本 / 分类），解析不出就只显示 id ——
 *     不给一个点了 404 的链接。
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { currentContext } from '../../api/_lib/context';
import { isAdmin } from '@/server/platform/context';
import { formatDateTimeOr } from '@/packages/common/time';
import { submissionStateLabels } from '@/packages/common/status-text';
import type { SubmissionState } from '@/packages/common/field-rules';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 30;

interface OpsRow {
  id: string;
  action_type: string;
  actor_kind: 'user' | 'admin' | 'system';
  actor_user_id: string | null;
  actor_nickname: string | null;
  target_type: string;
  target_id: string;
  reason: string;
  changes: string;
  created_at: number;
}

interface DecisionRow {
  id: string;
  submission_id: string;
  stage: string;
  result: string;
  actor_kind: string;
  actor_nickname: string | null;
  reason: string;
  created_at: number;
  review_id: string | null;
  title: string | null;
  processing_state: SubmissionState | null;
}

/** 目标对象 → 可点击地址（解析不出返回 null，不给 404 链接）。 */
function resolveTargetHrefs(
  db: ReturnType<typeof getDb>,
  rows: OpsRow[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.target_type === 'plugin_category') {
      map.set(row.target_id, `/plugins?cat=${encodeURIComponent(row.target_id)}`);
    }
    if (row.target_type === 'pack_appeal') map.set(row.target_id, '/admin');
  }

  const ids = rows
    .filter((r) => r.target_type === 'content_entity' || r.target_type === 'pack_release')
    .map((r) => r.target_id);
  if (ids.length === 0) return map;

  const placeholders = ids.map(() => '?').join(', ');
  const entities = db
    .prepare(`SELECT id, content_type FROM content_entities WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ id: string; content_type: string }>;
  for (const entity of entities) {
    if (entity.content_type === 'review') {
      map.set(entity.id, `/reviews/${entity.id}`);
      continue;
    }
    if (entity.content_type === 'pack_release') {
      const rel = db
        .prepare('SELECT pack_id, release_number FROM plugin_pack_releases WHERE id = ?')
        .get(entity.id) as { pack_id: string; release_number: number | null } | undefined;
      if (rel) {
        map.set(
          entity.id,
          `/packs/${rel.pack_id}${rel.release_number === null ? '' : `?v=${rel.release_number}`}`,
        );
      }
    }
  }
  return map;
}

export default async function AdminOperationsPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; page?: string; view?: string; actor?: string }>;
}) {
  const ctx = await currentContext();
  if (!isAdmin(ctx)) redirect('/');

  const params = await searchParams;
  const view: 'ops' | 'decisions' = params.view === 'decisions' ? 'decisions' : 'ops';
  const actionFilter = (params.action ?? '').trim();
  const actorFilter = (params.actor ?? '').trim();
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);

  const db = getDb();

  /** 操作人下拉：库里现取（只列真正出现过的操作人），系统动作单列。 */
  const actors = db
    .prepare(
      `SELECT o.actor_user_id, u.nickname, COUNT(*) AS c
         FROM operation_records o
         LEFT JOIN users u ON u.id = o.actor_user_id
        GROUP BY o.actor_user_id
        ORDER BY c DESC`,
    )
    .all() as Array<{ actor_user_id: string | null; nickname: string | null; c: number }>;

  const actionTypes = (
    db
      .prepare('SELECT action_type, COUNT(*) AS c FROM operation_records GROUP BY action_type ORDER BY c DESC')
      .all() as Array<{ action_type: string; c: number }>
  ).map((r) => ({ type: r.action_type, count: Number(r.c) }));

  const opsWhere: string[] = [];
  const opsArgs: string[] = [];
  if (actionFilter !== '') {
    opsWhere.push('o.action_type = ?');
    opsArgs.push(actionFilter);
  }
  if (actorFilter !== '') {
    if (actorFilter === 'system') {
      opsWhere.push('o.actor_user_id IS NULL');
    } else {
      opsWhere.push('o.actor_user_id = ?');
      opsArgs.push(actorFilter);
    }
  }
  const opsWhereSql = opsWhere.length > 0 ? `WHERE ${opsWhere.join(' AND ')}` : '';

  const opsTotal = Number(
    (db.prepare(`SELECT COUNT(*) AS c FROM operation_records o ${opsWhereSql}`).get(...opsArgs) as { c: number }).c,
  );
  const opsRows =
    view === 'ops'
      ? (db
          .prepare(
            `SELECT o.id, o.action_type, o.actor_kind, o.actor_user_id, u.nickname AS actor_nickname,
                    o.target_type, o.target_id, o.reason, o.changes, o.created_at
               FROM operation_records o
               LEFT JOIN users u ON u.id = o.actor_user_id
               ${opsWhereSql}
              ORDER BY o.created_at DESC, o.id DESC
              LIMIT ? OFFSET ?`,
          )
          .all(...opsArgs, PAGE_SIZE, (page - 1) * PAGE_SIZE) as OpsRow[])
      : [];

  const decisionsTotal = Number(
    (db.prepare('SELECT COUNT(*) AS c FROM content_moderation_records').get() as { c: number }).c,
  );
  const decisionRows =
    view === 'decisions'
      ? (db
          .prepare(
            `SELECT m.id, m.submission_id, m.stage, m.result, m.actor_kind, m.reason, m.created_at,
                    u.nickname AS actor_nickname, rev.review_id, rev.title, s.processing_state
               FROM content_moderation_records m
               LEFT JOIN users u ON u.id = m.actor_user_id
               JOIN content_submissions s ON s.id = m.submission_id
               LEFT JOIN review_revisions rev ON rev.id = s.review_revision_id
              ORDER BY m.created_at DESC, m.id DESC
              LIMIT ? OFFSET ?`,
          )
          .all(PAGE_SIZE, (page - 1) * PAGE_SIZE) as DecisionRow[])
      : [];

  const total = view === 'ops' ? opsTotal : decisionsTotal;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const targetHrefs = view === 'ops' ? resolveTargetHrefs(db, opsRows) : new Map<string, string>();

  const qs = (over: Record<string, string | undefined>): string => {
    const search = new URLSearchParams();
    const merged: Record<string, string | undefined> = {
      view: view === 'ops' ? undefined : view,
      action: actionFilter || undefined,
      actor: actorFilter || undefined,
      ...over,
    };
    for (const [k, v] of Object.entries(merged)) if (v) search.set(k, v);
    const out = search.toString();
    return out ? `/admin/operations?${out}` : '/admin/operations';
  };

  return (
    <div>
      <h1>操作记录</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        共 {total} 条。只读历史，不提供修改入口。
      </p>

      <div className="filters" style={{ marginTop: 12 }}>
        <span className="group-label">视图</span>
        <Link href={qs({ view: undefined, action: undefined, actor: undefined })} className={view === 'ops' ? 'active' : ''}>
          操作记录
        </Link>
        <Link href={qs({ view: 'decisions', action: undefined, actor: undefined })} className={view === 'decisions' ? 'active' : ''}>
          审核决定
        </Link>
      </div>

      {view === 'ops' ? (
        <>
          <div className="filters" style={{ marginTop: 8 }}>
            <span className="group-label">动作</span>
            <Link href={qs({ action: undefined })} className={actionFilter === '' ? 'active' : ''}>
              全部
            </Link>
            {actionTypes.map((a) => (
              <Link key={a.type} href={qs({ action: a.type })} className={actionFilter === a.type ? 'active' : ''}>
                {a.type}（{a.count}）
              </Link>
            ))}
          </div>
          <div className="filters" style={{ marginTop: 8 }}>
            <span className="group-label">操作人</span>
            <Link href={qs({ actor: undefined })} className={actorFilter === '' ? 'active' : ''}>
              全部
            </Link>
            {actors.map((a) => {
              const value = a.actor_user_id ?? 'system';
              return (
                <Link key={value} href={qs({ actor: value })} className={actorFilter === value ? 'active' : ''}>
                  {a.actor_user_id === null ? '系统' : (a.nickname ?? a.actor_user_id.slice(0, 8))}（{Number(a.c)}）
                </Link>
              );
            })}
          </div>
        </>
      ) : null}

      {view === 'ops' ? (
        opsRows.length === 0 ? (
          <p className="empty">没有符合条件的操作记录。</p>
        ) : (
          <div className="panel">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line)' }}>
                  <th style={{ padding: 8 }}>时间</th>
                  <th style={{ padding: 8 }}>动作</th>
                  <th style={{ padding: 8 }}>操作人</th>
                  <th style={{ padding: 8 }}>对象</th>
                  <th style={{ padding: 8 }}>原因</th>
                  <th style={{ padding: 8 }}>变更</th>
                </tr>
              </thead>
              <tbody>
                {opsRows.map((r) => {
                  const href = targetHrefs.get(r.target_id);
                  return (
                    <tr key={r.id} style={{ borderBottom: '1px solid var(--line)', verticalAlign: 'top' }}>
                      <td className="muted" style={{ padding: 8, whiteSpace: 'nowrap' }}>
                        {formatDateTimeOr(r.created_at, '时间未知')}
                      </td>
                      <td style={{ padding: 8 }}>
                        <code style={{ fontSize: 12 }}>{r.action_type}</code>
                      </td>
                      <td style={{ padding: 8 }}>
                        {r.actor_kind === 'system' ? (
                          <span className="muted">系统</span>
                        ) : (
                          <span>
                            {r.actor_nickname ?? r.actor_kind}
                            {r.actor_kind === 'admin' ? <span className="muted">（管理员）</span> : null}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: 8 }}>
                        <span className="muted" style={{ fontSize: 12 }}>{r.target_type}</span>
                        <br />
                        {href ? (
                          <Link href={href}>
                            <code style={{ fontSize: 11 }}>{r.target_id.slice(0, 8)}…</code>
                          </Link>
                        ) : (
                          <code style={{ fontSize: 11 }}>{r.target_id.slice(0, 8)}…</code>
                        )}
                      </td>
                      <td style={{ padding: 8, maxWidth: 240 }}>{r.reason}</td>
                      <td style={{ padding: 8, maxWidth: 320 }}>
                        <details>
                          <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
                            查看原文
                          </summary>
                          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11, margin: 0 }}>
                            {r.changes}
                          </pre>
                        </details>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : decisionRows.length === 0 ? (
        <p className="empty">还没有审核决定记录。</p>
      ) : (
        <div className="panel">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line)' }}>
                <th style={{ padding: 8 }}>时间</th>
                <th style={{ padding: 8 }}>阶段</th>
                <th style={{ padding: 8 }}>结果</th>
                <th style={{ padding: 8 }}>处理人</th>
                <th style={{ padding: 8 }}>内容</th>
                <th style={{ padding: 8 }}>原因</th>
              </tr>
            </thead>
            <tbody>
              {decisionRows.map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--line)', verticalAlign: 'top' }}>
                  <td className="muted" style={{ padding: 8, whiteSpace: 'nowrap' }}>
                    {formatDateTimeOr(r.created_at, '时间未知')}
                  </td>
                  <td style={{ padding: 8 }}><code style={{ fontSize: 12 }}>{r.stage}</code></td>
                  <td style={{ padding: 8 }}>{r.result}</td>
                  <td style={{ padding: 8 }}>
                    {r.actor_kind === 'system' ? <span className="muted">系统</span> : (r.actor_nickname ?? r.actor_kind)}
                  </td>
                  <td style={{ padding: 8 }}>
                    {r.review_id ? (
                      <Link href={`/reviews/${r.review_id}`}>{r.title ?? '（评测）'}</Link>
                    ) : (
                      (r.title ?? '—')
                    )}
                    {r.processing_state ? (
                      <div className="muted" style={{ fontSize: 12 }}>
                        当前状态：{submissionStateLabels[r.processing_state]}
                      </div>
                    ) : null}
                  </td>
                  <td style={{ padding: 8, maxWidth: 320 }}>{r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 ? (
        <div className="pagination">
          {page > 1 ? <Link href={qs({ page: String(page - 1) })} className="button">上一页</Link> : null}
          <span className="muted">第 {page} / {totalPages} 页</span>
          {page < totalPages ? <Link href={qs({ page: String(page + 1) })} className="button">下一页</Link> : null}
        </div>
      ) : null}

      <p style={{ marginTop: 12 }}>
        <Link href="/admin">← 返回管理后台</Link>
      </p>
    </div>
  );
}
