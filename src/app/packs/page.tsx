/**
 * 整合包广场（`idea.md` §27；`架构设计.md` §88）：一包一项，展示最近仍公开的版本。
 *
 * 支持名称/用途说明关键词搜索（§27 明确 P0 不做标签筛选）。
 */

import Link from 'next/link';
import { getDb } from '@/server/platform/db';
import { createPacksService } from '@/server/modules/packs';
import { formatDateTimeOr } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

function readQuery(sp: Record<string, string | string[] | undefined>): { q: string; page: number } {
  const raw = Array.isArray(sp.q) ? sp.q[0] : sp.q;
  const rawPage = Array.isArray(sp.page) ? sp.page[0] : sp.page;
  const page = Number.parseInt(rawPage ?? '1', 10);
  return {
    q: (raw ?? '').trim().slice(0, 100),
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

function href(query: { q: string }, page = 1): string {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs.length > 0 ? `/packs?${qs}` : '/packs';
}

export default async function PacksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = readQuery(await searchParams);
  const result = await createPacksService({ db: getDb() }).listPublicPacks({
    q: query.q || undefined,
    page: query.page,
    page_size: PAGE_SIZE,
  });

  return (
    <div>
      <h1>整合包</h1>

      <div className="panel">
        <div className="section-head">
          <h2>公开整合包</h2>
          <span className="muted">共 {result.total} 个</span>
        </div>

        <form action="/packs" method="get" className="search" style={{ marginBottom: 12 }}>
          <input
            type="search"
            name="q"
            defaultValue={query.q}
            placeholder="搜名称或用途说明"
            aria-label="搜索整合包"
            maxLength={100}
          />
          <button type="submit" className="search-go">
            搜索
          </button>
        </form>

        {result.items.length === 0 ? (
          <p className="empty" style={{ marginBottom: 0 }}>
            {query.q ? (
              <>
                没有匹配的整合包（换个关键词，或<Link href="/packs">清除筛选</Link>）。
              </>
            ) : (
              <>
                还没有公开整合包。登录后可以在「我的 → 整合包」里用收藏夹创建第一个。
              </>
            )}
          </p>
        ) : (
          <ul className="item-list">
            {result.items.map((pack) => (
              <li key={pack.packId} className="item">
                <div className="item-body">
                  <div className="item-head">
                    <span className="tag site">第 {pack.releaseNumber} 版</span>
                    <div className="item-main">
                      <h3 className="item-title">
                        <Link href={`/packs/${pack.packId}`} prefetch={false}>{pack.title}</Link>
                      </h3>
                      <div className="list-meta">
                        <span className="truncate">{pack.purpose}</span>
                        <span>{pack.authorNickname}</span>
                        <span>{pack.pluginCount} 个插件</span>
                        <span>{pack.favoriteCount} 收藏</span>
                        <span>{formatDateTimeOr(pack.publishedAt, '时间未知')}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {result.total_pages > 1 ? (
          <div className="pagination">
            {result.page > 1 ? (
              <Link href={href(query, result.page - 1)} className="button">
                ← 上一页
              </Link>
            ) : (
              <span className="button" aria-disabled="true">
                ← 上一页
              </span>
            )}
            <span className="page-now">
              {result.page} / {result.total_pages}
            </span>
            {result.page < result.total_pages ? (
              <Link href={href(query, result.page + 1)} className="button">
                下一页 →
              </Link>
            ) : (
              <span className="button" aria-disabled="true">
                下一页 →
              </span>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
