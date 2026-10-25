'use client';

/**
 * 「删除草稿」按钮（编辑器与「我的评测」列表共用）。
 *
 * 语义：DELETE /api/drafts?draftId=…
 * 删除草稿**只删草稿**：不撤回、不影响已提交/已发布的评测。
 * 删除前必须二次确认——草稿正文不可恢复。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, apiFetch } from './api-client';

export function DeleteDraftButton({
  draftId,
  redirectTo,
  className = 'link-btn',
  label = '删除草稿',
}: {
  draftId: string;
  /** 删除成功后跳转到哪（编辑器用 /me；列表里不传，原地刷新）。 */
  redirectTo?: string;
  className?: string;
  label?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const onDelete = async () => {
    if (busy) return;
    if (
      !window.confirm('删除这份草稿？删除后草稿不可恢复；已发布的评测不会受影响。')
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/drafts?draftId=${encodeURIComponent(draftId)}`, { method: 'DELETE' });
      if (redirectTo) router.push(redirectTo);
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
      setBusy(false);
    }
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button
        type="button"
        className={className}
        onClick={() => void onDelete()}
        disabled={busy}
        style={{ color: 'var(--md-sys-color-error, #b3261e)' }}
      >
        {busy ? '删除中…' : label}
      </button>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </span>
  );
}
