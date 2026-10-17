/**
 * 评测文章页：正文主栏 + 版本明确。
 *
 * 只显示当前公开修订；撤回/隐藏时说明状态，不返回正文。
 * 正文之后依次是修订历史、评论区。
 */

import { notFound } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { resolveVisibilityInTx } from '@/server/modules/content';
import { formatVersionLabel } from '@/packages/common/status-text';
import { DomainError, ErrorCodes } from '@/packages/common/errors';
import { renderArticleMarkdown } from '@/server/platform/markdown';
import { currentContext } from '@/app/api/_lib/context';
import { isAdmin } from '@/server/platform/context';
import { CommentSection } from '@/components/comment-section';
import { RevisionHistory } from '@/components/revision-history';
import { ArticleHero } from '@/components/article-hero';
import { WithdrawButton } from '@/components/withdraw-button';
import { AdminHideForm } from '@/components/admin-hide-form';
import { BackLink } from '@/components/back-link';
import type { VersionValue } from '@/packages/common/field-rules';
import { formatDateTime } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

interface Row {
  review_id: string;
  plugin_id: string | null;
  source_kind: 'community' | 'site';
  title: string;
  body_markdown: string;
  plugin_version: string;
  dsh_version: string;
  author_nickname: string;
  author_id: string;
  first_published_at: number | null;
  public_updated_at: number | null;
}

export default async function ReviewDetailPage({ params }: { params: Promise<{ reviewId: string }> }) {
  const { reviewId } = await params;
  const db = getDb();

  // 作者视角需要"这是不是我的文章"；服务端已经解析过会话，这里只读不多查库。
  const ctx = await currentContext();

  // 不存在的评测走 404 页，而不是把 DomainError 漏成 500（外部实测 2026-10-17：
  // /reviews/<未知ID> 与 /reviews/<非UUID> 均渲染 500 + digest，而 /plugins/<未知> 是 404）。
  let vis;
  try {
    vis = resolveVisibilityInTx(db, reviewId);
  } catch (error) {
    if (error instanceof DomainError && error.code === ErrorCodes.TARGET_UNAVAILABLE) notFound();
    throw error;
  }
  if (!vis.publiclyVisible) {
    return (
      <div>
        <BackLink href="/reviews">返回评测列表</BackLink>
        <h1>该评测当前不可查看</h1>
        <p className="muted">
          {vis.withdrawn ? '作者已撤回这篇评测。' : vis.hidden ? '这篇评测已被隐藏。' : '这篇评测尚未发布。'}
        </p>
        {/*
          管理员要能在这里解除隐藏：不可查看时正文不渲染，所以这个入口必须挂在状态页上。
        */}
        {isAdmin(ctx) ? (
          <div className="panel" style={{ marginTop: 20 }}>
            <div className="section-head">
              <h2>管理员操作</h2>
            </div>
            <AdminHideForm
              contentId={reviewId}
              controlVersion={vis.controlVersion}
              hidden={vis.hidden}
              visibility={vis}
            />
          </div>
        ) : null}
      </div>
    );
  }

  const row = db
    .prepare(
      `SELECT r.id AS review_id, r.plugin_id, r.source_kind, rev.title, rev.body_markdown,
              rev.plugin_version, rev.dsh_version, u.nickname AS author_nickname, ce.author_id,
              ce.first_published_at, ce.public_updated_at
         FROM reviews r
         JOIN content_entities ce ON ce.id = r.id
         JOIN users u ON u.id = ce.author_id
         JOIN review_revisions rev ON rev.id = r.published_revision_id
        WHERE r.id = ?`,
    )
    .get(reviewId) as Row | undefined;
  if (!row) notFound();

  const pluginVersion = JSON.parse(row.plugin_version) as VersionValue;
  const dshVersion = JSON.parse(row.dsh_version) as VersionValue;

  // 正文经统一管线渲染并净化。HTML 只是展示结果，Markdown 原文才是权威内容。
  // 正文与目录一次渲染出来：标题的锚点 id 由服务端生成（目录链接不依赖 JS）。
  const { html: safeBodyHtml } = renderArticleMarkdown(row.body_markdown);

  return (
    /*
      文章页版式：**正文是主角，资料与历史是旁栏**。
        左：修订历史（粘住）  中：文章壳（头图 → 标题层 → 正文框 → 评论）  右：版本与时间 / 操作
      窄屏按 globals.css 的断点降级：中栏与右栏两栏、再整页单列。
    */
    <div>
      {/*
        返回入口放在**整页顶部**（不属于任何一栏）：这样三栏从同一条水平线开始，
        修订历史与右侧「版本与时间」就不会一上一下（主人指出过）。
        间距仍走 .back-link 的 --gap-backlink 标准值，与插件详情页一致。
      */}
      {row.plugin_id ? <BackLink href={`/plugins/${row.plugin_id}`}>返回插件页</BackLink> : null}

      <div className="article-layout">
        {/*
          修订历史移到左栏（原来挂在正文末尾）。它挂在正文里时，读者要读完一整篇才看到"改过几次"；
          作为旁栏信息，随时可见。
        */}
        <aside className="article-rail">
          <RevisionHistory reviewId={reviewId} />
        </aside>

      {/*
        文章壳分三层：
          1. 头图（代码生成的 SVG，不用位图资源）；
          2. 标题层 —— 上移压住头图，形成"图在上、题浮出"的分层；
          3. 正文框 —— 正文被包进一张卡片里，与标题层分开，读起来边界清楚。
      */}
      <article className="article-shell">
        {/* 头图与标题在**同一张卡**里（主人：融合成一个完整的圆角，不要再让标题浮在图上） */}
        <div className="article-hero-card">
          <ArticleHero seed={row.review_id} />

          <header className="article-head">
            <h1 className="article-title">{row.title}</h1>
            <div className="article-meta">
              <span className={row.source_kind === 'site' ? 'tag site' : 'tag'}>
                {row.source_kind === 'site' ? '站点评测' : '社区评测'}
              </span>
              <span>{formatVersionLabel('插件', pluginVersion)}</span>
              <span>{formatVersionLabel('DSH', dshVersion)}</span>
              <span>{row.author_nickname}</span>
            </div>
          </header>
        </div>

        <div className="article-frame">
          {/*
            渲染后的正文（已净化）。版式全部在 globals.css 的 .review-body 里。
          */}
          <div className="review-body" dangerouslySetInnerHTML={{ __html: safeBodyHtml }} />
        </div>

        {/*
          评论区是客户端组件：列表照旧读公开讨论组，登录态与"发表评论"走真实接口。
          服务端不预取列表，否则发完评论要整页刷新才能看到。
        */}
        <CommentSection contentId={reviewId} />
      </article>

      <aside className="article-side">
        <div className="panel">
          <div className="section-head">
            <h2>版本与时间</h2>
          </div>
          {/* M3 列表行：标签左、值右，每行 10px 纵向内边距 —— 之前用 <br> 堆行，字挤在一起 */}
          <dl className="meta-list">
            <div>
              <dt>被测插件版本</dt>
              <dd>{formatVersionLabel('插件', pluginVersion)}</dd>
            </div>
            <div>
              <dt>被测 DSH 版本</dt>
              <dd>{formatVersionLabel('DSH', dshVersion)}</dd>
            </div>
            <div>
              <dt>首次发布</dt>
              <dd>{row.first_published_at === null ? '未知' : formatDateTime(row.first_published_at)}</dd>
            </div>
            <div>
              <dt>最近更新</dt>
              <dd>{row.public_updated_at === null ? '未知' : formatDateTime(row.public_updated_at)}</dd>
            </div>
          </dl>
        </div>

        {/*
          作者操作只在作者本人看这篇时出现。撤回资格由服务端核验（非作者一律 403），
          这里隐藏按钮只是不摆一个点了也没用的入口，不是权限判断。
        */}
        {ctx.userId !== null && ctx.userId === row.author_id ? (
          <div className="panel" style={{ marginTop: 12 }}>
            <h2 style={{ marginBottom: 8 }}>作者操作</h2>
            <WithdrawButton reviewId={row.review_id} expectedControlVersion={vis.controlVersion} />
          </div>
        ) : null}

        {/*
          管理员操作：隐藏 / 取消隐藏。
          与作者撤回是两条独立的资格与语义：解除隐藏不等于恢复公开，撤回状态独立生效。
        */}
        {isAdmin(ctx) ? (
          <div className="panel" style={{ marginTop: 12 }}>
            <h2 style={{ marginBottom: 8 }}>管理员操作</h2>
            <AdminHideForm
              contentId={row.review_id}
              controlVersion={vis.controlVersion}
              hidden={vis.hidden}
              visibility={vis}
            />
          </div>
        ) : null}
      </aside>
      </div>
    </div>
  );
}