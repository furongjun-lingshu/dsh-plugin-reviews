/** 后台：一个导入批次的逐条结果（含单条重试）。 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { currentContext } from '../../../api/_lib/context';
import { isAdmin } from '@/server/platform/context';
import { createImportService } from '@/server/modules/imports';
import { ImportRunButton } from '@/components/import-run-button';
import { formatDateTimeOr } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

export default async function AdminImportBatchPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId } = await params;
  const ctx = await currentContext();
  if (!isAdmin(ctx)) redirect('/');

  const service = createImportService({ db: getDb() });
  let batch;
  try {
    batch = await service.getBatch(ctx, batchId);
  } catch {
    notFound();
  }

  return (
    <div>
      <h1>导入批次</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        模式：{batch.mode === 'dry_run' ? '预演（不入库）' : '导入（检查通过即收录）'} ·
        建立于 {formatDateTimeOr(batch.createdAt, '时间未知')} ·
        共 {batch.counts.total} 条（成功 {batch.counts.done}、失败 {batch.counts.failed}、待处理 {batch.counts.pending}）
      </p>

      <p style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {batch.counts.pending > 0 ? (
          <ImportRunButton
            batchId={batch.batchId}
            label={'处理待办（' + batch.counts.pending + ' 条）'}
            className="button primary"
          />
        ) : null}
      </p>
      <p className="muted" style={{ fontSize: 13 }}>
        每轮最多处理受上游预算限制的条数；跑不完的留在这里，再点一次继续。
        「仓库 + 子路径」已有的条目会直接关联到既有插件，不会重复收录。
      </p>

      <section className="panel">
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line)' }}>
              <th style={{ padding: 8 }}>#</th>
              <th style={{ padding: 8 }}>仓库 / 子路径</th>
              <th style={{ padding: 8 }}>状态</th>
              <th style={{ padding: 8 }}>结果</th>
              <th style={{ padding: 8 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {batch.items.map((item) => (
              <tr key={item.itemId} style={{ borderBottom: '1px solid var(--line)', verticalAlign: 'top' }}>
                <td className="muted" style={{ padding: 8 }}>{item.position + 1}</td>
                <td style={{ padding: 8 }}>
                  <a href={item.url} target="_blank" rel="noreferrer">
                    <code style={{ fontSize: 12 }}>{item.key}</code>
                  </a>
                  {item.note ? <div className="muted" style={{ fontSize: 12 }}>{item.note}</div> : null}
                </td>
                <td style={{ padding: 8 }}>
                  {item.state === 'done' ? (
                    <span className="tag site">已处理</span>
                  ) : item.state === 'failed' ? (
                    <span className="tag warn">未通过</span>
                  ) : (
                    <span className="tag">待处理</span>
                  )}
                </td>
                <td style={{ padding: 8, maxWidth: 420 }}>
                  {item.pluginId ? (
                    <div style={{ fontSize: 13 }}>
                      插件：<Link href={'/plugins/' + item.pluginId}>{item.pluginId.slice(0, 8)}…</Link>
                    </div>
                  ) : null}
                  {item.issues.length > 0 ? (
                    <ul className="muted" style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12.5 }}>
                      {item.issues.map((issue, index) => (
                        <li key={index}>{issue}</li>
                      ))}
                    </ul>
                  ) : null}
                </td>
                <td style={{ padding: 8 }}>
                  {item.state !== 'done' ? (
                    <ImportRunButton batchId={batch.batchId} itemId={item.itemId} label={item.state === 'failed' ? '重试' : '处理'} className="button tonal" />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <p style={{ marginTop: 12 }}>
        <Link href="/admin/imports">← 返回导入列表</Link>
      </p>
    </div>
  );
}
