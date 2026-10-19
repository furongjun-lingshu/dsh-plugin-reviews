/**
 * 全站评测列表：只列当前公开文章。
 *
 *  - 来源筛选：全部／站点／社区（数据在 `reviews.source_kind`）；
 *  - 真实总数 + 分页；
 *  - 条目显示标题、来源、关联插件、作者、时间。
 *
 * 两条纪律：条件留在 URL；两种空状态文案必须不同（列表真的为空 vs 筛选没匹配到）。
 */

import Link from 'next/link';
import { getDb } from '@/server/platform/db';
import { resolveVisibilityInTx } from '@/server/modules/content';
import { formatDateTimeOr } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

type SourceFilter = 'all' | 'site' | 'community';

interface Row {
  review_id: string;
  title: string;
  source_kind: 'community' | 'site';
  public_updated_at: number | null;
  author_nickname: string;
  plugin_display_name: string | null;
  plugin_path: string | null;
  repo_full_name: string | null;
  plugin_id: string | null;
}

function readConditions(sp: Record<string, string | string[] | undefined>): {
  source: SourceFilter;
  page: number;
} {
  const raw = Array.isArray(sp.source) ? sp.source[0] : sp.source;
  const rawPage = Number.parseInt((Array.isArray(sp.page) ? sp.page[0] : sp.page) ?? '1', 10);
  return {
    source: raw === 'site' || raw === 'community' ? raw : 'all',
    page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1,
  };
}

/** 与首页同一口径：清单名优先，缺则仓库全名；子目录形态带上子路径。 */
function pluginLabel(row: Row): string | null {
  if (row.repo_full_name === null) return null;
  const base = row.plugin_display_name ?? row.repo_full_name;
  const subPath = row.plugin_path && row.plugin_path !== '.' ? ` / ${row.plugin_path}` : '';
  return `${base}${subPath}`;
}

function listHref(source: SourceFilter, page = 1): string {
  const params = new URLSearchParams();
  if (source !== 'all') params.set('source', source);
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs.length > 0 ? `/reviews?${qs}` : '/reviews';
}

export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const conditions = readConditions(await searchParams);
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT r.id AS review_id, rev.title, r.source_kind, ce.public_updated_at,
              u.nickname AS author_nickname,
              r.plugin_id, p.display_name AS plugin_display_name, p.plugin_path,
              repo.full_name AS repo_full_name
         FROM reviews r
         JOIN content_entities ce ON ce.id = r.id
         JOIN users u ON u.id = ce.author_id
         JOIN review_revisions rev ON rev.id = r.published_revision_id
         LEFT JOIN plugins p ON p.id = r.plugin_id
         LEFT JOIN repositories repo ON repo.id = p.repository_id
        ORDER BY ce.public_updated_at DESC, r.id ASC`,
    )
    .all() as Row[];

  // 公开资格逐行核验（与首页、插件目录同一判据）。
  const visible = rows.filter((row) => resolveVisibilityInTx(db, row.review_id).publiclyVisible);
  const filtered =
    conditions.source === 'all' ? visible : visible.filter((row) => row.source_kind === conditions.source);

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(conditions.page, totalPages);
  const items = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // 两种空状态分开：列表整体为空 vs 只是这个来源没有。
  const emptyKind: 'none' | 'all-empty' | 'filtered-empty' =
    total > 0 ? 'none' : visible.length === 0 ? 'all-empty' : 'filtered-empty';

  return (
    <div>
      <h1>评测</h1>

      {/* 与插件目录同一套版式：左侧筛选栏 + 右侧结果与分页 */}
      <div className="catalog-layout">
        <aside className="panel" aria-label="来源筛选">
          <p className="side-title">来源</p>
          <nav className="side-nav">
            <Link href={listHref('all')} className={conditions.source === 'all' ? 'active' : ''}>
              <span>全部</span>
            </Link>
            <Link href={listHref('site')} className={conditions.source === 'site' ? 'active' : ''}>
              <span>站点评测</span>
            </Link>
            <Link href={listHref('community')} className={conditions.source === 'community' ? 'active' : ''}>
              <span>社区评测</span>
            </Link>
          </nav>
        </aside>

        <section>
          <div className="panel">
            <p className="muted" style={{ marginTop: 0 }}>
              {/* 只留"多少篇文章"；"评测与插件分开看待：收录不等于已实测可用。"按主人要求删掉 */}
              共 {total} 篇公开评测
              {conditions.source !== 'all' ? `（已筛选，全部公开评测 ${visible.length} 篇）` : ''}
              {totalPages > 1 ? ` · 第 ${page} / ${totalPages} 页` : ''}
            </p>

            {emptyKind === 'all-empty' ? (
              <p className="empty" style={{ marginBottom: 0 }}>
                暂无公开评测。可以先到 <Link href="/plugins">插件目录</Link> 选一个插件，从它的详情页写第一篇。
              </p>
            ) : null}

            {emptyKind === 'filtered-empty' ? (
              <p className="empty" style={{ marginBottom: 0 }}>
                该来源暂时没有公开评测（全部公开评测共 {visible.length} 篇）。
                <Link href="/reviews">清除筛选</Link>。
              </p>
            ) : null}

            {items.length > 0 ? (
              <>
                <ul className="item-list">
                  {items.map((r) => {
                    const label = pluginLabel(r);
                    return (
                      <li key={r.review_id} className="item item-clickable">
                        <div className="item-body">
                          {/*
                            两列：左边来源标签，右边"标题 + 元信息"。
                            这样元信息与**标题同列**（主人要求），而不是顶到标签下面另起一列。
                          */}
                          <div className="item-head">
                            <span className={r.source_kind === 'site' ? 'tag site' : 'tag'}>
                              {r.source_kind === 'site' ? '站点评测' : '社区评测'}
                            </span>
                            <div className="item-main">
                              <h3 className="item-title">
                                <Link href={`/reviews/${r.review_id}`}>{r.title}</Link>
                              </h3>
                              <div className="list-meta">
                                {label === null ? (
                                  <span>插件信息不可用</span>
                                ) : (
                                  <Link href={`/plugins/${r.plugin_id}`} className="truncate">
                                    {label}
                                  </Link>
                                )}
                                <span>{r.author_nickname}</span>
                                <span>{formatDateTimeOr(r.public_updated_at, '时间未知')}</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>

                {totalPages > 1 ? (
                  <div className="pagination">
                    {page > 1 ? (
                      <Link href={listHref(conditions.source, page - 1)} className="button">
                        ← 上一页
                      </Link>
                    ) : (
                      <span className="button" aria-disabled="true">
                        ← 上一页
                      </span>
                    )}
                    <span className="page-now">
                      {page} / {totalPages}
                    </span>
                    {page < totalPages ? (
                      <Link href={listHref(conditions.source, page + 1)} className="button">
                        下一页 →
                      </Link>
                    ) : (
                      <span className="button" aria-disabled="true">
                        下一页 →
                      </span>
                    )}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}