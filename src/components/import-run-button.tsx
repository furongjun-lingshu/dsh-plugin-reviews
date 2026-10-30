'use client';

/**
 * 运行/重试导入批次：不带 itemId 处理全部待办；带 itemId 只重试那一条。
 *
 * 结果就地显示（处理了几条、成功几条、失败几条、是否因预算停下），然后刷新页面。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice } from './api-client';

export function ImportRunButton({
  batchId,
  itemId,
  label,
  className = 'button',
}: {
  batchId: string;
  itemId?: string;
  label: string;
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setSummary(null);
    try {
      const response = await fetch(
        '/api/admin/imports/' + encodeURIComponent(batchId) + '/run',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(itemId ? { itemId } : {}),
        },
      );
      const payload = (await response.json()) as {
        ok?: boolean;
        data?: { processed?: number; done?: number; failed?: number; pending?: number; budgetExhausted?: boolean };
        error?: { message?: string };
      };
      if (!response.ok || !payload.ok) {
        throw { code: 'request_failed', message: payload.error?.message ?? '运行失败。' } as ApiError;
      }
      const d = payload.data ?? {};
      setSummary(
        '处理 ' + (d.processed ?? 0) + ' 条：成功 ' + (d.done ?? 0) + '、失败 ' + (d.failed ?? 0) +
          '，仍待处理 ' + (d.pending ?? 0) + ' 条' +
          (d.budgetExhausted ? '（本轮预算用尽，可再点一次继续）' : ''),
      );
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <button type="button" className={className} disabled={busy} onClick={() => void run()}>
        {busy ? '处理中…' : label}
      </button>
      {summary ? <span className="muted" style={{ fontSize: 13 }}>{summary}</span> : null}
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </span>
  );
}
