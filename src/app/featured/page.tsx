/**
 * 精选专栏列表（公开）。
 *
 * 每期一行：期号 + 标题 + 主题 + 发布时间 + 插件数。倒序、10 期/页。
 */

import Link from 'next/link';
import { getDb } from '@/server/platform/db';
import { createFeaturedService } from '@/server/modules/featured';
import { isPageOutOfRange } from '@/packages/common/pagination';
import { PageJump } from '@/components/page-jump';
import { formatDateTimeOr } from '@/packages/common/time';
import { createFeaturedSubscriptionService } from '@/server/modules/featured';
import { FeaturedSubscribeButton } from '@/components/featured-subscribe-button';
import { currentContext } from '@/app/api/_lib/context';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 10;

export default async function FeaturedListPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const sp = await searchParams;
  const rawPage = Number.parseInt(sp.page ?? '1', 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  const db = getDb();
  const ctx = await currentContext();
  const service = createFeaturedService({ db });
  const subscription = await createFeaturedSubscriptionService({ db }).getState(ctx, { withCount: true });
  const result = await service.listPublished({ page, pageSize: PAGE_SIZE });
  const outOfRange = isPageOutOfRange(page, result.total_pages);

  return (
    <div>
      {/* 标题右侧那句「编辑按主题挑选的插件专栏，每期一组」按主人要求删掉 */}
      <div className="section-head">
        <h1 style={{ margin: 0 }}>精选</h1>
      </div>

      <p style={{ marginTop: 8 }}>
        <FeaturedSubscribeButton
          initialSubscribed={subscription.subscribed}
          authenticated={ctx.userId !== null}
          subscriberCount={subscription.subscriberCount}
        />
      </p>

      {outOfRange ? (
        <p className="empty">
          您输入的页面不存在（共 {result.total_pages || 1} 页）。<Link href="/featured">回到第 1 页</Link>
        </p>
      ) : result.items.length === 0 ? (
        <p className="empty">还没有精选专栏。</p>
      ) : (
        <ul className="item-list">
          {result.items.map((issue) => (
            <li key={issue.issueNumber} className="item">
              <div className="item-body">
                <div className="item-head">
                  <span className="tag site">第 {issue.issueNumber} 期</span>
                  <div className="item-main">
                    <h3 className="item-title">
                      <Link href={'/featured/' + issue.issueNumber}>{issue.title}</Link>
                    </h3>
                    <p className="muted" style={{ margin: '4px 0' }}>
                      {issue.theme}
                    </p>
                    <div className="list-meta">
                      <span>{issue.itemCount} 个插件</span>
                      <span>发布于 {formatDateTimeOr(issue.publishedAt, '未知')}</span>
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
          {page > 1 ? (
            <Link href={'/featured?page=' + (page - 1)} className="button">
              ← 上一页
            </Link>
          ) : null}
          <PageJump page={page} totalPages={result.total_pages} hrefTemplate={'/featured?page=__PAGE__'} />
          {page < result.total_pages ? (
            <Link href={'/featured?page=' + (page + 1)} className="button">
              下一页 →
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
