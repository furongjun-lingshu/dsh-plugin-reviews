/**
 * 我的：评测（草稿 / 提交记录 / 已发布 三个子页）。
 *
 * 三块用 `?tab=drafts|submissions|published` 切换，共用一条标题搜索 `?q=`。
 * 草稿只放「还没提交的」；提交后草稿从草稿区移除，修改已提交评测走
 * 「打开评测 → 修改测评」重新生成修改草稿。
 *
 * 页面布局（页面布局.md §10）：桌面左侧栏目导航 + 右侧内容；手机由断点落成单列。
 */

import Link from 'next/link';
import { getDb } from '@/server/platform/db';
import { currentContext } from '../api/_lib/context';
import { listDraftSummaries } from '@/server/modules/reviews';
import { MeNav } from '@/components/me-nav';
import { DraftList } from '@/components/draft-list';
import { submissionStateLabels } from '@/packages/common/status-text';
import type { SubmissionState } from '@/packages/common/field-rules';
import { formatDateTime } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

type Tab = 'drafts' | 'submissions' | 'published';

const TAB_LABELS: Record<Tab, string> = {
  drafts: '草稿',
  submissions: '提交记录',
  published: '已发布',
};

function readTab(raw: string | undefined): Tab {
  return raw === 'submissions' || raw === 'published' ? raw : 'drafts';
}

function firstValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

interface SubRow {
  submission_id: string;
  submission_type: 'review_revision' | 'comment_revision';
  processing_state: SubmissionState;
  submitted_at: number;
  review_id: string | null;
  title: string | null;
  withdrawn_at: number | null;
  has_public_revision: number;
}

interface PublishedRow {
  review_id: string;
  title: string;
  updated_at: number | null;
}

export default async function MePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const tab = readTab(firstValue(sp.tab));
  const q = (firstValue(sp.q) ?? '').trim().slice(0, 100);
  const like = q ? `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;

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

  // 统计条始终显示全量（不受搜索影响）
  const draftCount = (
    db
      .prepare(
        `SELECT count(*) AS c FROM content_drafts
          WHERE owner_id = ? AND draft_type = 'review' AND deleted_at IS NULL`,
      )
      .get(ctx.userId) as { c: number }
  ).c;
  const subCount = (
    db.prepare('SELECT count(*) AS c FROM content_submissions WHERE submitted_by = ?').get(ctx.userId) as {
      c: number;
    }
  ).c;
  const publishedCount = (
    db
      .prepare(
        `SELECT count(*) AS c
           FROM reviews r
           JOIN content_entities ce ON ce.id = r.id
          WHERE ce.author_id = ?
            AND r.published_revision_id IS NOT NULL
            AND ce.withdrawn_at IS NULL
            AND ce.hidden_at IS NULL`,
      )
      .get(ctx.userId) as { c: number }
  ).c;

  const draftSummaries = tab === 'drafts' ? await listDraftSummaries(ctx, db, q) : [];
  const subs =
    tab === 'submissions'
      ? (db
          .prepare(
            `SELECT s.id AS submission_id, s.submission_type, s.processing_state, s.submitted_at,
                    rev.review_id, rev.title AS title, ce.withdrawn_at,
                    CASE WHEN r.published_revision_id IS NULL THEN 0 ELSE 1 END AS has_public_revision
               FROM content_submissions s
               LEFT JOIN review_revisions rev ON rev.id = s.review_revision_id
               LEFT JOIN reviews r ON r.id = rev.review_id
               LEFT JOIN content_entities ce ON ce.id = rev.review_id
              WHERE s.submitted_by = ?
                AND (? IS NULL OR IFNULL(rev.title, '') LIKE ? ESCAPE '\\')
              ORDER BY s.submitted_at DESC, s.id DESC`,
          )
          .all(ctx.userId, like, like) as SubRow[])
      : [];
  const published =
    tab === 'published'
      ? (db
          .prepare(
            `SELECT r.id AS review_id, rev.title, ce.public_updated_at AS updated_at
               FROM reviews r
               JOIN content_entities ce ON ce.id = r.id
               JOIN review_revisions rev ON rev.id = r.published_revision_id
              WHERE ce.author_id = ?
                AND r.published_revision_id IS NOT NULL
                AND ce.withdrawn_at IS NULL
                AND ce.hidden_at IS NULL
                AND (? IS NULL OR rev.title LIKE ? ESCAPE '\\')
              ORDER BY ce.public_updated_at DESC, r.id DESC`,
          )
          .all(ctx.userId, like, like) as PublishedRow[])
      : [];

  const tabHref = (next: Tab): string => {
    const params = new URLSearchParams();
    params.set('tab', next);
    if (q) params.set('q', q);
    return `/me?${params.toString()}`;
  };

  const emptyText: Record<Tab, string> = {
    drafts: '暂无草稿。写评测请到插件目录选一个插件，从它的详情页开始。',
    submissions: '暂无提交记录。',
    published: '暂无已发布评测。',
  };

  return (
    <div>
      <h1>我的评测</h1>

      <div className="me-layout">
        <MeNav current="reviews" />

        <div>
          <div className="stat-row">
            <div className="stat">
              <div className="stat-value">{draftCount}</div>
              <div className="stat-label">草稿</div>
            </div>
            <div className="stat">
              <div className="stat-value">{subCount}</div>
              <div className="stat-label">提交记录</div>
            </div>
            <div className="stat">
              <div className="stat-value">{publishedCount}</div>
              <div className="stat-label">已发布</div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
              <Link
                key={t}
                href={tabHref(t)}
                className={tab === t ? 'button primary' : 'button'}
                aria-current={tab === t ? 'page' : undefined}
              >
                {TAB_LABELS[t]}
              </Link>
            ))}
          </div>

          <form action="/me" method="get" className="search" style={{ marginBottom: 12 }}>
            <input type="hidden" name="tab" value={tab} />
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="按标题关键词搜索"
              aria-label="按标题关键词搜索"
              maxLength={100}
            />
            <button type="submit" className="search-go">
              搜索
            </button>
          </form>

          <section className="panel">
            <div className="section-head">
              <h2>
                {TAB_LABELS[tab]}
                {q ? `（搜索：${q}）` : ''}
              </h2>
            </div>

            {tab === 'drafts' ? (
              draftSummaries.length === 0 ? (
                <p className="empty" style={{ marginBottom: 0 }}>
                  {emptyText.drafts}
                </p>
              ) : (
                <DraftList
                  drafts={draftSummaries.map((d) => ({
                    draftId: d.draftId,
                    title: d.title,
                    saveVersion: d.saveVersion,
                    savedAt: d.savedAt,
                    published: d.published,
                    withdrawn: d.withdrawn,
                  }))}
                />
              )
            ) : null}

            {tab === 'submissions' ? (
              subs.length === 0 ? (
                <p className="empty" style={{ marginBottom: 0 }}>
                  {emptyText.submissions}
                </p>
              ) : (
                <ul className="item-list">
                  {subs.map((s) => {
                    const kind = s.submission_type === 'comment_revision' ? '评论' : '评测';
                    const linkable = s.review_id !== null && s.has_public_revision === 1;
                    return (
                      <li key={s.submission_id} className="item">
                        <div className="item-body">
                          <h3>
                            {s.title && s.title.trim() !== '' ? (
                              linkable ? (
                                <Link href={`/reviews/${s.review_id}`}>{s.title}</Link>
                              ) : (
                                <span className="muted">{s.title}</span>
                              )
                            ) : linkable ? (
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
                            {s.withdrawn_at !== null ? (
                              <span className="tag" style={{ marginLeft: 6 }}>
                                已撤回
                              </span>
                            ) : null}
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
              )
            ) : null}

            {tab === 'published' ? (
              published.length === 0 ? (
                <p className="empty" style={{ marginBottom: 0 }}>
                  {emptyText.published}
                </p>
              ) : (
                <ul className="item-list">
                  {published.map((p) => (
                    <li key={p.review_id} className="item">
                      <div className="item-body">
                        <h3>
                          <Link href={`/reviews/${p.review_id}`}>{p.title}</Link>
                        </h3>
                        <div className="list-meta">
                          <span>最近更新 {p.updated_at === null ? '未知' : formatDateTime(p.updated_at)}</span>
                          <code>{p.review_id}</code>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}
