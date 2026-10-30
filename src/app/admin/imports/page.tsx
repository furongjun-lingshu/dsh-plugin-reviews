/**
 * 后台：插件清单批量导入（架构 §49 / 需求 §25）。
 *
 * 一页做两件事：看历史批次 + 新建批次。每条批次点进去看逐条结果与单条重试。
 *
 * 为什么预演与导入并列而不是藏起来：这个功能一次会写十几到几十个插件，
 * 先预演看清「哪些能收、哪些不是插件、哪些早就有了」再导入，比导完再回滚便宜得多。
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { currentContext } from '../../api/_lib/context';
import { isAdmin } from '@/server/platform/context';
import { ImportBatchForm } from '@/components/import-batch-form';
import { formatDateTimeOr } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

interface Row {
  id: string;
  mode: 'dry_run' | 'apply';
  created_at: number;
  nickname: string | null;
  total: number;
  pending: number;
  done: number;
  failed: number;
}

export default async function AdminImportsPage() {
  const ctx = await currentContext();
  if (!isAdmin(ctx)) redirect('/');

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT b.id, b.mode, b.created_at, u.nickname,
              (SELECT COUNT(*) FROM batch_job_items i WHERE i.batch_id = b.id) AS total,
              (SELECT COUNT(*) FROM batch_job_items i WHERE i.batch_id = b.id AND i.processing_state = 'pending') AS pending,
              (SELECT COUNT(*) FROM batch_job_items i WHERE i.batch_id = b.id AND i.processing_state = 'done') AS done,
              (SELECT COUNT(*) FROM batch_job_items i WHERE i.batch_id = b.id AND i.processing_state = 'failed') AS failed
         FROM batch_jobs b
         LEFT JOIN users u ON u.id = b.requested_by
        ORDER BY b.created_at DESC, b.id DESC
        LIMIT 50`,
    )
    .all() as Row[];

  return (
    <div>
      <h1>插件清单导入</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        粘贴一份仓库清单，逐条执行与「提交插件」相同的收录检查；按「仓库 + 子路径」合并重复。
        每条都能单独重试，处理进度由条目状态汇总。
      </p>

      <section className="panel">
        <div className="section-head">
          <h2>新建批次</h2>
        </div>
        <ImportBatchForm />
      </section>

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="section-head">
          <h2>历史批次</h2>
        </div>
        {rows.length === 0 ? (
          <p className="empty" style={{ marginBottom: 0 }}>
            还没有导入批次。
          </p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line)' }}>
                <th style={{ padding: 8 }}>时间</th>
                <th style={{ padding: 8 }}>模式</th>
                <th style={{ padding: 8 }}>发起人</th>
                <th style={{ padding: 8 }}>进度</th>
                <th style={{ padding: 8 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--line)' }}>
                  <td className="muted" style={{ padding: 8, whiteSpace: 'nowrap' }}>
                    {formatDateTimeOr(r.created_at, '时间未知')}
                  </td>
                  <td style={{ padding: 8 }}>
                    {r.mode === 'dry_run' ? <span className="tag">预演</span> : <span className="tag site">导入</span>}
                  </td>
                  <td style={{ padding: 8 }}>{r.nickname ?? '—'}</td>
                  <td style={{ padding: 8 }}>
                    共 {Number(r.total)} 条 · 成功 {Number(r.done)} · 失败 {Number(r.failed)} · 待处理 {Number(r.pending)}
                  </td>
                  <td style={{ padding: 8 }}>
                    <Link href={'/admin/imports/' + r.id}>查看</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p style={{ marginTop: 12 }}>
        <Link href="/admin">← 返回管理后台</Link>
      </p>
    </div>
  );
}
