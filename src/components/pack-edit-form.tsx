'use client';

/**
 * 编辑未发布整合包版本（元数据；条目保持原样随请求带回）。
 *
 * 规划 §26 / 架构 §37：停止编辑 5 秒自动保存草稿。这里按「有改动 → 5 秒后 PATCH」，
 * 保存状态显示在按钮旁；手动「保存草稿」立即保存。
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice } from './api-client';
import type { ReleaseInput } from '@/server/modules/packs';
import { DEFAULT_AUTOSAVE_SECONDS } from '@/packages/common/autosave';

export function PackEditForm({
  releaseId,
  initial,
  /** 自动保存间隔（秒，0 = 关闭）：服务端读每用户偏好后传入（迁移 0030）。 */
  initialAutosaveSeconds = DEFAULT_AUTOSAVE_SECONDS,
}: {
  releaseId: string;
  initial: ReleaseInput;
  initialAutosaveSeconds?: number;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initial.title);
  const [purpose, setPurpose] = useState(initial.purpose);
  const [body, setBody] = useState(initial.bodyMarkdown);
  const [dshVersion, setDshVersion] = useState(
    initial.dshVersion.kind === 'known' ? initial.dshVersion.value : '',
  );
  const [configTemplate, setConfigTemplate] = useState(initial.configTemplate ?? '');
  const [testStatus, setTestStatus] = useState<'untested' | 'tested'>(initial.testStatus);
  const [testTask, setTestTask] = useState(initial.testTask ?? '');
  const [testResult, setTestResult] = useState(initial.testResult ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 自动保存静默期（毫秒，0 = 关闭）；来源是个人设置里的偏好。 */
  const autosaveMs = initialAutosaveSeconds * 1000;

  const buildPayload = useCallback(
    (): ReleaseInput => ({
      ...initial,
      title,
      purpose,
      bodyMarkdown: body,
      dshVersion: dshVersion.trim() ? { kind: 'known', value: dshVersion.trim() } : { kind: 'unknown' },
      configTemplate: configTemplate.trim() === '' ? null : configTemplate,
      testStatus,
      testTask: testStatus === 'tested' ? testTask : null,
      testResult: testStatus === 'tested' ? testResult : null,
    }),
    [initial, title, purpose, body, dshVersion, configTemplate, testStatus, testTask, testResult],
  );

  const save = useCallback(
    async (options: { redirect?: boolean } = {}) => {
      setBusy(true);
      setError(null);
      setSaveState('saving');
      try {
        const response = await fetch(`/api/pack-releases/${encodeURIComponent(releaseId)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(buildPayload()),
        });
        const payload = (await response.json()) as { ok?: boolean; error?: { message?: string } };
        if (!response.ok || !payload.ok) {
          throw { code: 'request_failed', message: payload.error?.message ?? '保存失败。' } as ApiError;
        }
        setDirty(false);
        setSaveState('saved');
        if (options.redirect) {
          router.push('/me/packs');
          router.refresh();
        }
      } catch (e) {
        setError(e as ApiError);
        setSaveState('error');
      } finally {
        setBusy(false);
      }
    },
    [buildPayload, releaseId, router],
  );

  const markDirty = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setDirty(true);
    setSaveState('idle');
  };

  // 停止编辑一段时间后自动保存（间隔来自个人设置；0 = 关闭）。
  useEffect(() => {
    if (!dirty) return;
    if (autosaveMs <= 0) return;
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      void save();
    }, autosaveMs);
    return () => {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    };
  }, [dirty, save, autosaveMs]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void save({ redirect: true });
  };

  const saveLabel =
    saveState === 'saving' ? '保存中…' : saveState === 'saved' ? '已保存' : saveState === 'error' ? '保存失败' : '';

  return (
    <form onSubmit={submit} className="panel" style={{ display: 'grid', gap: 10 }}>
      <label style={{ display: 'grid', gap: 4 }}>
        <span>名称（1-80 字）</span>
        <input value={title} maxLength={80} onChange={(e) => markDirty(setTitle)(e.target.value)} required />
      </label>
      <label style={{ display: 'grid', gap: 4 }}>
        <span>用途说明（1-2000 字）</span>
        <textarea value={purpose} maxLength={2000} rows={3} onChange={(e) => markDirty(setPurpose)(e.target.value)} required />
      </label>
      <label style={{ display: 'grid', gap: 4 }}>
        <span>组合使用说明（Markdown）</span>
        <textarea value={body} rows={10} onChange={(e) => markDirty(setBody)(e.target.value)} required />
      </label>
      <label style={{ display: 'grid', gap: 4 }}>
        <span>DSH 版本（留空 = 未知）</span>
        <input value={dshVersion} maxLength={100} onChange={(e) => markDirty(setDshVersion)(e.target.value)} />
      </label>
      <label style={{ display: 'grid', gap: 4 }}>
        <span>配置模板（可选）</span>
        <textarea value={configTemplate} rows={5} onChange={(e) => markDirty(setConfigTemplate)(e.target.value)} />
      </label>
      <label style={{ display: 'grid', gap: 4 }}>
        <span>实测状态</span>
        <select
          value={testStatus}
          onChange={(e) => {
            setTestStatus(e.target.value as 'untested' | 'tested');
            setDirty(true);
          }}
        >
          <option value="untested">未实测</option>
          <option value="tested">作者已实测</option>
        </select>
      </label>
      {testStatus === 'tested' ? (
        <>
          <label style={{ display: 'grid', gap: 4 }}>
            <span>测试任务</span>
            <input value={testTask} onChange={(e) => markDirty(setTestTask)(e.target.value)} required />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span>测试结果</span>
            <textarea value={testResult} rows={3} onChange={(e) => markDirty(setTestResult)(e.target.value)} required />
          </label>
        </>
      ) : null}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? '保存中…' : '保存并返回'}
        </button>
        <button type="button" className="button" disabled={busy} onClick={() => void save()}>
          立即保存
        </button>
        <span className="muted" style={{ fontSize: 13 }}>
          {saveLabel}
          {dirty ? '（5 秒后自动保存）' : ''}
        </span>
      </div>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </form>
  );
}
