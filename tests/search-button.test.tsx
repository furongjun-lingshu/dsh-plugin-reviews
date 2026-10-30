/**
 * 搜索按钮形态统一：全站搜索动作都用放大镜图标按钮（.search-go），不再有文字按钮。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

const SEARCH_PAGES = [
  'src/app/page.tsx',
  'src/app/plugins/page.tsx',
  'src/app/reviews/page.tsx',
  'src/app/packs/page.tsx',
  'src/app/me/page.tsx',
  'src/app/me/favorites/page.tsx',
  'src/app/me/drafts/[draftId]/choose-plugin/page.tsx',
];

describe('搜索按钮形态', () => {
  it('每一处搜索都用放大镜按钮组件或 .search-go，不再出现文字按钮', () => {
    for (const page of SEARCH_PAGES) {
      const source = read(page);
      const hasMagnifier =
        source.includes('<SearchGoButton') || source.includes('className="search-go"');
      expect(hasMagnifier, page + ' 应该有放大镜搜索按钮').toBe(true);
      // 「搜索」两个字不再作为按钮文字（placeholder / aria-label 里出现是正常的）
      expect(source, page + ' 不应再有文字搜索按钮').not.toMatch(
        /<button[^>]*className="search-go"[^>]*>\s*搜索\s*<\/button>/,
      );
    }
  });

  it('放搜索框的表单统一用 .search 容器（与图标按钮同一行）', () => {
    for (const page of SEARCH_PAGES) {
      const source = read(page);
      // 允许 `className="search"` 与 `className="search home-search"` 这类组合
      expect(source, page + ' 的搜索表单应使用 .search 容器').toMatch(/className="[^"]*\bsearch\b[^"]*"/);
    }
    // 选插件页此前用 .filters 容器（搜索框与筛选混排），已统一为 .search
    expect(read('src/app/me/drafts/[draftId]/choose-plugin/page.tsx')).toContain(
      'className="search" style={{ marginTop: 12 }}',
    );
  });

  it('label.button 覆盖全局 label 的 display:block，保证文件选择按钮文字居中', () => {
    const css = read('src/app/globals.css');
    expect(css).toMatch(/label\.button\s*\{[\s\S]*?display:\s*inline-flex/);
    expect(css).toMatch(/label\.button\s*\{[\s\S]*?align-items:\s*center/);
    expect(css).toMatch(/label\.button\s*>[\s\S]*?input\[type='file'\][\s\S]*?display:\s*none/);
  });
});
