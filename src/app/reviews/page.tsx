/**
 * 全站评测列表（`idea.md §22`）：关键词搜索 + 来源筛选 + 用途分类筛选 + 分页。
 *
 * 检索走 `modules/search`（混合检索，原因见迁移 0014）：
 *   * ≥3 字符 → FTS5 trigram + bm25 相关度；
 *   * 1–2 字符 → LIKE 子串回退（中文两字词太常见）。
 *
 * 两条纪律保持不变：
 *  1. **条件留在 URL**（可分享、可返回）；
 *  2. **两种空状态文案必须不同**（列表真的为空 vs 筛选没匹配到）。
 */

import Link from 'next/link';
import { getDb } from '@/server/platform/db';
import { createSearchService, type SearchSource, type ReviewSearchRow } from '@/server/modules/search';
import { createCatalogService, UNCATEGORIZED_CATEGORY } from '@/server/modules/catalog';
import { createPackReviewsService } from '@/server/modules/pack-reviews';
import { currentContext } from '@/app/api/_lib/context';
import { PageJump } from '@/components/page-jump';
import { isPageOutOfRange } from '@/packages/common/pagination';
import type { VersionValue } from '@/packages/common/field-rules';
import { formatDateTimeOr } from '@/packages/common/time';

const PAGE_SIZE = 20;

interface Conditions {
  q: string;
  source: SearchSource;
  cat: string;
  page: number;
}

function firstValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function readConditions(sp: Record<string, string | string[] | undefined>): Conditions {
  const rawSource = firstValue(sp.source);
  const rawPage = Number.parseInt(firstValue(sp.page) ?? '1', 10);
  return {
    // 关键词截断到 100 字：搜索框不是注入口
    q: (firstValue(sp.q) ?? '').trim().slice(0, 100),
    source: rawSource === 'site' || rawSource === 'community' ? rawSource : 'all',
    cat: (firstValue(sp.cat) ?? '').trim().slice(0, 40),
    page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1,
  };
}

/** 生成链接：只带"非默认"条件，改条件回第一页。 */
function listHref(current: Conditions, over: Partial<Conditions> = {}): string {
  const merged = { ...current, page: 1, ...over };
  const params = new URLSearchParams();
  if (merged.q) params.set('q', merged.q);
  if (merged.source !== 'all') params.set('source', merged.source);
  if (merged.cat) params.set('cat', merged.cat);
  if (over.page !== undefined && over.page > 1) params.set('page', String(over.page));
  const qs = params.toString();
  return qs.length > 0 ? `/reviews?${qs}` : '/reviews';
}

/** 页码跳转模板：保留当前搜索/筛选条件，`__PAGE__` 由客户端替换。 */
function pageHrefTemplate(current: Conditions): string {
  const params = new URLSearchParams();
  if (current.q) params.set('q', current.q);
  if (current.source !== 'all') params.set('source', current.source);
  if (current.cat) params.set('cat', current.cat);
  params.set('page', '__PAGE__');
  return `/reviews?${params.toString()}`;
}

/** 与首页同一口径：清单名优先，缺则仓库全名；子目录形态带上子路径。 */
function pluginLabel(row: ReviewSearchRow): string | null {
  if (row.repo_full_name === null) return null;
  const base = row.plugin_display_name ?? row.repo_full_name;
  const subPath = row.plugin_path && row.plugin_path !== '.' ? ` / ${row.plugin_path}` : '';
  return `${base}${subPath}`;
}

/** 版本字段是 JSON 文本；坏数据按"未知"处理，绝不抛错（详情页用同一套 formatVersionLabel）。 */
function parseVersion(raw: string): VersionValue {
  try {
    const parsed = JSON.parse(raw) as VersionValue;
    return parsed && typeof parsed === 'object' ? parsed : { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}

/**
 * 列表只用版本号本身：库里有些值是 "0.9.3 (commit 81b47af…, tag v0.9.3)" 这种长文本，
 * 在手机一行里会把「插件名」挤没、甚至撑破卡片。详情页仍显示完整值。
 */
function compactVersionLabel(version: VersionValue): string {
  if (version.kind !== 'known') return '插件 未知';
  const short = version.value.split(/\s*\(/)[0].trim();
  return `插件 ${short || version.value}`;
}

export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const tab = firstValue(sp.tab) === 'packs' ? 'packs' : 'plugins';
  const db = getDb();

  if (tab === 'packs') {
    const q = (firstValue(sp.q) ?? '').trim().slice(0, 100);
    const ctx = await currentContext();
    const packReviews = await createPackReviewsService({ db }).listPackReviews(ctx, q);
    return (
      <div>
        <h1>评测</h1>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          <Link href="/reviews" className="button">插件测评</Link>
          <Link href="/reviews?tab=packs" className="button primary">整合包测评</Link>
        </div>
        <form action="/reviews" method="get" className="search" style={{ marginBottom: 12 }}>
          <input type="hidden" name="tab" value="packs" />
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="搜整合包测评标题"
            aria-label="搜整合包测评标题"
            maxLength={100}
          />
          <button type="submit" className="search-go">搜索</button>
        </form>
        <section className="panel">
          <div className="section-head">
            <h2>整合包测评（{packReviews.length}）</h2>
          </div>
          {packReviews.length === 0 ? (
            <p className="empty" style={{ marginBottom: 0 }}>
              {q ? `没有匹配「${q}」的整合包测评。` : '还没有整合包测评。可以去整合包详情页写第一篇。'}
            </p>
          ) : (
            <ul className="item-list">
              {packReviews.map((r) => (
                <li key={r.reviewId} className="item">
                  <div className="item-body">
                    <h3>
                      <Link href={`/reviews/${r.reviewId}`} prefetch={false}>{r.title}</Link>
                    </h3>
                    <div className="list-meta">
                      <Link href={`/packs/${r.packId}${r.releaseNumber ? `?v=${r.releaseNumber}` : ''}`}>
                        {r.packTitle}
                        {r.releaseNumber ? ` · 第 ${r.releaseNumber} 版` : ''}
                      </Link>
                      <span>{r.authorNickname ?? r.authorId}</span>
                      <span>{formatDateTimeOr(r.createdAt, '时间未知')}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    );
  }

  const conditions = readConditions(sp);

  const search = createSearchService({ db });
  const result = await search.searchReviews({
    q: conditions.q || undefined,
    source: conditions.source,
    category: conditions.cat || undefined,
    page: conditions.page,
    page_size: PAGE_SIZE,
  });

  const categories = await createCatalogService({ db }).listCategories();
  const total = result.total;
  const page = result.page;
  const totalPages = result.total_pages;
  const items = result.items;
  const outOfRange = isPageOutOfRange(page, totalPages);
  const hasFilters = conditions.q !== '' || conditions.cat !== '' || conditions.source !== 'all';

  // 两种空状态分开：真的没有公开评测 vs 有评测但筛选/搜索没命中
  const emptyKind: 'none' | 'all-empty' | 'filtered-empty' = total > 0 ? 'none' : hasFilters ? 'filtered-empty' : 'all-empty';

  // 搜索框放两处：桌面端在右栏评测列表上方，手机端仍在筛选栏最上面；
  // 同一份表单，靠 CSS 断点只显示一个，避免两套输入逻辑走偏。
  const searchForm = (className: string) => (
    <form action="/reviews" method="get" className={`search ${className}`} style={{ marginBottom: 12 }}>
      <input
        type="search"
        name="q"
        defaultValue={conditions.q}
        placeholder="搜标题、正文或插件名"
        aria-label="搜索评测"
        maxLength={100}
      />
      {conditions.source !== 'all' ? <input type="hidden" name="source" value={conditions.source} /> : null}
      {conditions.cat ? <input type="hidden" name="cat" value={conditions.cat} /> : null}
      <button type="submit" className="search-go" aria-label="搜索">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <line x1="16.5" y1="16.5" x2="21" y2="21" />
        </svg>
      </button>
    </form>
  );

  return (
    <div>
      <h1>评测</h1>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        <Link href="/reviews" className="button primary">插件测评</Link>
        <Link href="/reviews?tab=packs" className="button">整合包测评</Link>
      </div>

      <div className="catalog-layout">
        <aside className="panel" aria-label="筛选">
          {/* 手机端：搜索留在筛选栏最上面（桌面端隐藏，见右栏顶部那份） */}
          {searchForm('reviews-search-aside')}

          <p className="side-title">来源</p>
          <nav className="side-nav">
            <Link href={listHref(conditions, { source: 'all' })} className={conditions.source === 'all' ? 'active' : ''} prefetch={false}>
              <span>全部</span>
            </Link>
            <Link href={listHref(conditions, { source: 'site' })} className={conditions.source === 'site' ? 'active' : ''} prefetch={false}>
              <span>站点评测</span>
            </Link>
            <Link
              href={listHref(conditions, { source: 'community' })}
              className={conditions.source === 'community' ? 'active' : ''}
              prefetch={false}
            >
              <span>社区评测</span>
            </Link>
          </nav>

          {/* 用途分类：与插件目录同一套分类数据（迁移 0010） */}
          {categories.length > 0 ? (
            <>
              <p className="side-title" style={{ marginTop: 16 }}>
                用途分类
              </p>
              <nav className="side-nav">
                <Link href={listHref(conditions, { cat: '' })} className={conditions.cat === '' ? 'active' : ''} prefetch={false}>
                  <span>全部</span>
                </Link>
                {categories.map((c) => (
                  <Link
                    key={c.slug}
                    href={listHref(conditions, { cat: c.slug })}
                    className={conditions.cat === c.slug ? 'active' : ''}
                    prefetch={false}
                    title={c.slug === UNCATEGORIZED_CATEGORY ? '没有命中任何分类的插件' : `覆盖 ${c.repositoryCount} 个仓库`}
                  >
                    <span className="truncate">{c.label}</span>
                    <span className="count">{c.repositoryCount}</span>
                  </Link>
                ))}
              </nav>
            </>
          ) : null}
        </aside>

        <section>
          <div className="panel">
            {/* 桌面端：搜索条在评测列表上方（手机端用筛选栏里那份） */}
            {searchForm('reviews-search-main')}

            <p className="muted" style={{ marginTop: 0 }}>
              共 {total} 篇公开评测
              {conditions.q ? `（搜索：${conditions.q}）` : ''}
              {totalPages > 1 ? ` · 第 ${page} / ${totalPages} 页` : ''}
            </p>

            {outOfRange ? (
              <div className="panel" style={{ marginTop: 12 }}>
                <p className="empty" style={{ marginBottom: 0 }}>
                  您输入的页面不存在（共 {totalPages} 页）。
                </p>
                <p style={{ margin: '8px 0 0' }}>
                  <Link href={listHref(conditions, { page: 1 })}>回到第 1 页</Link>
                </p>
              </div>
            ) : null}

            {emptyKind === 'all-empty' ? (
              <p className="empty" style={{ marginBottom: 0 }}>
                暂无公开评测。可以先到 <Link href="/plugins">插件目录</Link> 选一个插件，从它的详情页写第一篇。
              </p>
            ) : null}

            {emptyKind === 'filtered-empty' ? (
              <p className="empty" style={{ marginBottom: 0 }}>
                没有匹配的公开评测（换个关键词，或<Link href="/reviews">清除筛选</Link>）。
              </p>
            ) : null}

            {items.length > 0 ? (
              <>
                <ul className="item-list">
                  {items.map((r) => {
                    const label = pluginLabel(r);
                    const version = parseVersion(r.plugin_version);
                    return (
                      <li key={r.review_id} className="item">
                        <div className="item-body">
                          <div className="item-head">
                            <span className={r.source_kind === 'site' ? 'tag site' : 'tag'}>
                              {r.source_kind === 'site' ? '站点评测' : '社区评测'}
                            </span>
                            <div className="item-main">
                              <h3 className="item-title">
                                <Link href={`/reviews/${r.review_id}`} prefetch={false}>{r.title}</Link>
                              </h3>
                              {/*
                                封面缩略图：只有作者设置了封面才显示。没有封面就什么都不放——
                                列表里堆一串通用占位图，比没有图更吵。
                              */}
                              {r.cover_url ? (
                                <Link href={`/reviews/${r.review_id}`} style={{ display: 'block', margin: '6px 0' }} prefetch={false}>
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={r.cover_url}
                                    alt={`${r.title} 的封面`}
                                    loading="lazy"
                                    decoding="async"
                                    style={{
                                      width: '100%',
                                      maxWidth: 320,
                                      height: 140,
                                      objectFit: 'cover',
                                      borderRadius: 8,
                                      display: 'block',
                                    }}
                                  />
                                </Link>
                              ) : null}
                              <div className="list-meta">
                                {label === null ? (
                                  <span>插件信息不可用</span>
                                ) : (
                                  <Link href={`/plugins/${r.plugin_id}`} className="truncate" prefetch={false}>
                                    {label}
                                  </Link>
                                )}
                                {/* §22：每条显示"被测版本"（列表里只显示版本号，完整 commit/tag 放 title） */}
                                <span title={version.kind === 'known' ? `插件 ${version.value}` : '插件 未知'}>
                                  {compactVersionLabel(version)}
                                </span>
                                <span className="review-author">{r.author_nickname}</span>
                                <span className="review-date">{formatDateTimeOr(r.public_updated_at, '时间未知')}</span>
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
                      <Link href={listHref(conditions, { page: page - 1 })} className="button">
                        ← 上一页
                      </Link>
                    ) : (
                      <span className="button" aria-disabled="true">
                        ← 上一页
                      </span>
                    )}
                    <PageJump page={page} totalPages={totalPages} hrefTemplate={pageHrefTemplate(conditions)} />
                    {page < totalPages ? (
                      <Link href={listHref(conditions, { page: page + 1 })} className="button">
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
