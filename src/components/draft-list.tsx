'use client';

/**
 * 「我的评测」草稿列表（客户端）：批量选择 + 批量删除 + 单删。
 *
 * 批量删除与单删语义一致：**只删草稿**，不撤回、不影响已提交/已发布评测。
 * 提示文案必须与行为一致（此前的「删除即撤回」文案已过时）。
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DeleteDraftButton } from './delete-draft-button';
import { ApiError, ErrorNotice, apiFetch } from './api-client';
import { formatDateTime } from '@/packages/common/time';

export interface DraftListItem {
  draftId: string;
  title: string;
  saveVersion: number;
  savedAt: number;
  published: boolean;
  withdrawn: boolean;
}

export function DraftList({ drafts }: { drafts: DraftListItem[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const allSelected = drafts.length > 0 && drafts.every((d) => selected.has(d.draftId));
  const selectedCount = selected.size;
  const selectedPublished = useMemo(
    () => drafts.filter((d) => selected.has(d.draftId) && d.published && !d.withdrawn).length,
    [drafts, selected],
  );

  const toggle = (id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const onBatchDelete = async () => {
    if (busy || selected.size === 0) return;
    const message =
      selectedPublished > 0
        ? `将删除 ${selectedCount} 份草稿；其中 ${selectedPublished} 份关联的评测已发布，删除草稿不会撤回它们。删除后草稿不可恢复，继续？`
        : `将删除 ${selectedCount} 份草稿，删除后不可恢复，继续？`;
    if (!window.confirm(message)) return;

    setBusy(true);
    setError(null);
    try {
      await apiFetch('/api/drafts/batch-delete', {
        method: 'POST',
        json: {
          draftIds: drafts.filter((d) => selected.has(d.draftId)).map((d) => d.draftId),
        },
      });
      setSelected(new Set());
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
          <input
            type="checkbox"
            checked={allSelected}
            onChange={(e) =>
              setSelected(e.target.checked ? new Set(drafts.map((d) => d.draftId)) : new Set())
            }
          />
          全选
        </label>
        <button
          type="button"
          className="button"
          disabled={busy || selectedCount === 0}
          onClick={() => void onBatchDelete()}
        >
          {busy ? '删除中…' : `批量删除${selectedCount > 0 ? `（${selectedCount}）` : ''}`}
        </button>
        <span className="muted" style={{ fontSize: 13 }}>
          删除草稿只移除草稿，不影响已发布的评测。
        </span>
      </div>

      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}

      <ul className="item-list">
        {drafts.map((d) => (
          <li key={d.draftId} className="item">
            <label style={{ marginRight: 10, alignSelf: 'flex-start', marginTop: 4 }}>
              <input
                type="checkbox"
                checked={selected.has(d.draftId)}
                onChange={(e) => toggle(d.draftId, e.target.checked)}
                aria-label={`选择草稿：${d.title || d.draftId}`}
              />
            </label>
            <div className="item-body">
              <h3>
                <Link href={`/me/drafts/${d.draftId}`}>
                  {d.title && d.title.trim() !== '' ? d.title : '(尚未填写标题)'}
                </Link>
              </h3>
              <div className="list-meta">
                <span>保存版本 {d.saveVersion}</span>
                <span>最近保存 {formatDateTime(d.savedAt)}</span>
                <code>{d.draftId}</code>
                {d.published ? (
                  <span className="tag">{d.withdrawn ? '已发布 · 已撤回' : '已发布'}</span>
                ) : null}
                <span style={{ marginLeft: 'auto' }}>
                  <DeleteDraftButton draftId={d.draftId} />
                </span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
