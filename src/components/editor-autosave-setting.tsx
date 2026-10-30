'use client';

/**
 * 个人设置 · 编辑偏好：草稿自动保存间隔。
 *
 * 为什么放在「个人设置」而不是编辑器里：这是**每用户**的写作习惯（有人习惯手动存、
 * 有人正文长需要更长的静默期），改一次就该到处生效，不该每篇草稿重设。
 *
 * 值存服务端（迁移 0030），所以换设备也一致；编辑器页在服务端读好偏好再渲染，
 * 因此下一次打开编辑器即生效（已打开的页面不会中途改计时）。
 */

import { useState } from 'react';
import { AUTOSAVE_SECONDS_OPTIONS, autosaveOptionLabel } from '@/packages/common/autosave';
import { ApiError, ErrorNotice } from './api-client';

export function EditorAutosaveSetting({ initialSeconds }: { initialSeconds: number }) {
  const [seconds, setSeconds] = useState(initialSeconds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [savedText, setSavedText] = useState<string | null>(null);

  const save = async (next: number) => {
    setBusy(true);
    setError(null);
    setSavedText(null);
    try {
      const response = await fetch('/api/me/preferences', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ editorAutosaveSeconds: next }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        data?: { editorAutosaveSeconds?: number };
        error?: { message?: string };
      };
      if (!response.ok || !payload.ok) {
        throw { code: 'request_failed', message: payload.error?.message ?? '保存失败。' } as ApiError;
      }
      const applied = payload.data?.editorAutosaveSeconds ?? next;
      setSeconds(applied);
      setSavedText(applied === 0 ? '已关闭自动保存（只手动保存）。' : `已改为停笔 ${applied} 秒后自动保存。`);
    } catch (e) {
      setError(e as ApiError);
      // 失败时把下拉退回到服务端仍然使用的值：不让界面显示一个没生效的设置。
      setSeconds(initialSeconds);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <label htmlFor="autosave-seconds" style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>
        草稿自动保存
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <select
          id="autosave-seconds"
          value={seconds}
          disabled={busy}
          onChange={(e) => void save(Number(e.target.value))}
          style={{ minWidth: 180 }}
        >
          {AUTOSAVE_SECONDS_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {autosaveOptionLabel(option)}
            </option>
          ))}
        </select>
        {busy ? <span className="muted" style={{ fontSize: 13 }}>保存中…</span> : null}
      </div>
      <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
        评测与整合包编辑页在停止输入这么久之后自动保存一次；默认 {autosaveOptionLabel(5)}。
        设成「关闭」后只在你点「保存」时写入。
      </p>
      {savedText ? <p className="muted" style={{ fontSize: 13 }}>{savedText}</p> : null}
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </div>
  );
}
