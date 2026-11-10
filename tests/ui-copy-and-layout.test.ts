/**
 * 版式约定的"防回退"断言（2026-11-10 这一轮的主人要求）。
 *
 * 这三条都很难用行为测试覆盖（要么是纯样式，要么是服务端渲染的整页），
 * 但一旦被人改回去，界面会立刻变丑/变错，所以在源码层面钉住：
 *   1. 评测页标题靠左、不带箭头，页签切换只靠标题旁的说明胶囊；
 *   2. 手机抽屉的「站点」分组里，精选与讨论区排在测评规范之前；
 *   3. 讨论区分区用卡片网格，且那句啰嗦的权限说明已经从页面上删掉。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('评测页标题', () => {
  const css = read('src/app/globals.css');
  const component = read('src/components/reviews-tab-switch.tsx');

  it('标题靠左，不再居中', () => {
    expect(css).toMatch(/\.reviews-switch-head \{[^}]*justify-content: flex-start/);
  });

  it('标题里不再有 → / ← 箭头，只有页签名字', () => {
    // 注释里还会用「插件评测 → 整合包评测」说明方向，先剥掉注释再看代码本体
    const code = component.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toContain('reviews-switch-arrow');
    expect(code).not.toContain('→');
    expect(code).not.toContain('←');
  });
});

describe('手机抽屉的站点入口', () => {
  const drawer = read('src/components/site-drawer.tsx');

  it('精选与讨论区都排在测评规范之前', () => {
    const featured = drawer.indexOf('href="/featured"');
    const forum = drawer.indexOf('href="/forum"');
    const spec = drawer.indexOf('href="/spec"');
    expect(featured).toBeGreaterThan(0);
    expect(forum).toBeGreaterThan(0);
    expect(spec).toBeGreaterThan(0);
    expect(featured).toBeLessThan(spec);
    expect(forum).toBeLessThan(spec);
  });

  it('讨论区入口受总开关控制（关站时不出现）', () => {
    expect(drawer).toMatch(/forumEnabled \? \(/);
  });
});

describe('讨论区分区列表', () => {
  const page = read('src/app/forum/page.tsx');
  const css = read('src/app/globals.css');

  it('用 M3 卡片网格渲染分区，而不是长列表', () => {
    expect(page).toContain('forum-board-grid');
    expect(page).toContain('forum-board-card');
    expect(css).toMatch(/\.forum-board-grid \{[^}]*display: grid/);
    expect(css).toMatch(/\.forum-board-card \{[^}]*border-radius: var\(--md-sys-shape-corner-medium\)/);
  });

  it('页面上不再有「发帖需要登录；各分区的发帖权限由分区自行管理」这句', () => {
    expect(page).not.toContain('发帖需要登录');
    expect(page).toContain('聊插件、评测与整合包之外的一切。');
  });
});