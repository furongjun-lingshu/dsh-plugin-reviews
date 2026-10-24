'use client';

/**
 * 后台「分类管理」（迁移 0010）。
 *
 * 两个视图：
 *   1. **已有分类**：改名称、认领的 topics、排序、是否显示；可删；
 *   2. **待归类 topics**：线上真实 topics 按"覆盖多少不同仓库"排序列出，没被认领的高亮 ——
 *      运营照这个列表加分类，而不是凭空设计分类体系。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, ErrorNotice, apiFetch, buttonStyle, inputStyle } from './api-client';

interface CategoryRecord {
  slug: string;
  label: string;
  topics: string[];
  sortOrder: number;
  isVisible: boolean;
  repositoryCount: number;
  pluginCount: number;
  updatedAt: number;
}

interface TopicUsage {
  topic: string;
  repositoryCount: number;
  mapped: boolean;
}

interface CategoriesResponse {
  categories: CategoryRecord[];
  topics: TopicUsage[];
}

const emptyDraft = { slug: '', label: '', topics: '', sortOrder: '100', isVisible: true };

export function AdminCategoryPanel() {
  const [data, setData] = useState<CategoriesResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  /** 正在编辑的分类 slug（null = 新增模式）。 */
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiFetch<CategoriesResponse>('/api/admin/categories', { cache: 'no-store' }));
      setError(null);
    } catch (e) {
      setError(e as ApiError);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const unmapped = useMemo(() => (data?.topics ?? []).filter((t) => !t.mapped).slice(0, 40), [data]);

  const startEdit = (c: CategoryRecord) => {
    setEditing(c.slug);
    setDraft({
      slug: c.slug,
      label: c.label,
      topics: c.topics.join(', '),
      sortOrder: String(c.sortOrder),
      isVisible: c.isVisible,
    });
    setNotice(null);
  };

  const reset = () => {
    setEditing(null);
    setDraft(emptyDraft);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const topics = draft.topics
        .split(/[,，\s]+/)
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0);
      const sortOrder = Number(draft.sortOrder);
      const result = await apiFetch<{ category: CategoryRecord }>('/api/admin/categories', {
        method: 'POST',
        json: {
          slug: draft.slug.trim().toLowerCase(),
          label: draft.label.trim(),
          topics,
          sortOrder: Number.isInteger(sortOrder) ? sortOrder : 100,
          isVisible: draft.isVisible,
        },
      });
      setNotice(`已保存分类「${result.category.label}」（${result.category.topics.length} 个 topics）。`);
      reset();
      await load();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (slug: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/api/admin/categories?slug=${encodeURIComponent(slug)}`, { method: 'DELETE' });
      setNotice(`已删除分类 ${slug}。`);
      if (editing === slug) reset();
      await load();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  /** 把某个未归类 topic 塞进当前草稿的 topics 里（一键认领）。 */
  const claimTopic = (topic: string) => {
    const existing = draft.topics
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (existing.includes(topic)) return;
    setDraft({ ...draft, topics: [...existing, topic].join(', ') });
  };

  return (
    <section style={{ marginTop: 32, borderTop: '1px solid var(--md-sys-color-outline-variant)', paddingTop: 16 }}>
      <h2 style={{ fontSize: 18 }}>分类管理</h2>
      <p style={{ color: 'var(--md-sys-color-on-surface-variant)', fontSize: 14 }}>
        目录上的「用途分类」由这张表决定：一个分类认领若干 GitHub topics，命中即归入该分类。
        计数口径是<strong>不同仓库数</strong>（一个仓库拆成 11 个插件不会把分类放大 11 倍）。
        没有命中任何分类的插件显示为「未分类」。
      </p>

      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
      {notice ? <p style={{ color: 'var(--success-ink)', fontSize: 14 }}>{notice}</p> : null}

      {data === null ? (
        <p style={{ color: 'var(--md-sys-color-on-surface-variant)' }}>正在读取分类…</p>
      ) : (
        <>
          <h3 style={{ fontSize: 16, marginTop: 16 }}>已有分类（{data.categories.length}）</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--md-sys-color-on-surface-variant)' }}>
                <th style={{ padding: '6px 4px' }}>分类</th>
                <th style={{ padding: '6px 4px' }}>认领的 topics</th>
                <th style={{ padding: '6px 4px' }}>仓库 / 插件</th>
                <th style={{ padding: '6px 4px' }}>排序</th>
                <th style={{ padding: '6px 4px' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.categories.map((c) => (
                <tr key={c.slug} style={{ borderTop: '1px solid var(--md-sys-color-outline-variant)', verticalAlign: 'top' }}>
                  <td style={{ padding: '8px 4px' }}>
                    <div style={{ fontWeight: 600 }}>
                      {c.label}
                      {c.isVisible ? '' : '（隐藏）'}
                    </div>
                    <div style={{ color: 'var(--warn-ink)', fontSize: 12 }}>{c.slug}</div>
                  </td>
                  <td style={{ padding: '8px 4px', maxWidth: 420, color: 'var(--md-sys-color-on-surface-variant)' }}>
                    {c.topics.join(' · ') || '（空）'}
                  </td>
                  <td style={{ padding: '8px 4px', whiteSpace: 'nowrap' }}>
                    {c.repositoryCount} / {c.pluginCount}
                  </td>
                  <td style={{ padding: '8px 4px' }}>{c.sortOrder}</td>
                  <td style={{ padding: '8px 4px', whiteSpace: 'nowrap' }}>
                    <button
                      type="button"
                      onClick={() => startEdit(c)}
                      style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 13, marginRight: 10 }}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void remove(c.slug)}
                      style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', padding: 0, fontSize: 13 }}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 style={{ fontSize: 16, marginTop: 24 }}>
            {editing ? `编辑分类 ${editing}` : '新增分类'}
          </h3>
          <div style={{ display: 'grid', gap: 8, maxWidth: 760 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                aria-label="分类标识（slug）"
                placeholder="标识，如 memory（2–32 位小写字母/数字/连字符）"
                value={draft.slug}
                onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
                style={{ ...inputStyle, flex: '1 1 260px' }}
              />
              <input
                aria-label="分类名称"
                placeholder="名称，如 记忆与知识（≤20 字）"
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                style={{ ...inputStyle, flex: '1 1 220px' }}
              />
            </div>
            <input
              aria-label="认领的 topics"
              placeholder="认领的 topics，用逗号或空格分隔（小写），如 memory, rag, knowledge-graph"
              value={draft.topics}
              onChange={(e) => setDraft({ ...draft, topics: e.target.value })}
              style={inputStyle}
            />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                aria-label="排序"
                placeholder="排序（0–9999，越小越靠前）"
                value={draft.sortOrder}
                onChange={(e) => setDraft({ ...draft, sortOrder: e.target.value })}
                style={{ ...inputStyle, width: 180 }}
              />
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', color: 'var(--md-sys-color-on-surface-variant)', fontSize: 14 }}>
                <input
                  type="checkbox"
                  checked={draft.isVisible}
                  onChange={(e) => setDraft({ ...draft, isVisible: e.target.checked })}
                />
                在目录显示
              </label>
              <button
                type="button"
                disabled={busy || draft.slug.trim() === '' || draft.label.trim() === ''}
                onClick={() => void save()}
                style={buttonStyle}
              >
                {busy ? '保存中…' : editing ? '保存修改' : '新增分类'}
              </button>
              {editing ? (
                <button type="button" onClick={reset} style={{ ...buttonStyle, background: 'var(--md-sys-color-on-surface-variant)' }}>
                  取消
                </button>
              ) : null}
            </div>
          </div>

          <h3 style={{ fontSize: 16, marginTop: 24 }}>待归类 topics（按覆盖仓库数）</h3>
          <p style={{ color: 'var(--md-sys-color-on-surface-variant)', fontSize: 13, marginTop: 0 }}>
            这些 topics 还没被任何分类认领；点一下就加进上面的草稿。
          </p>
          {unmapped.length === 0 ? (
            <p style={{ color: 'var(--md-sys-color-on-surface-variant)', fontSize: 14 }}>没有未归类的 topics（或全部已归类）。</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {unmapped.map((t) => (
                <li key={t.topic}>
                  <button
                    type="button"
                    onClick={() => claimTopic(t.topic)}
                    title={`覆盖 ${t.repositoryCount} 个仓库 · 点击加入草稿`}
                    style={{
                      background: 'var(--md-sys-color-surface-container-lowest)',
                      border: '1px solid var(--md-sys-color-outline-variant)',
                      borderRadius: 6,
                      padding: '4px 10px',
                      cursor: 'pointer',
                      color: 'var(--md-sys-color-on-surface-variant)',
                      fontSize: 13,
                    }}
                  >
                    {t.topic} <strong>{t.repositoryCount}</strong>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
