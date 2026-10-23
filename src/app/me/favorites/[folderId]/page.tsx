/**
 * 单个收藏夹：查看里面的插件。
 *
 * 按需求，这里**不提供**新建收藏夹（收藏夹里不能叠加创建收藏夹）；
 * 新建入口只在 /me/favorites 顶层。
 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { isAuthenticated } from '@/server/platform/context';
import { currentContext } from '../../../api/_lib/context';
import { getDb } from '@/server/platform/db';
import { createInteractionsService } from '@/server/modules/interactions';
import { MeNav } from '@/components/me-nav';
import { formatDateTime } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

export default async function FavoriteFolderPage({
  params,
}: {
  params: Promise<{ folderId: string }>;
}) {
  const { folderId } = await params;
  const ctx = await currentContext();
  if (!isAuthenticated(ctx)) redirect('/onboarding?returnTo=/me/favorites');

  const service = createInteractionsService({ db: getDb() });
  let data;
  try {
    data = await service.getFavoriteFolder(ctx, folderId);
  } catch {
    notFound();
  }

  const { folder, plugins } = data;

  return (
    <div>
      <h1>{folder.name}</h1>
      <div className="me-layout">
        <MeNav current="favorites" />
        <div>
          <p style={{ marginTop: 0 }}>
            <Link href="/me/favorites">← 返回收藏夹列表</Link>
          </p>

          <section className="panel" aria-label="收藏夹内容">
            <div className="section-head">
              <h2>
                {folder.name}（{plugins.length}）
                {folder.isDefault ? (
                  <span className="tag" style={{ marginLeft: 8 }}>
                    默认
                  </span>
                ) : null}
              </h2>
            </div>
            {plugins.length === 0 ? (
              <p className="empty" style={{ marginBottom: 0 }}>
                这个收藏夹还是空的。去<Link href="/plugins">插件目录</Link>看看，在插件详情页点「☆ 收藏」。
              </p>
            ) : (
              <ul className="item-list">
                {plugins.map((f) => (
                  <li key={f.pluginId} className="item">
                    <div className="item-body">
                      <h3>
                        <Link href={`/plugins/${f.pluginId}`}>{f.displayName ?? f.repositoryFullName}</Link>
                        {f.pluginPath !== '.' ? <span className="muted"> · {f.pluginPath}</span> : null}
                      </h3>
                      <div className="list-meta">
                        <span>{f.repositoryFullName}</span>
                        <span>收藏于 {formatDateTime(f.createdAt)}</span>
                        {f.isArchived ? <span className="tag warn">已归档</span> : null}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
