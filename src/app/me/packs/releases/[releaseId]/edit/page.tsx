/** 编辑未发布的整合包草稿。 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { readPreferences } from '@/server/modules/preferences';
import { currentContext } from '../../../../../api/_lib/context';
import { PackEditForm } from '@/components/pack-edit-form';
import type { ReleaseInput } from '@/server/modules/packs';
import type { VersionValue } from '@/packages/common/field-rules';
import type { InstallTarget } from '@/packages/common/pack-install';

export const dynamic = 'force-dynamic';

export default async function EditPackReleasePage({
  params,
}: {
  params: Promise<{ releaseId: string }>;
}) {
  const { releaseId } = await params;
  const ctx = await currentContext();
  if (ctx.userId === null) redirect('/onboarding?returnTo=/me/packs');

  const db = getDb();
  const rel = db
    .prepare(
      `SELECT rel.id, rel.title, rel.purpose, rel.body_markdown, rel.dsh_version, rel.config_template,
              rel.test_status, rel.test_task, rel.test_result, rel.review_status, p.author_id
         FROM plugin_pack_releases rel
         JOIN plugin_packs p ON p.id = rel.pack_id
        WHERE rel.id = ?`,
    )
    .get(releaseId) as
    | {
        id: string;
        title: string;
        purpose: string;
        body_markdown: string;
        dsh_version: string;
        config_template: string | null;
        test_status: 'untested' | 'tested';
        test_task: string | null;
        test_result: string | null;
        review_status: string;
        author_id: string;
      }
    | undefined;
  if (!rel || rel.author_id !== ctx.userId) notFound();
  if (rel.review_status !== 'draft' && rel.review_status !== 'rejected') {
    return (
      <div>
        <h1>编辑整合包</h1>
        <p className="empty">只有未上传或被拒绝的版本可以编辑；已提交/已发布版本请发布新版本。</p>
        <p><Link href="/me/packs">返回我的整合包</Link></p>
      </div>
    );
  }

  const itemRows = db
    .prepare(
      `SELECT plugin_id, position, purpose, plugin_version, install_target, source_url
         FROM plugin_pack_release_items WHERE release_id = ? ORDER BY position ASC`,
    )
    .all(releaseId) as Array<{
    plugin_id: string;
    position: number;
    purpose: string | null;
    plugin_version: string;
    install_target: string | null;
    source_url: string | null;
  }>;

  const initial: ReleaseInput = {
    title: rel.title,
    purpose: rel.purpose,
    bodyMarkdown: rel.body_markdown,
    dshVersion: JSON.parse(rel.dsh_version) as VersionValue,
    configTemplate: rel.config_template,
    testStatus: rel.test_status,
    testTask: rel.test_task,
    testResult: rel.test_result,
    items: itemRows.map((row) => ({
      pluginId: row.plugin_id,
      purpose: row.purpose,
      pluginVersion: JSON.parse(row.plugin_version) as VersionValue,
      installTarget: row.install_target === null ? null : (JSON.parse(row.install_target) as InstallTarget),
      sourceUrl: row.source_url,
    })),
  };

  return (
    <div>
      <h1>编辑整合包</h1>
      <p style={{ marginTop: 0 }}>
        <Link href="/me/packs">← 返回我的整合包</Link>
      </p>
      <PackEditForm
        releaseId={releaseId}
        initial={initial}
        initialAutosaveSeconds={readPreferences(db, ctx.userId).editorAutosaveSeconds}
      />
    </div>
  );
}
