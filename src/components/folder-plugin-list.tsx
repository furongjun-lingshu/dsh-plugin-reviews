'use client';

/**
 * 收藏夹内插件列表：多选 + 批量取消收藏 / 批量移动到其它收藏夹。
 *
 * 只操作本人收藏；移动目标只列「除当前夹以外」的收藏夹。
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, apiFetch } from './api-client';

interface PluginItem {
  pluginId: string;
  displayName: string | null;
  repositoryFullName: string;
  pluginPath: string;
  isArchived: boolean;
}

interface FolderOption {
  folderId: string;
  name: string;
}

export function FolderPluginList({
  plugins,
  folders,
  currentFolderId,
}: {
  plugins: PluginItem[];
  folders: FolderOption[];
  currentFolderId: string;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [targetFolderId, setTargetFolderId] = useState(
    folders.find((f) => f.folderId !== currentFolderId)?.folderId ?? '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const targets = folders.filter((f) => f.folderId !== currentFolderId);
  const allSelected = plugins.length > 0 && plugins.every((p) => selected.has(p.pluginId));
  const count = selected.size;

  const toggle = (id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const run = async (action: 'remove' | 'move') => {
    if (busy || count === 0) return;
    if (action === 'move' && !targetFolderId) return;
    const message =
      action === 'remove'
        ? `将取消收藏 ${count} 个插件（从所有收藏夹移除）。继续？`
        : `将把 ${count} 个插件移动到「${targets.find((f) => f.folderId === targetFolderId)?.name ?? '目标夹'}」。继续？`;
    if (!window.confirm(message)) return;

    setBusy(true);
    setError(null);
    try {
      await apiFetch('/api/me/favorites/batch', {
        method: 'POST',
        json: {
          action,
          pluginIds: [...selected],
          folderId: action === 'move' ? targetFolderId : undefined,
        },
      });
      setSelected(new Set());
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={allSelected}
            onChange={(e) =>
              setSelected(e.target.checked ? new Set(plugins.map((p) => p.pluginId)) : new Set())
            }
          />
          全选
        </label>
        <button
          type="button"
          className="button"
          disabled={busy || count === 0}
          onClick={() => void run('remove')}
        >
          {busy ? '处理中…' : `取消收藏${count > 0 ? `（${count}）` : ''}`}
        </button>
        <select
          value={targetFolderId}
          onChange={(e) => setTargetFolderId(e.target.value)}
          disabled={busy || targets.length === 0}
          aria-label="移动到收藏夹"
        >
          {targets.length === 0 ? <option value="">没有其它收藏夹</option> : null}
          {targets.map((f) => (
            <option key={f.folderId} value={f.folderId}>
              {f.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="button"
          disabled={busy || count === 0 || !targetFolderId}
          onClick={() => void run('move')}
        >
          {busy ? '处理中…' : `移动${count > 0 ? `（${count}）` : ''}`}
        </button>
      </div>

      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}

      <ul className="item-list">
        {plugins.map((p) => (
          <li key={p.pluginId} className="item">
            <label style={{ marginRight: 10, alignSelf: 'flex-start', marginTop: 4 }}>
              <input
                type="checkbox"
                checked={selected.has(p.pluginId)}
                onChange={(e) => toggle(p.pluginId, e.target.checked)}
                aria-label={`选择 ${p.displayName ?? p.repositoryFullName}`}
              />
            </label>
            <div className="item-body">
              <h3>
                <Link href={`/plugins/${p.pluginId}`}>{p.displayName ?? p.repositoryFullName}</Link>
                {p.pluginPath !== '.' ? <span className="muted"> · {p.pluginPath}</span> : null}
              </h3>
              <div className="list-meta">
                <span>{p.repositoryFullName}</span>
                {p.isArchived ? <span className="tag warn">已归档</span> : null}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
