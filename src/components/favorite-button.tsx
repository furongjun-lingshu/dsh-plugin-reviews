'use client';

/**
 * 收藏按钮：点击后弹出收藏夹选择（类似 B 站）。
 *
 * - 首次收藏自动创建「默认收藏夹」，选择器初始选中它；
 * - 选择器里可以新建收藏夹；
 * - 已收藏时显示当前所在夹，可移动或取消收藏。
 */

import { useState } from 'react';
import { ApiError, ErrorNotice, apiFetch } from './api-client';

interface Folder {
  folderId: string;
  name: string;
  isDefault: boolean;
  count: number;
}

export function FavoriteButton({
  pluginId,
  initialFavorited,
  authenticated,
}: {
  pluginId: string;
  initialFavorited: boolean;
  authenticated: boolean;
}) {
  const [favorited, setFavorited] = useState(initialFavorited);
  const [open, setOpen] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const loadFolders = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await apiFetch<{ folders: Folder[] }>('/api/me/favorites/folders');
      setFolders(data.folders);
      const fallback = data.folders.find((f) => f.isDefault)?.folderId ?? data.folders[0]?.folderId ?? null;
      setSelected(fallback);

      // 已收藏：选中当前所在收藏夹（接口会返回 folderId）。
      const mine = await apiFetch<{ plugins: { pluginId: string; folderId: string }[] }>('/api/me/favorites');
      const hit = mine.plugins.find((p) => p.pluginId === pluginId);
      if (hit?.folderId) setSelected(hit.folderId);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const openPicker = async () => {
    if (!authenticated) return;
    setOpen(true);
    await loadFolders();
  };

  const createFolder = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const folder = await apiFetch<Folder>('/api/me/favorites/folders', {
        method: 'POST',
        json: { name },
      });
      setFolders((prev) => [...prev, folder]);
      setSelected(folder.folderId);
      setNewName('');
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/api/me/favorites', {
        method: 'POST',
        json: { kind: 'plugin', targetId: pluginId, folderId: selected },
      });
      setFavorited(true);
      setOpen(false);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/me/favorites?pluginId=${encodeURIComponent(pluginId)}`, { method: 'DELETE' });
      setFavorited(false);
      setOpen(false);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        onClick={() => void openPicker()}
        disabled={busy || !authenticated}
        title={authenticated ? '收藏这个插件，可选择收藏夹' : '登录后可以收藏'}
        aria-pressed={favorited}
        style={{
          background: favorited ? 'var(--md-sys-color-primary)' : 'transparent',
          color: favorited ? 'var(--md-sys-color-on-primary)' : 'var(--accent)',
          border: `1px solid ${
            favorited ? 'var(--md-sys-color-primary)' : 'var(--md-sys-color-outline-variant)'
          }`,
          borderRadius: 999,
          padding: '3px 12px',
          cursor: authenticated ? 'pointer' : 'not-allowed',
          fontSize: 13,
        }}
      >
        {favorited ? '★ 已收藏' : '☆ 收藏'}
      </button>

      {open ? (
        <div
          className="panel"
          role="dialog"
          aria-label="选择收藏夹"
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 6,
            minWidth: 260,
            zIndex: 30,
            background: 'var(--surface)',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8 }}>收藏到哪个收藏夹？</div>
          {folders.map((f) => (
            <label
              key={f.folderId}
              style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, fontSize: 13 }}
            >
              <input
                type="radio"
                name="favorite-folder"
                checked={selected === f.folderId}
                onChange={() => setSelected(f.folderId)}
              />
              <span>{f.name}</span>
              {f.isDefault ? <span className="muted">（默认）</span> : null}
              <span className="muted">· {f.count}</span>
            </label>
          ))}

          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <input
              type="text"
              value={newName}
              maxLength={40}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="新建收藏夹"
              style={{ flex: 1, minWidth: 0 }}
            />
            <button
              type="button"
              className="button"
              disabled={busy || newName.trim() === ''}
              onClick={() => void createFolder()}
            >
              新建
            </button>
          </div>

          <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="button primary"
              disabled={busy || !selected}
              onClick={() => void save()}
            >
              确定收藏
            </button>
            {favorited ? (
              <button type="button" className="button" disabled={busy} onClick={() => void remove()}>
                取消收藏
              </button>
            ) : null}
            <button type="button" className="link-btn" onClick={() => setOpen(false)}>
              关闭
            </button>
          </div>

          {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
        </div>
      ) : null}
    </span>
  );
}
