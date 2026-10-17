/**
 * 公开评测详情（架构第 88.2、88.3 节）。
 *
 * 只读**当前公开修订**；撤回/隐藏时按第 65 节返回允许告知的状态，
 * 不返回正文、不泄露待审新内容。
 */

import { getDb } from '@/server/platform/db';
import { err } from '@/packages/common/errors';
import { resolveVisibilityInTx } from '@/server/modules/content';
import { okJson, errorResponse, requestMeta } from '../../_lib/context';

export const runtime = 'nodejs';

interface Row {
  review_id: string;
  plugin_id: string | null;
  source_kind: 'community' | 'site';
  author_nickname: string;
  title: string;
  body_markdown: string;
  revision_id: string;
  revision_number: number;
  plugin_version: string;
  dsh_version: string;
  /** 五状态判定（dsh-bench 规范）：历史修订可为 null。 */
  verdict: string | null;
  /** 证据链 JSON 文本（[{url, note}]）：历史修订可为 null。 */
  evidence_refs: string | null;
  first_published_at: number | null;
  public_updated_at: number | null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ reviewId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { reviewId } = await params;
    const db = getDb();

    const vis = resolveVisibilityInTx(db, reviewId);
    if (!vis.publiclyVisible) {
      // 明确区分撤回/隐藏/未发布，但不返回任何正文或私有材料。
      const reason = vis.withdrawn ? '该评测已被作者撤回。' : vis.hidden ? '该评测当前不可查看。' : '该评测尚未发布。';
      throw err.unavailable(reason);
    }

    const row = db
      .prepare(
        `SELECT r.id AS review_id, r.plugin_id, r.source_kind, u.nickname AS author_nickname,
                rev.title, rev.body_markdown, rev.id AS revision_id, rev.revision_number,
                rev.plugin_version, rev.dsh_version, rev.verdict, rev.evidence_refs,
                ce.first_published_at, ce.public_updated_at
           FROM reviews r
           JOIN content_entities ce ON ce.id = r.id
           JOIN users u ON u.id = ce.author_id
           JOIN review_revisions rev ON rev.id = r.published_revision_id
          WHERE r.id = ?`,
      )
      .get(reviewId) as Row | undefined;

    if (!row) throw err.unavailable('该评测不存在或不可访问。');

    return okJson(
      {
        reviewId: row.review_id,
        pluginId: row.plugin_id,
        sourceKind: row.source_kind,
        title: row.title,
        bodyMarkdown: row.body_markdown,
        revisionId: row.revision_id,
        revisionNumber: row.revision_number,
        pluginVersion: JSON.parse(row.plugin_version) as unknown,
        dshVersion: JSON.parse(row.dsh_version) as unknown,
        // 判定与证据链（dsh-bench 规范）：null = 该修订没有给出，不补写。
        verdict: row.verdict,
        evidenceRefs: row.evidence_refs ? (JSON.parse(row.evidence_refs) as unknown) : null,
        authorNickname: row.author_nickname,
        firstPublishedAt: row.first_published_at === null ? null : new Date(row.first_published_at).toISOString(),
        publicUpdatedAt: row.public_updated_at === null ? null : new Date(row.public_updated_at).toISOString(),
      },
      requestId,
    );
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
