/**
 * 我的（个人中心最小版）：本人草稿与提交状态。
 *
 * 布局（页面布局.md §10）：**桌面左侧栏目导航 + 右侧内容**；手机由断点自动落成单列。
 * 页面标题 `h1` 放在分栏**之外**（整页居中偏左的页标题），因此左侧栏与右侧正文的第一行
 * （那句"写评测要从插件详情页进入…"）自然平齐，而不是与页标题等高。
 *
 * 内容区顶部是一条**真实计数**的统计条（草稿 / 提交记录 / 已发布），数字都来自下面的查询，
 * 不做估算——空的时候就是 0，一眼能看出"这个号还没开始写"。
 *
 * 本页只做"我的评测草稿 + 提交阶段"一块；收藏、整合包、事项属本切片范围外
 * （见 `docs/HANDOFF.md`：那些连表都没有）。
 *
 * 几处本轮补正（都是后端早已就绪、前端没接上的）：
 *  1. **栏目入口**：把已经存在的三块（评测 / 通知 / 个人设置）摆成左侧栏；
 *  2. **提交记录可跳转**：此前只列 id，看不出这是哪篇、能不能点。现在按
 *     `content_submissions.review_revision_id → review_revisions.review_id` 取到目标；
 *     **只在它确实有公开修订时才给链接**（否则 /reviews/{id} 只会 404）；
 *  3. **未登录文案纠错**：原文案写"本切片未接入真实 GitHub OAuth；开发环境可用
 *     `POST /api/session`"——两句话今天都不成立：真实 OAuth 已跑通，而登录 POST 已被移除
 *     （HANDOFF §8.1）。照它做会得到一个 405。现在改成指向顶部真实登录入口。
 */

import Link from 'next/link';
import { getDb } from '@/server/platform/db';
import { currentContext } from '../api/_lib/context';
import { MeNav } from '@/components/me-nav';
import { submissionStateLabels } from '@/packages/common/status-text';
import type { SubmissionState } from '@/packages/common/field-rules';
import { formatDateTime } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

interface DraftRow {
  draft_id: string;
  review_id: string;
  save_version: number;
  saved_at: number;
  title: string | null;
}

interface SubRow {
  submission_id: string;
  submission_type: 'review_revision' | 'comment_revision';
  processing_state: SubmissionState;
  submitted_at: number;
  review_id: string | null;
  /** 目标评测是否已有公开修订——决定给不给链接（没公开的话 /reviews/{id} 只会 404） */
  has_public_revision: number;
}

export default async function MePage() {
  const ctx = await currentContext();

  if (ctx.userId === null) {
    return (
      <div>
        <h1>我的评测</h1>
        <div className="me-layout">
          <MeNav current="reviews" />
          <div>
            <p className="muted" style={{ marginTop: 0 }}>
              需要先登录。请使用页面顶部的登录入口。
            </p>
          </div>
        </div>
      </div>
    );
  }

  const db = getDb();
  const drafts = db
    .prepare(
      `SELECT d.id AS draft_id, d.review_id, d.save_version, d.saved_at, rev.title
         FROM content_drafts d
         LEFT JOIN review_revisions rev ON rev.review_id = d.review_id
        WHERE d.owner_id = ?
        GROUP BY d.id
        ORDER BY d.saved_at DESC, d.id DESC`,
    )
    .all(ctx.userId) as DraftRow[];

  const subs = db
    .prepare(
      `SELECT s.id AS submission_id, s.submission_type, s.processing_state, s.submitted_at,
              rev.review_id,
              CASE WHEN r.published_revision_id IS NULL THEN 0 ELSE 1 END AS has_public_revision
         FROM content_submissions s
         LEFT JOIN review_revisions rev ON rev.id = s.review_revision_id
         LEFT JOIN reviews r ON r.id = rev.review_id
        WHERE s.submitted_by = ?
        ORDER BY s.submitted_at DESC, s.id DESC`,
    )
    .all(ctx.userId) as SubRow[];

  const publishedCount = subs.filter((s) => s.processing_state === 'published').length;

  return (
    <div>
      <h1>我的评测</h1>

      <div className="me-layout">
        <MeNav current="reviews" />

        <div>
          <div className="stat-row">
            <div className="stat">
              <div className="stat-value">{drafts.length}</div>
              <div className="stat-label">草稿</div>
            </div>
            <div className="stat">
              <div className="stat-value">{subs.length}</div>
              <div className="stat-label">提交记录</div>
            </div>
            <div className="stat">
              <div className="stat-value">{publishedCount}</div>
              <div className="stat-label">已发布</div>
            </div>
          </div>

          <section className="panel">
            <div className="section-head">
              <h2>草稿（{drafts.length}）</h2>
            </div>
            {drafts.length === 0 ? (
              <p className="empty" style={{ marginBottom: 0 }}>
                暂无草稿。写评测请到 <Link href="/plugins">插件目录</Link> 选一个插件，从它的详情页开始。
              </p>
            ) : (
              <ul className="item-list">
                {drafts.map((d) => (
                  <li key={d.draft_id} className="item item-clickable">
                    <div className="item-body">
                      <h3>
                        <Link href={`/me/drafts/${d.draft_id}`}>
                          {d.title && d.title.trim() !== '' ? d.title : '(尚未填写标题)'}
                        </Link>
                      </h3>
                      <div className="list-meta">
                        <span>保存版本 {d.save_version}</span>
                        <span>最近保存 {formatDateTime(d.saved_at)}</span>
                        <code>{d.draft_id}</code>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel" style={{ marginTop: 20 }}>
            <div className="section-head">
              <h2>提交记录（{subs.length}）</h2>
            </div>
            {subs.length === 0 ? (
              <p className="empty" style={{ marginBottom: 0 }}>
                暂无提交。
              </p>
            ) : (
              <ul className="item-list">
                {subs.map((s) => {
                  const kind = s.submission_type === 'comment_revision' ? '评论' : '评测';
                  const linkable = s.review_id !== null && s.has_public_revision === 1;
                  return (
                    <li key={s.submission_id} className="item item-clickable">
                      <div className="item-body">
                        <h3>
                          {linkable ? (
                            <Link href={`/reviews/${s.review_id}`}>查看已发布内容</Link>
                          ) : (
                            <span className="muted">尚未公开发布</span>
                          )}
                        </h3>
                        <div>
                          <span className="tag" style={{ marginRight: 6 }}>
                            {kind}
                          </span>
                          <span className="tag">{submissionStateLabels[s.processing_state]}</span>
                        </div>
                        <div className="list-meta" style={{ marginTop: 6 }}>
                          <span>{formatDateTime(s.submitted_at)}</span>
                          <code>{s.submission_id}</code>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}