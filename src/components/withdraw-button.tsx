'use client';

/**
 * 作者撤回自己的已发布评测。
 *
 * 几条刻意的设计决定：
 *  1. 两段式：先点「撤回这篇评测」展开确认区，再点「确认撤回」才真的发请求。
 *     撤回是不可从界面撤销的动作（重新公开要重新提交并通过检查），不能一键误触。
 *  2. 若期间内容已被改动（撤回/隐藏/重新发布过），请求会被拒，
 *     而不是撤回一份你没看过的新内容。
 *  3. 撤回不删除历史：公开修订指针保留，只是不再公开。这一点必须在界面上说清楚，
 *     否则作者会以为"撤回 = 销毁"，反而不敢用。
 *  3b. 撤回**只撤回评测**，不删除草稿；删除草稿是草稿区的独立动作，两者不再绑定。
 *  4. 成功后不立即刷新：刷新会让整页变成"作者已撤回"、把说明冲掉。给一个显式的刷新入口。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, apiFetch, newRequestKey } from './api-client';

export function WithdrawButton({
  reviewId,
  expectedControlVersion,
}: {
  reviewId: string;
  expectedControlVersion: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async () => {
    if (!window.confirm('撤回这篇评测？撤回后读者将看不到它。继续？')) return;

    setBusy(true);
    setError(null);
    const requestKey = pendingKey ?? newRequestKey();
    setPendingKey(requestKey);

    try {
      await apiFetch<{ withdrawnAt: number }>(
        `/api/reviews/${encodeURIComponent(reviewId)}/withdraw`,
        {
          method: 'POST',
          json: {
            expectedControlVersion,
            requestKey,
            reason: reason.trim() === '' ? null : reason.trim(),
          },
        },
      );
      setPendingKey(null);
      setOpen(false);
      setDone('已撤回。这篇评测不再对读者公开，历史修订仍然保留（不会被删除）。');
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div
        role="status"
        className="notice success"
        style={{
          fontSize: 13,
        }}
      >
        {done}
        <div style={{ marginTop: 6 }}>
          <button
            type="button"
            onClick={() => router.refresh()}
            className="link-btn"
          >
            刷新页面
          </button>
        </div>
      </div>
    );
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="button">
        撤回这篇评测
      </button>
    );
  }

  return (
    <div>
      <label htmlFor={`withdraw-reason-${reviewId}`} style={{ fontSize: 13, marginBottom: 4 }}>
        撤回原因（可选）
      </label>
      <input
        id={`withdraw-reason-${reviewId}`}
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="例如：数据有误，先撤下"
        style={{ width: '100%', fontSize: 13 }}
      />
      <p className="muted" style={{ fontSize: 12, margin: '6px 0' }}>
        撤回后读者看不到这篇评测（显示「作者已撤回」）。<strong>历史修订不会被删除</strong>；
        想重新公开，需要修改后重新提交审核。
      </p>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          className="button primary"
        >
          {busy ? '撤回中…' : '确认撤回'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          disabled={busy}
          className="button"
        >
          取消
        </button>
      </div>
    </div>
  );
}
