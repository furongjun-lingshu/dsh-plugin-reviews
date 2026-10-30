/**
 * 给草稿「选择所对应的插件」（可搜索、可更换）。
 *
 * 为什么需要这一页：插件关联此前只能在**创建草稿时**指定一次。批量导入 / 从「我的评测」
 * 新建的草稿因此永远绑不上插件，作者只能把正文复制到插件页新建的草稿里重来一遍。
 * 这里把「选插件」变成草稿内的一步操作，选完回到编辑器继续写。
 *
 * 搜索只按关键词（复用插件目录的检索），不分分类/排序：选插件时人是「我知道它叫什么」，
 * 不是「我要浏览」。分页保留关键词。
 */

import Link from 'next/link';
import { SearchGoButton } from '@/components/search-go-button';
import { notFound } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { currentContext } from '@/app/api/_lib/context';
import { reviewsService } from '@/server/modules/reviews';
import { createCatalogService } from '@/server/modules/catalog';
import { PluginPickButton } from '@/components/plugin-pick-button';
import { BackLink } from '@/components/back-link';
import { DomainError, ErrorCodes } from '@/packages/common/errors';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 10;

function firstValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function ChoosePluginPage({
  params,
  searchParams,
}: {
  params: Promise<{ draftId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { draftId } = await params;
  const sp = await searchParams;
  const q = (firstValue(sp.q) ?? '').trim().slice(0, 100);
  const rawPage = Number.parseInt(firstValue(sp.page) ?? '1', 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  const ctx = await currentContext();
  if (ctx.userId === null) {
    return (
      <div>
        <BackLink href="/me">返回我的评测</BackLink>
        <h1 style={{ fontSize: 22 }}>需要登录</h1>
        <p className="muted">选择对应插件需要登录。请使用页面顶部的登录入口。</p>
      </div>
    );
  }

  const db = getDb();
  let draft;
  try {
    draft = await reviewsService.getDraft(ctx, draftId, db);
  } catch (e) {
    // 不存在 / 不是自己的草稿：统一按 404 处理，不区分（越权探测不该拿到额外信息）。
    if (e instanceof DomainError && (e.code === ErrorCodes.TARGET_UNAVAILABLE || e.code === ErrorCodes.FORBIDDEN)) {
      notFound();
    }
    throw e;
  }

  const catalog = createCatalogService({ db });
  const result = await catalog.listPlugins({ page, page_size: PAGE_SIZE, q, sort: 'info', dir: 'desc' });

  const pageHref = (target: number): string => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (target > 1) params.set('page', String(target));
    const qs = params.toString();
    return `/me/drafts/${draftId}/choose-plugin${qs ? `?${qs}` : ''}`;
  };

  return (
    <div>
      <BackLink href={`/me/drafts/${draftId}`}>返回草稿</BackLink>
      <h1>选择所对应的插件</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        {draft.pluginLabel
          ? `当前对应：${draft.pluginLabel}。换一个插件会替换这条关联（草稿内容不受影响）。`
          : '这篇草稿还没有对应的插件；提交审核前必须选一个。'}
      </p>

      <form action={`/me/drafts/${draftId}/choose-plugin`} method="get" className="search" style={{ marginTop: 12 }}>
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="插件名 / 仓库名 / 描述"
          aria-label="搜索插件"
          maxLength={100}
        />
        <SearchGoButton label="搜索插件" />
        {q ? (
          <Link href={`/me/drafts/${draftId}/choose-plugin`} className="link-btn">
            清除
          </Link>
        ) : null}
      </form>

      <p className="muted">
        共 {result.total} 个插件
        {q ? `（关键词：${q}）` : ''}
      </p>

      {result.items.length === 0 ? (
        <p className="empty">
          {q ? '没有匹配的插件，换个关键词试试。' : '插件目录还没有收录任何插件。'}
        </p>
      ) : (
        <ul className="item-list">
          {result.items.map((plugin) => {
            const label = `${plugin.repositoryFullName}${plugin.pluginPath === '.' ? '' : ` / ${plugin.pluginPath}`}`;
            const title = plugin.displayName ?? label;
            const isCurrent = plugin.pluginId === draft.pluginId;
            return (
              <li key={plugin.pluginId} className="item">
                <div className="item-body">
                  <h3 className="item-title">{title}</h3>
                  <div className="list-meta">
                    <span>{label}</span>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <PluginPickButton
                      draftId={draftId}
                      pluginId={plugin.pluginId}
                      label={title}
                      isCurrent={isCurrent}
                    />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {result.total_pages > 1 ? (
        <div className="pagination">
          {page > 1 ? (
            <Link href={pageHref(page - 1)} className="button">
              ← 上一页
            </Link>
          ) : null}
          <span className="muted">
            第 {result.page} / {result.total_pages} 页
          </span>
          {page < result.total_pages ? (
            <Link href={pageHref(page + 1)} className="button">
              下一页 →
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
