'use client';

/**
 * 后台「资料纠错」组（`idea.md §2`、§23）。
 *
 * 采纳 = 把建议值写进 `plugin_field_overrides`（读取时优先）；驳回只通知。
 * 已采纳的条目额外提供「恢复同步资料」：删掉覆盖值就回到 GitHub 同步来的原值，
 * 不需要重新探测 —— 这是"同步值与修正值分开存"换来的能力。
 */

import { useCallback, useEffect, useState } from 'react';
import { formatDateTime } from '@/packages/common/time';
import { ApiError, ErrorNotice, apiFetch, buttonStyle, inputStyle } from './api-client';

interface CorrectionRow {
  correctionId: string;
  pluginId: string;
  pluginLabel: string;
  submittedByNickname: string;
  proposed: Record<string, string>;
  description: string;
  referenceUrl: string | null;
  state: 'open' | 'accepted' | 'rejected';
  createdAt: number;
}

const FIELD_LABELS: Record<string, string> = { display_name: '展示名', description: '简介' };
const STATES = [
  { value: 'open', label: '未处理' },
  { value: 'accepted', label: '已采纳' },
  { value: 'rejected', label: '已驳回' },
  { value: 'all', label: '全部' },
];

export function AdminCorrectionPanel() {
  const [state, setState] = useState('open');
  const [rows, setRows] = useState<CorrectionRow[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const load = useCallback(async (next = state) => {
    try {
      const result = await apiFetch<{ corrections: CorrectionRow[] }>(
        `/api/admin/corrections?state=${next}`,
        { cache: 'no-store' },
      );
      setRows(result.corrections);
      setError(null);
    } catch (e) {
      setError(e as ApiError);
    }
  }, [state]);

  useEffect(() => {
    void load();
  }, [load]);

  const handle = async (correctionId: string, action: 'accept' | 'reject') => {
    const reason = (reasons[correctionId] ?? '').trim();
    if (reason.length === 0) {
      setError({ code: 'input_invalid', message: '请先填写处理原因（会写进处理记录并发给提交者）。' } as ApiError);
      return;
    }
    setBusy(correctionId);
    setError(null);
    setNotice(null);
    try {
      const result = await apiFetch<{ state: string; notified: number }>(
        `/api/admin/corrections/${encodeURIComponent(correctionId)}/handle`,
        { method: 'POST', json: { action, reason } },
      );
      setNotice(action === 'accept' ? `已采纳并生效，通知 ${result.notified} 人。` : `已驳回，通知 ${result.notified} 人。`);
      await load();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(null);
    }
  };

  const revert = async (pluginId: string, fieldKey: string) => {
    setBusy(`${pluginId}:${fieldKey}`);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(
        `/api/admin/plugins/${encodeURIComponent(pluginId)}/overrides/${encodeURIComponent(fieldKey)}`,
        { method: 'DELETE' },
      );
      setNotice(`已恢复 ${FIELD_LABELS[fieldKey] ?? fieldKey} 的同步资料。`);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section style={{ marginTop: 32, borderTop: '1px solid var(--md-sys-color-outline-variant)', paddingTop: 16 }}>
      <h2 style={{ fontSize: 18 }}>资料纠错</h2>
      <p style={{ color: 'var(--md-sys-color-on-surface-variant)', fontSize: 14 }}>
        用户反馈的插件资料错误。采纳后修正值优先于同步值；「恢复同步资料」只是删掉覆盖值（同步值一直原样保存着）。
      </p>

      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
      {notice ? <p style={{ color: 'var(--success-ink)', fontSize: 14 }}>{notice}</p> : null}

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {STATES.map((s) => (
          <button
            key={s.value}
            type="button"
            onClick={() => {
              setState(s.value);
              void load(s.value);
            }}
            style={{
              background: state === s.value ? 'var(--md-sys-color-primary)' : 'var(--md-sys-color-surface-container-lowest)',
              color: state === s.value ? 'var(--md-sys-color-on-primary)' : 'var(--md-sys-color-on-surface-variant)',
              border: '1px solid var(--md-sys-color-outline-variant)',
              borderRadius: 999,
              padding: '3px 12px',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {rows === null ? (
        <p style={{ color: 'var(--md-sys-color-on-surface-variant)' }}>正在读取纠错…</p>
      ) : rows.length === 0 ? (
        <p style={{ color: 'var(--md-sys-color-on-surface-variant)', fontSize: 14 }}>没有{STATES.find((s) => s.value === state)?.label}的纠错。</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {rows.map((r) => (
            <li
              key={r.correctionId}
              style={{ border: '1px solid var(--md-sys-color-outline-variant)', borderRadius: 8, padding: 12, marginBottom: 10, fontSize: 14 }}
            >
              <div>
                <strong>{r.pluginLabel}</strong>
                <span style={{ color: 'var(--md-sys-color-on-surface-variant)' }}>
                  {' · '}
                  {r.submittedByNickname} 提交于 {formatDateTime(r.createdAt)}
                  {r.state !== 'open' ? ` · 状态 ${r.state}` : ''}
                </span>
              </div>
              <div style={{ marginTop: 6 }}>
                {Object.entries(r.proposed).map(([field, value]) => (
                  <div key={field} style={{ marginBottom: 4 }}>
                    <span className="tag">{FIELD_LABELS[field] ?? field}</span>{' '}
                    <span style={{ color: 'var(--ink)' }}>{value}</span>
                  </div>
                ))}
              </div>
              <div style={{ color: 'var(--md-sys-color-on-surface-variant)' }}>说明：{r.description}</div>
              {r.referenceUrl ? (
                <div style={{ marginTop: 4 }}>
                  <a href={r.referenceUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontSize: 13 }}>
                    参考链接
                  </a>
                </div>
              ) : null}

              {r.state === 'open' ? (
                <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    aria-label="处理原因"
                    placeholder="处理原因（必填，会通知提交者）"
                    value={reasons[r.correctionId] ?? ''}
                    onChange={(e) => setReasons({ ...reasons, [r.correctionId]: e.target.value })}
                    style={{ ...inputStyle, flex: '1 1 260px' }}
                  />
                  <button
                    type="button"
                    disabled={busy === r.correctionId}
                    onClick={() => void handle(r.correctionId, 'accept')}
                    style={buttonStyle}
                  >
                    采纳
                  </button>
                  <button
                    type="button"
                    disabled={busy === r.correctionId}
                    onClick={() => void handle(r.correctionId, 'reject')}
                    style={{ ...buttonStyle, background: 'var(--md-sys-color-on-surface-variant)' }}
                  >
                    驳回
                  </button>
                </div>
              ) : r.state === 'accepted' ? (
                <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {Object.keys(r.proposed).map((field) => (
                    <button
                      key={field}
                      type="button"
                      disabled={busy === `${r.pluginId}:${field}`}
                      onClick={() => void revert(r.pluginId, field)}
                      style={{ ...buttonStyle, background: 'var(--warn-ink)' }}
                    >
                      恢复「{FIELD_LABELS[field] ?? field}」的同步资料
                    </button>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
