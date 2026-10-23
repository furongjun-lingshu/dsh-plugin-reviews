/**
 * 我的收藏：收藏夹列表 + 标题搜索。
 *
 * - 顶层可以新建收藏夹；
 * - 点击收藏夹进入 /me/favorites/[folderId] 查看内容；
 * - 收藏夹详情里**不提供**新建收藏夹（避免嵌套）。
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { isAuthenticated } from '@/server/platform/context';
import { currentContext } from '../../api/_lib/context';
import { getDb } from '@/server/platform/db';
import { createInteractionsService } from '@/server/modules/interactions';
import { MeNav } from '@/components/me-nav';
import { CreateFolderForm } from '@/components/create-folder-form';
import { formatDateTime } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

function firstValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function FavoritesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await currentContext();
  if (!isAuthenticated(ctx)) redirect('/onboarding?returnTo=/me/favorites');

  const sp = await searchParams;
  const q = (firstValue(sp.q) ?? '').trim().slice(0, 100);
  const service = createInteractionsService({ db: getDb() });
  const folders = await service.listFavoriteFolders(ctx);
  const results = q ? await service.searchFavorites(ctx, q) : [];

  return (
    <div>
      <h1>我的收藏</h1>
      <div className="me-layout">
        <MeNav current="favorites" />
        <div>
          <form action="/me/favorites" method="get" className="search" style={{ marginBottom: 12 }}>
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="按插件标题搜索"
              aria-label="按插件标题搜索"
              maxLength={100}
            />
            <button type="submit" className="search-go">
              搜索
            </button>
          </form>

          {q ? (
            <section className="panel" aria-label="搜索结果">
              <div className="section-head">
                <h2>搜索结果（{results.length}）</h2>
              </div>
              {results.length === 0 ? (
                <p className="empty" style={{ marginBottom: 0 }}>
                  没有匹配「{q}」的收藏插件。
                </p>
              ) : (
                <ul className="item-list">
                  {results.map((f) => (
                    <li key={`${f.folderId}:${f.pluginId}`} className="item">
                      <div className="item-body">
                        <h3>
                          <Link href={`/plugins/${f.pluginId}`}>{f.displayName ?? f.repositoryFullName}</Link>
                          {f.pluginPath !== '.' ? <span className="muted"> · {f.pluginPath}</span> : null}
                          <span className="tag site" style={{ marginLeft: 8 }}>
                            在「{f.folderName}」
                          </span>
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
          ) : (
            <>
              <section className="panel" aria-label="收藏夹">
                <div className="section-head">
                  <h2>收藏夹（{folders.length}）</h2>
                </div>
                <CreateFolderForm />
                <ul className="item-list">
                  {folders.map((f) => (
                    <li key={f.folderId} className="item">
                      <div className="item-body">
                        <h3>
                          <Link href={`/me/favorites/${f.folderId}`}>{f.name}</Link>
                          {f.isDefault ? (
                            <span className="tag" style={{ marginLeft: 8 }}>
                              默认
                            </span>
                          ) : null}
                        </h3>
                        <div className="list-meta">
                          <span>{f.count} 个插件</span>
                          <span>创建于 {formatDateTime(f.createdAt)}</span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
                {folders.length === 0 ? (
                  <p className="empty" style={{ marginBottom: 0 }}>
                    还没有收藏夹。先在上面新建一个，或去<Link href="/plugins">插件目录</Link>收藏插件。
                  </p>
                ) : null}
              </section>
              <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
                点击收藏夹查看里面的插件；在插件详情页点「☆ 收藏」可以直接选择收藏夹。
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
