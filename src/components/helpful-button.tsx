'use client';

/**
 * 「有帮助」按钮（`idea.md §13`）：登录用户一人一票、再点取消。
 *
 * 初始值由服务端给（详情页已经查过库），点击后以接口返回为准 ——
 * 不用本地乐观计数，避免"界面 +1 但库里没写进去"这种假状态。
 *
 * 数字那一格**交给动效引擎写**（`tweenNumber` + `tick`）：
 * 所以 React 只在首屏渲染一次 `initialCount`，后续更新走 DOM 补间 ——
 * 否则 React 先把数字改成新值，补间就没有"从哪来"了（参考工作区的 setNumber 同理）。
 */

import { useEffect, useRef, useState } from 'react';
import { ApiError, ErrorNotice, apiFetch } from './api-client';
import { tick, tweenNumber } from './motion/engine';

export function HelpfulButton({
  reviewId,
  initialCount,
  initialHelpful,
  authenticated,
}: {
  reviewId: string;
  initialCount: number;
  initialHelpful: boolean;
  authenticated: boolean;
}) {
  const [count, setCount] = useState(initialCount);
  const [helpful, setHelpful] = useState(initialHelpful);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const countRef = useRef<HTMLSpanElement>(null);
  const firstRender = useRef(true);

  /* 数字滚动 + 闪一下：只在真的变化时跑（首屏不算） */
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    tweenNumber(countRef.current, count, { ms: 320, threshold: 1 });
    tick(countRef.current);
  }, [count]);

  const toggle = async () => {
    if (!authenticated) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ helpful: boolean; count: number }>(
        `/api/reviews/${encodeURIComponent(reviewId)}/helpful`,
        { method: 'POST' },
      );
      setHelpful(result.helpful);
      setCount(result.count);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy || !authenticated}
        title={authenticated ? '这篇文章对你有帮助吗？' : '登录后可以表达「有帮助」'}
        aria-pressed={helpful}
        aria-label={`有帮助 ${count}${helpful ? '（已标记）' : ''}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          background: helpful ? 'var(--md-sys-color-primary)' : 'transparent',
          color: helpful ? 'var(--md-sys-color-on-primary)' : 'var(--accent)',
          border: `1px solid ${
            helpful ? 'var(--md-sys-color-primary)' : 'var(--md-sys-color-outline-variant)'
          }`,
          borderRadius: 999,
          padding: '3px 12px',
          cursor: authenticated ? 'pointer' : 'not-allowed',
          fontSize: 13,
        }}
      >
        <span aria-hidden="true">👍</span>
        <span aria-hidden="true">有帮助</span>
        <span ref={countRef} className="count-value" aria-hidden="true">
          {initialCount}
        </span>
      </button>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </span>
  );
}