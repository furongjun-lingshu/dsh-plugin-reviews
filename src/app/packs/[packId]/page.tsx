/**
 * 整合包详情（`idea.md` §26；`架构设计.md` §88.2）。
 *
 * 核心是「**安装资料**」：逐条命令 + 「复制全部」，未确认的条目标「待核实」且不生成命令。
 * 版本切换走 `?v=<序号>`；请求的版本不可公开时**如实显示状态**，不悄悄换成别的版本。
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { createPacksService } from '@/server/modules/packs';
import { numberSetting } from '@/server/modules/settings';
import { createPackReviewsService } from '@/server/modules/pack-reviews';
import { renderMarkdownToSafeHtml } from '@/server/platform/markdown';
import { formatVersionLabel } from '@/packages/common/status-text';
import { formatDateTimeOr } from '@/packages/common/time';
import { CopyButton } from '@/components/copy-button';
import { PackFavoriteButton } from '@/components/pack-favorite-button';
import { PackHelpfulButton } from '@/components/pack-helpful-button';
import { ReportButton } from '@/components/report-button';
import { CommentSection } from '@/components/comment-section';
import { BackLink } from '@/components/back-link';
import { currentContext } from '@/app/api/_lib/context';
import { DomainError } from '@/packages/common/errors';

export const dynamic = 'force-dynamic';

function first(sp: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const raw = sp[key];
  return Array.isArray(raw) ? raw[0] : raw;
}

export default async function PackDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ packId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { packId } = await params;
  const sp = await searchParams;
  const ctx = await currentContext();
  const vRaw = first(sp, 'v');
  const releaseNumber = vRaw === undefined ? undefined : Number.parseInt(vRaw, 10);

  let detail;
  try {
    detail = await createPacksService({ db: getDb() }).getPack(ctx, packId, {
      releaseNumber: releaseNumber !== undefined && Number.isFinite(releaseNumber) && releaseNumber > 0 ? releaseNumber : undefined,
    });
  } catch (e) {
    if (e instanceof DomainError && e.code === 'target_unavailable') notFound();
    throw e;
  }

  const selected = detail.selected;
  const packReviews = (await createPackReviewsService({ db: getDb() }).listPackReviews(ctx)).filter(
    (review) => review.packId === packId,
  );
  const packService = createPacksService({ db: getDb() });
  const helpful = selected
    ? await packService.helpfulStateForRelease(selected.releaseId, ctx.userId)
    : { helpful: false, count: 0 };
  const installChecks = new Map<number, { state: string; detail: string | null; completedAt: number | null }>();
  if (selected) {
    const checkRows = getDb()
      .prepare(
        `SELECT i.position, ic.state, ic.detail, ic.completed_at
           FROM plugin_install_checks ic
           JOIN plugin_pack_release_items i ON i.id = ic.release_item_id
          WHERE i.release_id = ?
            AND ic.check_sequence = (
              SELECT MAX(x.check_sequence) FROM plugin_install_checks x
               WHERE x.release_item_id = ic.release_item_id
            )`,
      )
      .all(selected.releaseId) as Array<{
        position: number;
        state: string;
        detail: string | null;
        completed_at: number | null;
      }>;
    for (const row of checkRows) {
      installChecks.set(row.position, {
        state: row.state,
        detail: row.detail,
        completedAt: row.completed_at,
      });
    }
  }
  const bodyHtml = selected ? renderMarkdownToSafeHtml(selected.bodyMarkdown) : '';
  // 核验有效期：过期的"已核验通过"不能继续冒充仍然有效，显示「待复查」。
  const checkValidityMs = numberSetting(getDb(), 'catalog.install_check_validity_seconds', 86400) * 1000;
  const nowForChecks = Date.now();

  return (
    <div>
      <BackLink href="/packs">返回整合包</BackLink>

      <header className="article-head">
        <h1 className="article-title">{detail.packId ? (selected?.title ?? '整合包') : '整合包'}</h1>
        <div className="article-meta">
          <span>作者 {detail.authorNickname}</span>
          {selected ? (
            <>
              <span>第 {selected.releaseNumber} 版</span>
              <span>{formatVersionLabel('DSH', selected.dshVersion)}</span>
              <span className={selected.testStatus === 'tested' ? 'tag site' : 'tag'}>
                {selected.testStatus === 'tested' ? '作者已实测' : '未实测'}
              </span>
              <span>{formatDateTimeOr(selected.publishedAt, '时间未知')}</span>
            </>
          ) : null}
          <PackFavoriteButton
            packId={detail.packId}
            initialFavorited={detail.favoritedByMe}
            initialCount={detail.favoriteCount}
            authenticated={ctx.userId !== null}
          />
          {selected ? (
            <>
              <PackHelpfulButton
                releaseId={selected.releaseId}
                initialCount={helpful.count}
                initialHelpful={helpful.helpful}
                authenticated={ctx.userId !== null}
              />
              <ReportButton
                targetKind="pack_release"
                targetId={selected.releaseId}
                authenticated={ctx.userId !== null}
              />
            </>
          ) : null}
        </div>
      </header>

      {detail.fellBack ? (
        <p className="empty" style={{ marginTop: 12 }}>
          最新版本已被作者撤回，这里展示的是仍公开的第 {selected?.releaseNumber} 版。
        </p>
      ) : null}
      {detail.requestedUnavailable ? (
        <p className="empty" style={{ marginTop: 12 }}>
          你指定的第 {releaseNumber} 版当前不可公开（已撤回或被隐藏）。
        </p>
      ) : null}

      {detail.releases.length > 1 ? (
        <section className="panel" aria-label="版本历史">
          <div className="section-head">
            <h2>版本历史</h2>
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {detail.releases.map((r) => {
              const available = !r.withdrawn && !r.hidden;
              const isCurrent = selected?.releaseNumber === r.releaseNumber;
              return (
                <li key={r.releaseId}>
                  {available ? (
                    <Link
                      href={`/packs/${detail.packId}?v=${r.releaseNumber}`}
                      className="button"
                      aria-current={isCurrent ? 'page' : undefined}
                    >
                      第 {r.releaseNumber} 版
                    </Link>
                  ) : (
                    <span className="button" aria-disabled="true" title={r.withdrawn ? '作者已撤回' : '已被隐藏'}>
                      第 {r.releaseNumber} 版（不可公开）
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {selected === null ? (
        <p className="empty">这个整合包当前没有可公开的版本。</p>
      ) : (
        <>
          <section className="panel">
            <div className="section-head">
              <h2>用途</h2>
            </div>
            <p style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>{selected.purpose}</p>
          </section>

          <section className="panel">
            <div className="section-head">
              <h2>组合使用说明</h2>
            </div>
            <div className="review-body" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
          </section>

          <section className="panel" aria-label="安装命令">
            <div className="section-head">
              <h2>安装（{selected.items.length} 个插件）</h2>
              {selected.commands.copyAll.length > 0 ? (
                <CopyButton text={selected.commands.copyAll} label="复制全部命令" copiedLabel="已复制全部" size="md" />
              ) : null}
            </div>
            <p className="muted" style={{ marginTop: 0 }}>
              命令由每条的安装目标生成；`&lt;profile&gt;` 请换成你自己的 DSH profile 名。
              {selected.commands.pendingCount > 0
                ? ` 有 ${selected.commands.pendingCount} 项资料待核实，未生成命令（批量复制不包含它们）。`
                : ''}
            </p>

            <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {selected.items.map((item) => (
                <li
                  key={`${item.position}-${item.pluginId}`}
                  style={{
                    borderTop: '1px solid var(--md-sys-color-outline-variant, #DBE1EA)',
                    padding: '10px 0',
                  }}
                >
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <strong>
                      {item.position + 1}.{' '}
                      <Link href={`/plugins/${item.pluginId}`}>
                        {item.displaySnapshot.displayName ?? item.displaySnapshot.repositoryFullName ?? '（插件）'}
                      </Link>
                    </strong>
                    <span className="muted">{formatVersionLabel('插件', item.pluginVersion)}</span>
                    {item.purpose ? <span className="muted">—— {item.purpose}</span> : null}
                  </div>

                  {installChecks.has(item.position) ? (
                    <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                      安装核验：
                      {(() => {
                        const check = installChecks.get(item.position);
                        if (check?.state === 'ok') {
                          const expired =
                            check.completedAt === null || nowForChecks - check.completedAt > checkValidityMs;
                          return expired ? '待复查（核验已过期）' : '已核验通过';
                        }
                        if (check?.state === 'failed') return `核验未通过（${check.detail ?? '目标不存在'}）`;
                        if (check?.state === 'pending') return '核验中';
                        return '待核实（缺少安装目标）';
                      })()}
                    </div>
                  ) : null}

                  {item.command !== null ? (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
                      <code
                        style={{
                          background: 'rgba(13,15,19,0.06)',
                          padding: '4px 8px',
                          borderRadius: 6,
                          fontSize: 12.5,
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {item.command}
                      </code>
                      <CopyButton text={item.command} label="复制" />
                      {item.targetLabel ? <span className="muted">{item.targetLabel}</span> : null}
                    </div>
                  ) : (
                    <div style={{ marginTop: 6 }}>
                      <span className="tag warn">待核实</span>{' '}
                      <span className="muted">{item.pendingReason}</span>
                      {item.sourceUrl ? (
                        <>
                          {' '}
                          <a href={item.sourceUrl} target="_blank" rel="noreferrer noopener">
                            查看来源
                          </a>
                        </>
                      ) : null}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </section>

          {selected.configTemplate ? (
            <section className="panel" aria-label="配置模板">
              <div className="section-head">
                <h2>配置模板（可选）</h2>
                <CopyButton text={selected.configTemplate} label="复制模板" />
              </div>
              <p className="muted" style={{ marginTop: 0 }}>
                模板里的 API Key、密码等用占位符表示，请在本机填写；本站不会代为应用配置。
              </p>
              <pre
                style={{
                  background: '#0d0f13',
                  color: '#e8f0df',
                  padding: 12,
                  borderRadius: 8,
                  overflowX: 'auto',
                  fontSize: 12.5,
                  marginBottom: 0,
                }}
              >
                {selected.configTemplate}
              </pre>
            </section>
          ) : null}

          <section className="panel" aria-label="整合包测评">
            <div className="section-head">
              <h2>测评（{packReviews.length}）</h2>
              {ctx.userId !== null ? (
                <Link
                  href={`/packs/${packId}/review/new?v=${selected.releaseNumber}`}
                  className="button"
                >
                  写测评
                </Link>
              ) : null}
            </div>
            {packReviews.length === 0 ? (
              <p className="empty" style={{ marginBottom: 0 }}>
                还没有测评。登录后可以写第一篇。
              </p>
            ) : (
              <ul className="item-list">
                {packReviews.map((review) => (
                  <li key={review.reviewId} className="item">
                    <div className="item-body">
                      <h3>
                        <Link href={`/reviews/${review.reviewId}`}>{review.title}</Link>
                      </h3>
                      <div className="list-meta">
                        <span>{review.authorNickname ?? review.authorId}</span>
                        <span>{formatDateTimeOr(review.createdAt, '时间未知')}</span>
                        {review.releaseNumber ? <span>第 {review.releaseNumber} 版</span> : null}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {selected.testStatus === 'tested' ? (
            <section className="panel" aria-label="作者实测">
              <div className="section-head">
                <h2>作者实测</h2>
              </div>
              <p style={{ marginTop: 0 }}>
                <strong>测试任务：</strong>
                {selected.testTask}
              </p>
              <p style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                <strong>测试结果：</strong>
                {selected.testResult}
              </p>
            </section>
          ) : null}
          {selected ? <CommentSection contentId={selected.releaseId} /> : null}
        </>
      )}
    </div>
  );
}
