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
import { EditReviewButton } from '@/components/edit-review-button';
import { AdminHideForm } from '@/components/admin-hide-form';
import Link from 'next/link';
import { BackLink } from '@/components/back-link';
import { HelpfulButton } from '@/components/helpful-button';
import { ReportButton } from '@/components/report-button';
import { createInteractionsService } from '@/server/modules/interactions';
import type { VersionValue } from '@/packages/common/field-rules';
import { formatDateTime } from '@/packages/common/time';
import { isVerdictKey, parseEvidenceRefs, verdictDef, type EvidenceRef } from '@/packages/common/verdict';
import { assessmentLabel } from '@/packages/common/assessment';

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
  /** 五状态判定（dsh-bench 规范）；历史修订可能为 null。 */
  verdict: string | null;
  /** 证据链 JSON 文本（[{url, note}]）；历史修订可能为 null。 */
  evidence_refs: string | null;
  /** 测评档位；历史修订可能为 null（未标注）。 */
  assessment_level: string | null;
}

export default async function ReviewDetailPage({ params }: { params: Promise<{ reviewId: string }> }) {
  const { reviewId } = await params;
  const db = getDb();

  // 作者视角需要"这是不是我的文章"；服务端已经解析过会话，这里只读不多查库。
  const ctx = await currentContext();

  // 有帮助状态（登录时带上「我投过没有」，匿名只给总数）—— idea.md §13
  const helpful = await createInteractionsService({ db }).helpfulState(reviewId, ctx.userId);

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
              rev.plugin_version, rev.dsh_version, rev.verdict, rev.evidence_refs, rev.assessment_level,
              u.nickname AS author_nickname, ce.author_id,
              ce.first_published_at, ce.public_updated_at
         FROM reviews r
         JOIN content_entities ce ON ce.id = r.id
         JOIN users u ON u.id = ce.author_id
         JOIN review_revisions rev ON rev.id = r.published_revision_id
        WHERE r.id = ?`,
    )
    .get(reviewId) as Row | undefined;
  if (!row) {
    // 整合包测评：内容在 pack_reviews / pack_review_revisions，渲染简化版详情。
    const packRow = db
      .prepare(
        `SELECT pr.id AS review_id, rel.pack_id, p.title AS pack_title, rel.release_number,
                ce.author_id, u.nickname, rev.title, rev.body_markdown, rev.dsh_version,
                rev.verdict, rev.evidence_refs, rev.assessment_level, rev.submitted_at AS created_at
           FROM pack_reviews pr
           JOIN plugin_pack_releases rel ON rel.id = pr.release_id
           JOIN plugin_packs p ON p.id = rel.pack_id
           JOIN content_entities ce ON ce.id = pr.id
           JOIN users u ON u.id = ce.author_id
           JOIN pack_review_revisions rev ON rev.id = pr.published_revision_id
          WHERE pr.id = ?`,
      )
      .get(reviewId) as
      | {
          review_id: string;
          pack_id: string;
          pack_title: string;
          release_number: number | null;
          author_id: string;
          nickname: string;
          title: string;
          body_markdown: string;
          dsh_version: string;
          verdict: string | null;
          evidence_refs: string | null;
          assessment_level: string | null;
          created_at: number;
        }
      | undefined;
    if (!packRow) notFound();

    const packDshVersion = JSON.parse(packRow.dsh_version) as VersionValue;
    const packVerdictKey = isVerdictKey(packRow.verdict) ? packRow.verdict : null;
    const packAssessmentText = assessmentLabel(packRow.assessment_level);
    let packEvidenceRefs: EvidenceRef[] = [];
    if (packRow.evidence_refs) {
      try {
        packEvidenceRefs = parseEvidenceRefs(JSON.parse(packRow.evidence_refs), { required: false });
      } catch {
        packEvidenceRefs = [];
      }
    }
    const { html: packBodyHtml } = renderArticleMarkdown(packRow.body_markdown);

    return (
      <div>
        <div className="article-topbar">
          <BackLink
            href={`/packs/${packRow.pack_id}${packRow.release_number ? `?v=${packRow.release_number}` : ''}`}
          >
            返回整合包
          </BackLink>
          <div className="article-topbar-actions">
            <ReportButton targetKind="review" targetId={reviewId} authenticated={ctx.userId !== null} />
          </div>
        </div>

        <article className="article-shell" style={{ marginTop: 12 }}>
          <div className="article-hero-card">
            <ArticleHero seed={reviewId} />
            <header className="article-head">
              <h1 className="article-title">
                <span className="tag article-source">整合包测评</span>
                {packRow.title}
              </h1>
              <div className="article-meta">
                <BackLink
                  href={`/packs/${packRow.pack_id}${packRow.release_number ? `?v=${packRow.release_number}` : ''}`}
                >
                  {packRow.pack_title}
                  {packRow.release_number ? ` · 第 ${packRow.release_number} 版` : ''}
                </BackLink>
                <span>{formatVersionLabel('DSH', packDshVersion)}</span>
                <span>{packRow.nickname}</span>
                <span className="tag" title="本篇测评档位">
                  {packAssessmentText ?? '未标注档位'}
                </span>
                {packVerdictKey ? (
                  <span className="tag verdict-badge" title="五状态判定">
                    {verdictDef(packVerdictKey).label}
                  </span>
                ) : null}
              </div>
            </header>
          </div>

          {packEvidenceRefs.length > 0 ? (
            <section className="panel" style={{ margin: '0 0 16px' }} aria-label="证据链">
              <h2 style={{ fontSize: 15, margin: '0 0 8px' }}>证据链</h2>
              <ol className="evidence-list" style={{ margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: 1.7 }}>
                {packEvidenceRefs.map((item) => (
                  <li key={item.url}>
                    <a href={item.url} target="_blank" rel="noreferrer noopener">
                      点击跳转
                    </a>
                    {item.note ? <span className="muted">——{item.note}</span> : null}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          <div className="article-frame">
            <div className="review-body" dangerouslySetInnerHTML={{ __html: packBodyHtml }} />
          </div>

          <CommentSection contentId={reviewId} />
        </article>
      </div>
    );
  }

  // 封面：只认本修订固定下来的 cover 引用（提交时从草稿 copy 过来），没有就置空——
  // 页面退回用代码生成的头图，不伪造图片。
  const cover = db
    .prepare(
      `SELECT a.id AS attachment_id, f.variant_key
         FROM review_revision_attachment_links l
         JOIN attachment_files f ON f.id = l.file_id
         JOIN attachments a ON a.id = f.attachment_id
        WHERE l.review_revision_id = (
                SELECT published_revision_id FROM reviews WHERE id = ?
              )
          AND l.usage = 'cover' AND f.processing_state = 'ready' AND f.variant_role = 'display'`,
    )
    .get(reviewId) as { attachment_id: string; variant_key: string } | undefined;
  const coverUrl = cover ? `/media/${cover.attachment_id}/${cover.variant_key}` : null;

  const pluginVersion = JSON.parse(row.plugin_version) as VersionValue;
  const dshVersion = JSON.parse(row.dsh_version) as VersionValue;
  // 判定与证据：老修订没有 → 如实显示「未给出」，不补写（规范：未测就写未测）。
  const verdictKey = isVerdictKey(row.verdict) ? row.verdict : null;
  const assessmentText = assessmentLabel(row.assessment_level);
  let evidenceRefs: EvidenceRef[] = [];
  if (row.evidence_refs) {
    try {
      evidenceRefs = parseEvidenceRefs(JSON.parse(row.evidence_refs), { required: false });
    } catch {
      evidenceRefs = [];
    }
  }

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
      <div className="article-topbar">
        {row.plugin_id ? <BackLink href={`/plugins/${row.plugin_id}`}>返回插件页</BackLink> : null}
        {/* 读者动作放右侧，与返回入口同一条基线（主人要求：有帮助/举报不要埋在元信息里） */}
        <div className="article-topbar-actions">
          <HelpfulButton
            reviewId={reviewId}
            initialCount={helpful.count}
            initialHelpful={helpful.helpful}
            authenticated={ctx.userId !== null}
          />
          <ReportButton targetKind="review" targetId={reviewId} authenticated={ctx.userId !== null} />
        </div>
      </div>

      <div className="article-layout">
        {/*
          修订历史移到左栏（原来挂在正文末尾）。它挂在正文里时，读者要读完一整篇才看到"改过几次"；
          作为旁栏信息，随时可见。
        */}
        <aside className="article-rail" data-motion-panel>
          <RevisionHistory reviewId={reviewId} />
        </aside>

      {/*
        文章壳分三层：
          1. 头图（代码生成的 SVG，不用位图资源）；
          2. 标题层 —— 上移压住头图，形成"图在上、题浮出"的分层；
          3. 正文框 —— 正文被包进一张卡片里，与标题层分开，读起来边界清楚。
      */}
      <article className="article-shell" data-motion-panel>
        {/*
          封面：作者选定的图（正文图或单独上传）。没有封面时不渲染任何占位图片，
          头图仍由 ArticleHero 生成——"缺省用插件图标占位"在这个版式里就是生成图。
        */}
        {coverUrl ? (
          <figure className="article-cover" style={{ margin: 0 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={coverUrl}
              alt={`${row.title} 的封面图`}
              style={{ width: '100%', height: 'auto', display: 'block', borderRadius: 10 }}
            />
          </figure>
        ) : null}
        {evidenceRefs.length > 0 || (verdictKey && verdictDef(verdictKey).conclusive) ? (
          <section className="panel" style={{ margin: '0 0 16px' }} aria-label="证据链">
            <h2 style={{ fontSize: 15, margin: '0 0 8px' }}>证据链</h2>
            {evidenceRefs.length > 0 ? (
              <ol className="evidence-list" style={{ margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: 1.7 }}>
                {evidenceRefs.map((item) => (
                  <li key={item.url}>
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      title={item.url}
                      aria-label={`打开证据链接：${item.url}`}
                    >
                      点击跳转
                    </a>
                    {item.note ? <span className="muted">——{item.note}</span> : null}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                这个判定没有附证据链——按规范，有结论的判定应当能复核；缺证据时请按「还说不准」理解。
              </p>
            )}
          </section>
        ) : null}
        {/* 头图与标题在**同一张卡**里（主人：融合成一个完整的圆角，不要再让标题浮在图上）*/}
        <div className="article-hero-card">
          <ArticleHero seed={row.review_id} />

          <header className="article-head">
            <h1 className="article-title">
              <span className={row.source_kind === 'site' ? 'tag site article-source' : 'tag article-source'}>
                {row.source_kind === 'site' ? '站点评测' : '社区评测'}
              </span>
              {row.title}
            </h1>
            <div className="article-meta">
              <span>{formatVersionLabel('插件', pluginVersion)}</span>
              <span>{formatVersionLabel('DSH', dshVersion)}</span>
              <span>{row.author_nickname}</span>
              <span className={assessmentText ? 'tag site' : 'tag'} title="本篇测评档位（dsh-bench 测评规范）">
                {assessmentText ?? '未标注档位'}
              </span>
              {verdictKey ? (
                <span className="tag verdict-badge" title="五状态判定（dsh-bench 测评规范）">
                  {verdictDef(verdictKey).label}
                </span>
              ) : (
                <span className="tag" title="这份修订没有给出判定">未给出判定</span>
              )}
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

      <aside className="article-side" data-motion-panel>
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
            <div style={{ marginBottom: 10 }}>
              <EditReviewButton reviewId={row.review_id} />
            </div>
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

      {/* 这一页的反馈入口：与插件详情页同一处措辞，把当前路径带过去 */}
      <p className="muted" style={{ marginTop: 24, fontSize: 13 }}>
        <Link href={'/feedback?from=' + encodeURIComponent('/reviews/' + reviewId)}>
          这一页有问题？反馈给站方
        </Link>
      </p>
    </div>
  );
}