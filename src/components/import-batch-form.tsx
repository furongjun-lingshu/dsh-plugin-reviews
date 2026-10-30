'use client';

/**
 * 新建导入批次：粘贴清单（一行一链接，或 CSV），选预演/导入，提交。
 *
 * 刻意**不**在创建后自动开始执行：预演的意义就是"先看结果再决定"，
 * 自动跑等于把两步并一步，反而容易误导入。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, newRequestKey } from './api-client';

export function ImportBatchForm() {
  const router = useRouter();
  const [manifest, setManifest] = useState('');
  const [mode, setMode] = useState<'dry_run' | 'apply'>('dry_run');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/imports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest, mode, requestKey: newRequestKey() }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        data?: { batchId?: string };
        error?: { message?: string };
      };
      if (!response.ok || !payload.ok || !payload.data?.batchId) {
        throw { code: 'request_failed', message: payload.error?.message ?? '创建批次失败。' } as ApiError;
      }
      router.push('/admin/imports/' + payload.data.batchId);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <label htmlFor="manifest" style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>
        清单
      </label>
      <textarea
        id="manifest"
        value={manifest}
        onChange={(e) => setManifest(e.target.value)}
        rows={8}
        placeholder={'一行一个链接：\nhttps://github.com/owner/repo\nhttps://github.com/owner/repo/tree/main/packages/foo\n\n或 CSV（首行 url,path,note）：\nurl,path,note\nhttps://github.com/owner/repo,packages/foo,备注'}
        style={{ width: '100%', fontFamily: 'monospace', fontSize: 13 }}
      />
      <p className="muted" style={{ fontSize: 13 }}>
        「仓库 + 子路径」相同的条目会自动合并；每一行都会逐条跑一次收录检查，
        与每日自动发现共用同一份 GitHub 请求预算（每轮最多处理若干条，跑不完留到下一轮）。
      </p>

      <fieldset style={{ border: 'none', padding: 0, margin: '8px 0' }}>
        <legend style={{ fontWeight: 600, marginBottom: 6 }}>模式</legend>
        <label style={{ display: 'block', marginBottom: 4 }}>
          <input
            type="radio"
            name="mode"
            checked={mode === 'dry_run'}
            onChange={() => setMode('dry_run')}
          />{' '}
          预演：只检查、不入库（先看结果再决定）
        </label>
        <label style={{ display: 'block' }}>
          <input type="radio" name="mode" checked={mode === 'apply'} onChange={() => setMode('apply')} />{' '}
          导入：检查通过即收录
        </label>
      </fieldset>

      <button
        type="button"
        className="button primary"
        disabled={busy || manifest.trim().length === 0}
        onClick={() => void submit()}
      >
        {busy ? '创建中…' : '创建批次'}
      </button>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </div>
  );
}
