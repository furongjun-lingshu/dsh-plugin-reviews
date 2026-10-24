'use client';

/**
 * 后台「举报处理」组（`idea.md §20`、§23）。
 *
 * 三种处理动作的语义（与 `interactions.handleReport` 一一对应）：
 *   * **隐藏** —— 内容真的不再公开，处理记录留原因，举报人与作者都会收到结果通知；
 *   * **驳回** —— 核实未违规，只通知举报人；
 *   * **要求补充证据** —— 举报保持未处理状态（状态仍是 open），只通知举报人补材料。
 *
 * 处理原因必填：§23 要求"记录处理原因"，空原因等于没记录。
 */

import { useCallback, useEffect, useState } from 'react';
import { formatDateTime } from '@/packages/common/time';
import { ApiError, ErrorNotice, apiFetch, buttonStyle, inputStyle } from './api-client';

interface ReportRow {
  reportId: string;
  targetKind: 'review' | 'comment' | 'pack_release';
  reason: string;
  detail: string | null;
  state: 'open' | 'resolved' | 'dismissed';
  reporterNickname: string;
  createdAt: number;
  targetExcerpt: string;
  targetHref: string;
}

const REASON_LABELS: Record<string, string> = {
  spam: '垃圾广告',
  abuse: '辱骂或人身攻击',
  misinformation: '错误信息',
  copyright: '版权或抄袭',
  other: '其他',
};
const TARGET_LABELS: Record<string, string> = { review: '评测', comment: '评论', pack_release: '整合包版本' };
const STATES = [
  { value: 'open', label: '未处理' },
  { value: 'resolved', label: '已处理' },
  { value: 'dismissed', label: '已驳回' },
  { value: 'all', label: '全部' },
];

export function AdminReportPanel() {
  const [state, setState] = useState('open');
  const [reports, setReports] = useState<ReportRow[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const load = useCallback(async (next = state) => {
    try {
      const result = await apiFetch<{ reports: ReportRow[] }>(`/api/admin/reports?state=${next}`, { cache: 'no-store' });
      setReports(result.reports);
      setError(null);
    } catch (e) {
      setError(e as ApiError);
    }
  }, [state]);

  useEffect(() => {
    void load();
  }, [load]);

  const handle = async (reportId: string, action: 'hide' | 'dismiss' | 'request_evidence') => {
    const reason = (reasons[reportId] ?? '').trim();
    if (reason.length === 0) {
      setError({ code: 'input_invalid', message: '请先填写处理原因（会写进处理记录并发给用户）。' } as ApiError);
      return;
    }
    setBusy(reportId);
    setError(null);
    setNotice(null);
    try {
      const result = await apiFetch<{ state: string; notified: number }>(
        `/api/admin/reports/${encodeURIComponent(reportId)}/handle`,
        { method: 'POST', json: { action, reason } },
      );
      setNotice(
        action === 'hide'
          ? `已隐藏内容，通知 ${result.notified} 人。`
          : action === 'dismiss'
            ? `已驳回，通知 ${result.notified} 人。`
            : `已要求补充证据，通知 ${result.notified} 人。`,
      );
      await load();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section style={{ marginTop: 32, borderTop: '1px solid var(--md-sys-color-outline-variant)', paddingTop: 16 }}>
      <h2 style={{ fontSize: 18 }}>举报处理</h2>
      <p style={{ color: 'var(--md-sys-color-on-surface-variant)', fontSize: 14 }}>
        登录用户对评测 / 评论 / 整合包版本的举报都进这里。处理必填原因：会写进处理记录，并以站内通知
        发给举报人（隐藏时也给内容作者发一条）。
      </p>

      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
      {notice ? <p style={{ color: 'var(--success-ink)', fontSize: 14 }}>{notice}</p> : null}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
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

      {reports === null ? (
        <p style={{ color: 'var(--md-sys-color-on-surface-variant)' }}>正在读取举报…</p>
      ) : reports.length === 0 ? (
        <p style={{ color: 'var(--md-sys-color-on-surface-variant)', fontSize: 14 }}>没有{STATES.find((s) => s.value === state)?.label}的举报。</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {reports.map((r) => (
            <li
              key={r.reportId}
              style={{ border: '1px solid var(--md-sys-color-outline-variant)', borderRadius: 8, padding: 12, marginBottom: 10, fontSize: 14 }}
            >
              <div>
                <span className="tag warn">{TARGET_LABELS[r.targetKind] ?? r.targetKind}</span>
                <strong style={{ marginLeft: 8 }}>{REASON_LABELS[r.reason] ?? r.reason}</strong>
                <span style={{ color: 'var(--md-sys-color-on-surface-variant)' }}>
                  {' · '}
                  {r.reporterNickname} 举报于 {formatDateTime(r.createdAt)}
                  {r.state !== 'open' ? ` · 状态 ${r.state}` : ''}
                </span>
              </div>
              <div style={{ marginTop: 6, color: 'var(--ink)' }}>{r.targetExcerpt}</div>
              {r.detail ? (
                <div style={{ marginTop: 4, color: 'var(--md-sys-color-on-surface-variant)' }}>补充说明：{r.detail}</div>
              ) : null}
              <div style={{ marginTop: 4 }}>
                <a href={r.targetHref} style={{ color: 'var(--accent)', fontSize: 13 }}>
                  查看被举报内容
                </a>
              </div>

              {r.state === 'open' ? (
                <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    aria-label="处理原因"
                    placeholder="处理原因（必填，会通知用户）"
                    value={reasons[r.reportId] ?? ''}
                    onChange={(e) => setReasons({ ...reasons, [r.reportId]: e.target.value })}
                    style={{ ...inputStyle, flex: '1 1 260px' }}
                  />
                  <button type="button" disabled={busy === r.reportId} onClick={() => void handle(r.reportId, 'hide')} style={{ ...buttonStyle, background: 'var(--danger)' }}>
                    隐藏内容
                  </button>
                  <button type="button" disabled={busy === r.reportId} onClick={() => void handle(r.reportId, 'dismiss')} style={{ ...buttonStyle, background: 'var(--md-sys-color-on-surface-variant)' }}>
                    驳回
                  </button>
                  <button type="button" disabled={busy === r.reportId} onClick={() => void handle(r.reportId, 'request_evidence')} style={{ ...buttonStyle, background: 'var(--warn-ink)' }}>
                    要求补充证据
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
