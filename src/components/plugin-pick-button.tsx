'use client';

/**
 * 草稿页「选择所对应的插件」的确认按钮：POST /api/drafts/plugin 后回到编辑器。
 *
 * 为什么选完要回编辑器而不是留在列表页：作者下一步一定是继续写正文或提交，
 * 停在一个「选插件」的页面没有意义。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice } from './api-client';

export function PluginPickButton({
  draftId,
  pluginId,
  label,
  isCurrent = false,
}: {
  draftId: string;
  pluginId: string;
  label: string;
  isCurrent?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const pick = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/drafts/plugin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftId, pluginId }),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: { message?: string } };
      if (!response.ok || !payload.ok) {
        throw { code: 'request_failed', message: payload.error?.message ?? '绑定失败。' } as ApiError;
      }
      router.push(`/me/drafts/${draftId}`);
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
      setBusy(false);
    }
  };

  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <button
        type="button"
        className={isCurrent ? 'button tonal' : 'button primary'}
        disabled={busy || isCurrent}
        onClick={() => void pick()}
        title={isCurrent ? '已经是这篇草稿对应的插件' : `把这篇草稿关联到「${label}」`}
      >
        {isCurrent ? '当前对应' : busy ? '绑定中…' : '选它'}
      </button>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </span>
  );
}
