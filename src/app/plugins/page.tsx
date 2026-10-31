/**
 * 插件目录：搜索 / 筛选 / 排序 / 分页。
 *
 * 三条纪律：
 *  1. 条件全部保留在 URL，改条件时回第一页；
 *  2. 分页与筛选在服务端完成（真实总数）；
 *  3. 两种空状态文案必须不同：目录真的为空 vs 筛选没匹配到（后者给"清除条件"）。
 */

import Link from 'next/link';
import { getDb } from '@/server/platform/db';
import { createCatalogService } from '@/server/modules/catalog';
import { UNCATEGORIZED_CATEGORY } from '@/server/modules/catalog/service';
import { formatDateTimeOr } from '@/packages/common/time';
import { tierLabel, securityLabel } from '@/packages/common/assessment';
import { isPageOutOfRange } from '@/packages/common/pagination';
import type { PluginSummary } from '@/server/modules/catalog/types';
import { PageJump } from '@/components/page-jump';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 12;

interface DirectoryConditions {
  q?: string;
  /** 分类筛选（迁移 0010，页面 chip 行用）：分类 slug 或 __none__。 */
  cat?: string;
  /** 原始 GitHub topic 精确筛选（旧链接兼容；页面不再生成这类链接）。 */
  tag?: string;
  hasReviews: 'all' | 'yes' | 'no';
  assessment: 'all' | 'quick' | 'standard';
  security: 'all' | 'yes' | 'no';
  sort: 'info' | 'reviews';
  dir: 'asc' | 'desc';
  page: number;
}

function firstValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** URL 条件 → 结构化条件（**所有非法值都退回默认**，不让 URL 把页面搞崩）。 */
function readConditions(sp: Record<string, string | string[] | undefined>): DirectoryConditions {
  const rawPage = Number.parseInt(firstValue(sp.page) ?? '1', 10);
  const hasReviewsRaw = firstValue(sp.has_reviews);
  const assessmentRaw = firstValue(sp.assessment);
  const securityRaw = firstValue(sp.security);
  const dirRaw = firstValue(sp.dir);
  // 兼容旧链接：assessment=security 映射到独立的「安全 = 已安全审计」。
  const legacySecurity = assessmentRaw === 'security';
  return {
    // 关键词截断到 100 字：搜索框不是注入口
    q: firstValue(sp.q)?.trim().slice(0, 100) || undefined,
    cat: firstValue(sp.cat)?.slice(0, 40) || undefined,
    tag: firstValue(sp.tag)?.slice(0, 64) || undefined,
    hasReviews: hasReviewsRaw === 'yes' || hasReviewsRaw === 'no' ? hasReviewsRaw : 'all',
    assessment:
      assessmentRaw === 'quick' || assessmentRaw === 'standard' ? assessmentRaw : 'all',
    security: legacySecurity
      ? 'yes'
      : securityRaw === 'yes' || securityRaw === 'no'
        ? securityRaw
        : 'all',
    sort: firstValue(sp.sort) === 'reviews' ? 'reviews' : 'info',
    dir: dirRaw === 'asc' ? 'asc' : 'desc',
    page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1,
  };
}

/** 生成目录链接：只带上"非默认"的条件，并**永远丢掉 page**（改条件回第一页）。 */
function listHref(current: DirectoryConditions, over: Partial<DirectoryConditions> = {}): string {
  const merged = { ...current, page: undefined, ...over } as DirectoryConditions & { page?: number };
  const params = new URLSearchParams();
  if (merged.q) params.set('q', merged.q);
  if (merged.cat) params.set('cat', merged.cat);
  if (merged.tag) params.set('tag', merged.tag);
  if (merged.hasReviews !== 'all') params.set('has_reviews', merged.hasReviews);
  if (merged.assessment !== 'all') params.set('assessment', merged.assessment);
  if (merged.security !== 'all') params.set('security', merged.security);
  if (merged.sort !== 'info') params.set('sort', merged.sort);
  if (merged.dir !== 'desc') params.set('dir', merged.dir);
  if (over.page !== undefined && over.page > 1) params.set('page', String(over.page));
  const qs = params.toString();
  return qs.length > 0 ? `/plugins?${qs}` : '/plugins';
}

/** 页码跳转模板：保留当前筛选/排序条件（含 PR #23 的 assessment），`__PAGE__` 由客户端替换。 */
function pageHrefTemplate(current: DirectoryConditions): string {
  const params = new URLSearchParams();
  if (current.q) params.set('q', current.q);
  if (current.cat) params.set('cat', current.cat);
  if (current.tag) params.set('tag', current.tag);
  if (current.hasReviews !== 'all') params.set('has_reviews', current.hasReviews);
  if (current.assessment !== 'all') params.set('assessment', current.assessment);
  if (current.security !== 'all') params.set('security', current.security);
  if (current.sort !== 'info') params.set('sort', current.sort);
  if (current.dir !== 'desc') params.set('dir', current.dir);
  params.set('page', '__PAGE__');
  return `/plugins?${params.toString()}`;
}

/** 卡片上的一行小标签（用途标签 / 状态）。颜色语义在 globals.css 的 .tag 家族里。 */
function Chip({ text, tone = 'plain' }: { text: string; tone?: 'plain' | 'tag' | 'warn' }) {
  const cls = tone === 'tag' ? 'tag site' : tone === 'warn' ? 'tag warn' : 'tag';
  return <span className={cls}>{text}</span>;
}

function PluginCard({ plugin }: { plugin: PluginSummary }) {
  const label = `${plugin.repositoryFullName}${plugin.pluginPath === '.' ? '' : ` / ${plugin.pluginPath}`}`;
  const title = plugin.displayName ?? label;
  const initial = (plugin.displayName ?? plugin.repositoryFullName).slice(0, 1).toUpperCase();

  return (
    <li className="item">
      {/* 图标：有 owner 头像就用（外链，不代理），否则用首字母方块兜底 */}
      <span className="icon">
        {plugin.ownerAvatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={plugin.ownerAvatarUrl} alt="" width={42} height={42} loading="lazy" decoding="async" />
        ) : (
          initial
        )}
      </span>

      <div className="item-body">
        <h3 className="truncate">
          <Link href={`/plugins/${plugin.pluginId}`} prefetch={false}>{title}</Link>
          {plugin.displayName ? <span className="muted"> · {label}</span> : null}
        </h3>

        {/* 简介：没有就明说"暂无简介"，不留空行让人以为加载失败 */}
        <p className="clamp-2">{plugin.description ?? '暂无简介'}</p>

        <div>
          {plugin.categories.length > 0 ? (
            // 分类（中文、按不同仓库计数）优先；原始 topics 只在详情页展示，避免噪声上卡片
            plugin.categories.slice(0, 6).map((c) => <Chip key={c} text={c} tone="tag" />)
          ) : plugin.topics.length > 0 ? (
            plugin.topics.slice(0, 3).map((t) => <Chip key={t} text={t} />)
          ) : (
            <Chip text="未分类" />
          )}
          {plugin.publicReviewCount > 0 ? (
            <Chip text={`${plugin.publicReviewCount} 篇公开评测`} />
          ) : (
            <Chip text="暂无评测" />
          )}
          <Chip text={tierLabel(plugin.assessmentTier)} />
          <Chip text={securityLabel(plugin.securityAudit)} tone={plugin.securityAudit === true ? 'tag' : 'plain'} />
          {plugin.isArchived ? <Chip text="已归档" tone="warn" /> : null}
          {plugin.availabilityState !== 'available' ? <Chip text="仓库暂不可访问" tone="warn" /> : null}
        </div>

        <div className="list-meta plugin-card-meta" style={{ marginTop: 6 }}>
          <span>作者 {plugin.authorLogin ?? plugin.ownerLogin ?? '未知'}</span>
          <span>资料更新 {formatDateTimeOr(plugin.infoUpdatedAt ?? plugin.updatedAt, '未知')}</span>
          <span>仓库更新 {formatDateTimeOr(plugin.repoUpdatedAt, '未知')}</span>
        </div>
      </div>
    </li>
  );
}

export default async function PluginsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const conditions = readConditions(await searchParams);
  const catalog = createCatalogService({ db: getDb() });

  const result = await catalog.listPlugins({
    page: conditions.page,
    page_size: PAGE_SIZE,
    q: conditions.q,
    category: conditions.cat,
    tag: conditions.tag,
    hasReviews: conditions.hasReviews,
    assessment: conditions.assessment,
    security: conditions.security,
    sort: conditions.sort,
    dir: conditions.dir,
  });
  // 侧栏 chip 用分类（中文、按不同仓库计数）
  const categories = await catalog.listCategories();

  // 空结果时再问一次"不带条件时有多少" —— 这样能把"目录为空"与"筛选没匹配到"分开。
  const totalWithoutFilter =
    result.total === 0 ? (await catalog.listPlugins({ page: 1, page_size: 1 })).total : result.total;

  // 越界页（把 page=99 手打进 URL）：单独给"超出范围 + 回第 1 页"，
  // 不要再报"筛选没匹配到"—— 那样会让用户以为筛选条件把条目滤光了。
  const outOfRange = isPageOutOfRange(conditions.page, result.total_pages);

  const emptyKind: 'none' | 'directory-empty' | 'filtered-empty' =
    result.items.length > 0 || outOfRange
      ? 'none'
      : totalWithoutFilter === 0
        ? 'directory-empty'
        : 'filtered-empty';

  return (
    <div>
      <div className="section-head">
        <h1 style={{ margin: 0 }}>插件目录</h1>
        <Link href="/plugins/new" className="button primary">
          提交插件
        </Link>
      </div>

      <div className="catalog-layout">
        {/* 左栏：用途分类（迁移 0010；计数是**不同仓库数**，不是插件数） */}
        {categories.length > 0 ? (
          <aside className="panel" aria-label="用途分类">
            <p className="side-title">用途分类</p>
            <nav className="side-nav">
              <Link href={listHref(conditions, { cat: undefined })} className={conditions.cat ? '' : 'active'} prefetch={false}>
                <span>全部</span>
              </Link>
              {categories.map((c) => (
                <Link
                  key={c.slug}
                  href={listHref(conditions, { cat: c.slug })}
                  className={conditions.cat === c.slug ? 'active' : ''}
                  prefetch={false}
                  title={
                    c.slug === UNCATEGORIZED_CATEGORY
                      ? '没有命中任何分类的插件（去后台补映射）'
                      : `覆盖 ${c.repositoryCount} 个仓库 / ${c.pluginCount} 个插件`
                  }
                >
                  <span className="truncate">{c.label}</span>
                  <span className="count">{c.repositoryCount}</span>
                </Link>
              ))}
            </nav>
          </aside>
        ) : null}

        {/*
          结果区永远是这一个节点：把总数/页码以 **data-* 形式**留在 DOM 上，
          验收脚本据此核对"页面数与总数一致"，而页面上不再显示"共 N 个条目…"这行文字
          （主人要求删掉那行；机器可读的值不该靠界面文案承载）。
        */}
        <section
          data-total={result.total}
          data-page={result.page}
          data-total-pages={result.total_pages}
        >
          <div className="panel">
            {/* 搜索：GET 表单，条件留在 URL 里；筛选与排序用链接，避免 JS */}
            <form action="/plugins" method="get" className="search">
              <input
                type="search"
                name="q"
                defaultValue={conditions.q ?? ''}
                placeholder="搜插件名、作者仓库或简介"
                aria-label="搜索插件"
              />
              {conditions.tag ? <input type="hidden" name="tag" value={conditions.tag} /> : null}
              {conditions.hasReviews !== 'all' ? (
                <input type="hidden" name="has_reviews" value={conditions.hasReviews} />
              ) : null}
              {conditions.assessment !== 'all' ? (
                <input type="hidden" name="assessment" value={conditions.assessment} />
              ) : null}
              {conditions.security !== 'all' ? (
                <input type="hidden" name="security" value={conditions.security} />
              ) : null}
              {conditions.sort !== 'info' ? <input type="hidden" name="sort" value={conditions.sort} /> : null}
              {conditions.dir !== 'desc' ? <input type="hidden" name="dir" value={conditions.dir} /> : null}
              <button type="submit" className="search-go" aria-label="搜索">
                {/* 搜索动作简化成放大镜图标按钮（与首页同一形态），与输入框保持同一行 */}
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

            {/* 筛选 / 排序：都是链接，改条件回第一页（listHref 保证）。
                主人要求**拆成两组各自成行**：原来"评测:"标签与它的胶囊会被换行拆开，
                "排序:"标签孤零零留在上一行末尾（实测截图），很难读。 */}
            <div className="filters filter-groups" style={{ marginTop: 'var(--space-3)' }}>
              <div className="filter-group">
                <span className="group-label">评测：</span>
                {(['all', 'yes', 'no'] as const).map((v) => (
                  <Link
                    key={v}
                    href={listHref(conditions, { hasReviews: v })}
                    className={conditions.hasReviews === v ? 'active' : ''}
                    prefetch={false}
                  >
                    {v === 'all' ? '全部' : v === 'yes' ? '已有评测' : '暂无评测'}
                  </Link>
                ))}
              </div>
              <div className="filter-group">
                <span className="group-label">档位：</span>
                {(['all', 'quick', 'standard'] as const).map((v) => (
                  <Link
                    key={v}
                    href={listHref(conditions, { assessment: v })}
                    className={conditions.assessment === v ? 'active' : ''}
                    prefetch={false}
                  >
                    {v === 'all' ? '全部' : v === 'quick' ? '已快测' : '已标测'}
                  </Link>
                ))}
              </div>
              <div className="filter-group">
                <span className="group-label">安全：</span>
                {(['all', 'yes', 'no'] as const).map((v) => (
                  <Link
                    key={v}
                    href={listHref(conditions, { security: v })}
                    className={conditions.security === v ? 'active' : ''}
                    prefetch={false}
                  >
                    {v === 'all' ? '全部' : v === 'yes' ? '已安全审计' : '未安全审计'}
                  </Link>
                ))}
              </div>
              <div className="filter-group">
                <span className="group-label">排序：</span>
                {(['info', 'reviews'] as const).map((v) => (
                  <Link
                    key={v}
                    href={listHref(conditions, { sort: v })}
                    className={conditions.sort === v ? 'active' : ''}
                    prefetch={false}
                  >
                    {v === 'info' ? '按资料更新时间' : '按评测数'}
                  </Link>
                ))}
                <Link
                  href={listHref(conditions, { dir: 'asc' })}
                  className={conditions.dir === 'asc' ? 'active' : ''}
                  aria-label="按正序排序"
                  title="正序"
                  prefetch={false}
                >
                  ↑
                </Link>
                <Link
                  href={listHref(conditions, { dir: 'desc' })}
                  className={conditions.dir === 'desc' ? 'active' : ''}
                  aria-label="按逆序排序"
                  title="逆序"
                  prefetch={false}
                >
                  ↓
                </Link>
              </div>
            </div>

            {/* 原来这里有一行"共 N 个条目。收录 ≠ 已实测可用。"，按主人要求删除：
                条数改成上面的 data-total（验收脚本用）；"收录等于不等于已实测可用"这句
                仍由**插件提交页**（/plugins/new）承担，页脚也已删除。 */}
          </div>

          {outOfRange ? (
            <div className="panel" style={{ marginTop: 'var(--space-4)' }}>
              <p className="empty" style={{ marginBottom: 0 }}>
                您输入的页面不存在（共 {result.total_pages} 页）。
              </p>
              <p style={{ margin: '8px 0 0' }}>
                <Link href={listHref(conditions, { page: 1 })}>回到第 1 页</Link>
              </p>
            </div>
          ) : null}

          {emptyKind === 'directory-empty' ? (
            <div className="panel" style={{ marginTop: 'var(--space-4)' }}>
              <p className="empty" style={{ marginBottom: 0 }}>
                目录当前为空，还没有任何插件被收录。可以从 <Link href="/plugins/new">提交插件</Link> 开始。
              </p>
            </div>
          ) : null}

          {emptyKind === 'filtered-empty' ? (
            <div className="panel" style={{ marginTop: 'var(--space-4)' }}>
              <p className="empty" style={{ marginBottom: 0 }}>
                没有符合当前条件的条目（目录里共有 {totalWithoutFilter} 个）。
                <Link href="/plugins">清除全部条件</Link>。
              </p>
            </div>
          ) : null}

          {result.items.length > 0 ? (
            <div className="panel" style={{ marginTop: 'var(--space-4)' }}>
              <ul className="item-list">
                {result.items.map((p) => (
                  <PluginCard key={p.pluginId} plugin={p} />
                ))}
              </ul>

              {result.total_pages > 1 ? (
                <div className="pagination">
                  {conditions.page > 1 ? (
                    <Link href={listHref(conditions, { page: conditions.page - 1 })} className="button">
                      ← 上一页
                    </Link>
                  ) : (
                    <span className="button" aria-disabled="true">
                      ← 上一页
                    </span>
                  )}
                  <PageJump
                    page={conditions.page}
                    totalPages={result.total_pages}
                    hrefTemplate={pageHrefTemplate(conditions)}
                  />
                  {conditions.page < result.total_pages ? (
                    <Link href={listHref(conditions, { page: conditions.page + 1 })} className="button">
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
          ) : null}
        </section>
      </div>
    </div>
  );
}
