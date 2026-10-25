'use client';

/**
 * 收藏夹操作：改名 / 删除。
 *
 * - 改名：内联输入，1-40 字，重名由服务端拒绝；
 * - 删除：默认夹不显示删除；夹内收藏会移到默认收藏夹（确认框写明）。
 */

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, apiFetch } from './api-client';

export function FolderActions({
  folderId,
  name,
  isDefault,
  count,
}: {
  folderId: string;
  name: string;
  isDefault: boolean;
  count: number;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const rename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/me/favorites/folders/${encodeURIComponent(folderId)}`, {
        method: 'PATCH',
        json: { name: trimmed },
      });
      setEditing(false);
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
      setBusy(false);
    }
  };

  const remove = async () => {
    const message =
      count > 0
        ? `删除收藏夹「${name}」？夹内 ${count} 个插件会移到默认收藏夹。`
        : `删除收藏夹「${name}」？`;
    if (!window.confirm(message)) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/me/favorites/folders/${encodeURIComponent(folderId)}`, { method: 'DELETE' });
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
      setBusy(false);
    }
  };

  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      {editing ? (
        <form onSubmit={(e) => void rename(e)} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input
            type="text"
            value={draft}
            maxLength={40}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="收藏夹新名称"
            style={{ width: 150 }}
          />
          <button type="submit" className="button" disabled={busy || draft.trim() === ''}>
            保存
          </button>
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setEditing(false);
              setDraft(name);
              setError(null);
            }}
          >
            取消
          </button>
        </form>
      ) : (
        <>
          <button type="button" className="link-btn" disabled={busy} onClick={() => setEditing(true)}>
            改名
          </button>
          {!isDefault ? (
            <button
              type="button"
              className="link-btn"
              disabled={busy}
              onClick={() => void remove()}
              style={{ color: 'var(--md-sys-color-error, #b3261e)' }}
            >
              删除
            </button>
          ) : null}
        </>
      )}
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </span>
  );
}
