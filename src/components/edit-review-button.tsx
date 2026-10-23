'use client';

/**
 * 「修改测评」按钮：作者在评测详情页点击后创建/复用修改草稿，跳到编辑器。
 *
 * 权限由服务端核验（只有作者本人能创建修改草稿）；这里只负责把按钮摆出来。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, apiFetch } from './api-client';

export function EditReviewButton({ reviewId }: { reviewId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ draftId: string }>(
        `/api/reviews/${encodeURIComponent(reviewId)}/edit-draft`,
        { method: 'POST' },
      );
      router.push(`/me/drafts/${result.draftId}`);
    } catch (e) {
      setError(e as ApiError);
      setBusy(false);
    }
  };

  return (
    <div>
      <button type="button" className="button primary" onClick={() => void onClick()} disabled={busy}>
        {busy ? '打开编辑中…' : '修改测评'}
      </button>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </div>
  );
}
