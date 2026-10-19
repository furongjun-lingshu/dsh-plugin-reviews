/**
 * 插件详情：插件资料与本站评测同页可达。
 *
 *  - 顶部摘要：图标 + 名称 + 作者 + 用途标签 + 归档/上游状态 + 简介；
 *  - 桌面分两栏：主栏放本插件评测，辅栏放资料来源；
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { createCatalogService } from '@/server/modules/catalog';
import { resolveVisibilityInTx } from '@/server/modules/content';
import { currentContext } from '@/app/api/_lib/context';
import { BackLink } from '@/components/back-link';
import { StartDraftButton } from '@/components/start-draft-button';
import { repositoryAvailabilityLabels } from '@/packages/common/status-text';
import { formatDateTimeOr } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

export default async function PluginDetailPage({ params }: { params: Promise<{ pluginId: string }> }) {
  const { pluginId } = await params;
  const db = getDb();
  const catalog = createCatalogService({ db });
  const plugin = await catalog.getPlugin(pluginId);
  if (!plugin) notFound();

  const ctx = await currentContext();

  // 本插件下的公开评测
  const rows = db
    .prepare(
      `SELECT r.id AS review_id, rev.title, ce.public_updated_at
         FROM reviews r
         JOIN content_entities ce ON ce.id = r.id
         JOIN review_revisions rev ON rev.id = r.published_revision_id
        WHERE r.plugin_id = ?
        ORDER BY ce.public_updated_at DESC, r.id ASC`,
    )
    .all(pluginId) as { review_id: string; title: string; public_updated_at: number | null }[];
  const reviews = rows.filter((row) => resolveVisibilityInTx(db, row.review_id).publiclyVisible);

  const displayName = plugin.displayName ?? plugin.repository.fullName;
  const initial = displayName.slice(0, 1).toUpperCase();
  const availability = repositoryAvailabilityLabels[plugin.repository.availabilityState];
  const author = plugin.authorLogin ?? plugin.ownerLogin ?? '未知';

  return (
    <div>
      <BackLink href="/plugins">返回插件目录</BackLink>

      {/* 顶部摘要 */}
      <header className="plugin-summary">
        <span className="icon icon-lg" aria-hidden="true">
          {plugin.ownerAvatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={plugin.ownerAvatarUrl} alt="" width={56} height={56} />
          ) : (
            initial
          )}
        </span>

        <div style={{ minWidth: 0 }}>
          <h1 className="plugin-title">{displayName}</h1>

          {/* 元信息只留作者 + 用途分类（+ 归档警示） */}
          <div className="plugin-meta">
            <span>作者 {author}</span>
            {(plugin.topics.length > 0 ? plugin.topics : ['未分类']).map((t) => (
              <span key={t} className="tag site">
                {t}
              </span>
            ))}
            {plugin.repository.isArchived ? <span className="tag warn">已归档</span> : null}
          </div>

          <p className="plugin-desc">{plugin.description ?? '暂无简介'}</p>
        </div>
      </header>

      <div className="twocol read-layout">
        {/* 主栏：本插件评测 */}
        <section>
          <div className="panel">
            <div className="section-head">
              <h2>本站评测（{reviews.length}）</h2>
              {/*
                从插件页写评测必须带上 pluginId：提交时会校验插件绑定，
                不带插件的草稿永远提交不出去。
              */}
              {ctx.userId === null ? null : <StartDraftButton pluginId={plugin.pluginId} />}
            </div>

            {ctx.userId === null ? (
              <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
                登录后可以在这里写评测。
              </p>
            ) : null}

            {reviews.length === 0 ? (
              <p className="empty" style={{ marginBottom: 0 }}>
                暂无评测。
              </p>
            ) : (
              <ul className="item-list">
                {reviews.map((r) => (
                  <li key={r.review_id} className="item item-clickable">
                    <div className="item-body">
                      <h3>
                        <Link href={`/reviews/${r.review_id}`}>{r.title}</Link>
                      </h3>
                      <div className="list-meta">
                        <span>{formatDateTimeOr(r.public_updated_at, '时间未知')}</span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* 辅栏：资料来源 */}
        <aside>
          <div className="panel">
            <div className="section-head">
              <h2>资料来源</h2>
            </div>
            <dl className="facts">
              <dt>仓库</dt>
              <dd>
                <a href={plugin.repository.htmlUrl}>{plugin.repository.fullName}</a>
              </dd>
              <dt>子路径</dt>
              <dd>
                <code>{plugin.pluginPath}</code>
              </dd>
              <dt>上游状态</dt>
              <dd>
                {availability}
                {plugin.repository.isArchived ? ' · 已归档' : ''}
              </dd>
              <dt>清单版本</dt>
              <dd>{plugin.manifestVersion ?? '未知'}</dd>
              {/* 两个时间语义不同：本站何时拉的资料 vs 上游仓库何时动的 */}
              <dt>资料同步</dt>
              <dd>{formatDateTimeOr(plugin.infoUpdatedAt ?? plugin.updatedAt, '未知')}</dd>
              <dt>仓库更新</dt>
              <dd>{formatDateTimeOr(plugin.repoUpdatedAt, '未知')}</dd>
            </dl>
            {plugin.repository.availabilityState !== 'available' ? (
              <p className="muted" style={{ margin: '12px 0 0', fontSize: 12 }}>
                上游当前不可访问，以上是最后一次成功同步的资料。
              </p>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  );
}