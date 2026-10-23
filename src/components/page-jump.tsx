'use client';

/**
 * 页码跳转：输入页码 + 「跳转」按钮（在「下一页」左侧）。
 *
 * 与旧版（双击页码、clamp 到总页数）的区别：
 *  - 显式的输入框 + 按钮，用户不用猜双击；
 *  - **不 clamp**：越界页照常导航，由服务端显示「您输入的页面不存在」；
 *  - 非数字 / 小于 1 在客户端拦下并提示，不发请求。
 *
 * 链接由服务端给一个带 `__PAGE__` 占位符的模板（保留当前筛选条件），
 * 客户端只替换页码，不重新拼查询串。
 */

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

/** 占位符不能用 `{page}`：URLSearchParams 会把花括号编码成 %7B%7D。 */
const PAGE_PLACEHOLDER = '__PAGE__';

export function PageJump({
  page,
  totalPages,
  hrefTemplate,
}: {
  page: number;
  totalPages: number;
  /** 站内路径，含 `__PAGE__` 占位符；例如 `/reviews?q=x&page=__PAGE__` */
  hrefTemplate: string;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(String(page));
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = Number.parseInt(draft, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      setError('请输入有效页码');
      return;
    }
    setError(null);
    router.push(hrefTemplate.replace(PAGE_PLACEHOLDER, String(parsed)));
  };

  return (
    <form
      onSubmit={submit}
      style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}
    >
      <label htmlFor={`page-jump-${page}`} className="muted" style={{ fontSize: 13 }}>
        跳转到
      </label>
      <input
        id={`page-jump-${page}`}
        className="page-jump-input"
        type="number"
        inputMode="numeric"
        value={draft}
        aria-label={`输入页码（共 ${totalPages} 页）`}
        onChange={(event) => setDraft(event.target.value)}
        style={{ width: 72 }}
      />
      <span className="muted" style={{ fontSize: 13 }}>
        页
      </span>
      <button type="submit" className="button">
        跳转
      </button>
      {error ? (
        <span role="alert" style={{ fontSize: 12, color: 'var(--md-sys-color-error, #b3261e)' }}>
          {error}
        </span>
      ) : null}
    </form>
  );
}
