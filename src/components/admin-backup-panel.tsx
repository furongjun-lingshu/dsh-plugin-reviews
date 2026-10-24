'use client';

/**
 * 后台「存储与备份」组（`参数与管理规则.md §81`）。
 *
 * 目标只有两个：**看得见**（最近什么时候成功备份过、里面有几条数据）与**点一下就有**。
 * 恢复不在这里做：恢复要在维护窗口里执行命令（`scripts/restore-backup.mjs`），
 * 给它一个网页按钮只会让"手滑覆盖线上库"变得太容易。
 */

import { useCallback, useEffect, useState } from 'react';
import { formatDateTime } from '@/packages/common/time';
import { ApiError, ErrorNotice, apiFetch, buttonStyle } from './api-client';

interface BackupSummary {
  dirName: string;
  createdAt: string | null;
  label: string | null;
  schemaVersion: string | null;
  counts: Record<string, number | null>;
  dbBytes: number | null;
  integrity: string | null;
  integrityOk: boolean | null;
  hasMedia: boolean;
}

interface BackupsResponse {
  backupRoot: string;
  keep: number;
  backups: BackupSummary[];
  lastBackupAt: string | null;
}

function kb(bytes: number | null): string {
  if (bytes === null) return '—';
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

export function AdminBackupPanel() {
  const [data, setData] = useState<BackupsResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await apiFetch<BackupsResponse>('/api/admin/backups', { cache: 'no-store' }));
      setError(null);
    } catch (e) {
      setError(e as ApiError);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runBackup = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await apiFetch<{ ok: boolean; dir: string; counts: Record<string, number>; durationMs: number }>(
        '/api/admin/backups',
        { method: 'POST' },
      );
      setNotice(
        result.ok
          ? `备份完成（${result.durationMs} ms）：${Object.entries(result.counts)
              .map(([k, v]) => `${k}=${v}`)
              .join(' ')}`
          : '备份已生成，但**自检不通过**——请立刻看服务端日志，别把它当可恢复备份。',
      );
      await load();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={{ marginTop: 32, borderTop: '1px solid var(--md-sys-color-outline-variant)', paddingTop: 16 }}>
      <h2 style={{ fontSize: 18 }}>存储与备份</h2>
      <p style={{ color: 'var(--md-sys-color-on-surface-variant)', fontSize: 14 }}>
        每日 03:00（Asia/Shanghai）自动生成一个完整恢复点（库 + 媒体 + 清单），保留最近若干份。
        恢复请在维护窗口执行 <code>node scripts/restore-backup.mjs --latest --force</code>（会先校验 sha256 与完整性，再覆盖）。
      </p>

      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
      {notice ? <p style={{ color: 'var(--success-ink)', fontSize: 14 }}>{notice}</p> : null}

      {data === null ? (
        <p style={{ color: 'var(--md-sys-color-on-surface-variant)' }}>正在读取备份清单…</p>
      ) : (
        <>
          <div style={{ fontSize: 14, color: 'var(--md-sys-color-on-surface-variant)' }}>
            落点 <code>{data.backupRoot}</code> · 保留 {data.keep} 份 · 最近一次{' '}
            <strong>{data.lastBackupAt ? formatDateTime(Date.parse(data.lastBackupAt)) : '（还没有）'}</strong>
          </div>

          <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" disabled={busy} onClick={() => void runBackup()} style={buttonStyle}>
              {busy ? '备份中…' : '立即备份'}
            </button>
            <button type="button" onClick={() => void load()} style={{ ...buttonStyle, background: 'var(--md-sys-color-on-surface-variant)' }}>
              刷新
            </button>
          </div>

          <h3 style={{ fontSize: 16, marginTop: 20 }}>最近 {data.backups.length} 份</h3>
          {data.backups.length === 0 ? (
            <p style={{ color: 'var(--md-sys-color-on-surface-variant)', fontSize: 14 }}>还没有任何备份。建议现在点一次「立即备份」。</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {data.backups.map((b) => (
                <li
                  key={b.dirName}
                  style={{ border: '1px solid var(--md-sys-color-outline-variant)', borderRadius: 8, padding: 12, marginBottom: 10, fontSize: 14 }}
                >
                  <div>
                    <strong>{b.label ?? 'unknown'}</strong>
                    <span style={{ color: 'var(--md-sys-color-on-surface-variant)' }}>
                      {' · '}
                      {b.createdAt ? formatDateTime(Date.parse(b.createdAt)) : b.dirName}
                      {' · '}
                      {kb(b.dbBytes)}
                      {b.hasMedia ? ' · 含媒体' : ''}
                    </span>
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: 12,
                        color: b.integrityOk ? 'var(--success-ink)' : 'var(--danger)',
                      }}
                    >
                      {b.integrityOk ? `完整性 ${b.integrity}` : `完整性异常：${b.integrity ?? '未知'}`}
                    </span>
                  </div>
                  <div style={{ color: 'var(--md-sys-color-on-surface-variant)', marginTop: 4 }}>
                    schema {b.schemaVersion ?? '—'} ·{' '}
                    {Object.entries(b.counts)
                      .map(([k, v]) => `${k}=${v ?? '—'}`)
                      .join(' ')}
                  </div>
                  <div style={{ color: 'var(--warn-ink)', fontSize: 13, marginTop: 2 }}>
                    <code>{b.dirName}</code>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
