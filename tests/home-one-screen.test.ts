/**
 * 桌面首页「一屏不滚动 + 铺满视口」的不变量。
 *
 * 首页没有滚动容器、条目高度固定，所以"一屏"是靠两件事一起做的：
 *   1. 主区/左右两栏做成一条 flex 链，并且主区给**确定高度 100vh**
 *      （只给 min-height 的话内容会把主区撑高，面板永远压不回视口内 —— 真踩过）；
 *   2. 屏高不够时按档位少放几条（`nth-child(n + N)` 隐藏）。
 *
 * 这里不钉具体阈值（阈值随行高/间距调整会重算），只钉**结构性**的东西：
 * 阈值必须是递增的一组、条数上限是 12、以及那条 flex 链不能被人删掉。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

/** 取出所有"宽屏"档位：`(min-width: 901px) and (max-height: Npx)` → nth-child(n + K)。 */
function tiers(pattern: RegExp): Array<{ height: number; limit: number }> {
  const found: Array<{ height: number; limit: number }> = [];
  for (const match of css.matchAll(pattern)) {
    found.push({ height: Number(match[1]), limit: Number(match[2]) });
  }
  return found;
}

const wideTiers = tiers(
  /@media \(min-width: 901px\) and \(max-height: (\d+)px\) \{\s*\.home-page \.home-feed section \.item-list > \.item:nth-child\(n \+ (\d+)\)/g,
);

describe('桌面首页一屏', () => {
  it('至少 9 档，条数上限是 12 条，且屏高越高放得越多', () => {
    expect(wideTiers.length).toBeGreaterThanOrEqual(9);
    expect(Math.max(...wideTiers.map((t) => t.limit))).toBe(12);
    // 阈值随条数递增：屏高越高，放得越多（sorted 是升序，所以 limit 也要升）
    const sorted = [...wideTiers].sort((a, b) => a.height - b.height);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].limit).toBeGreaterThan(sorted[i - 1].limit);
    }
    // 最低一档至少还留 4 条（再矮就交给"矮窗口"那组）
    expect(Math.min(...wideTiers.map((t) => t.limit))).toBeLessThanOrEqual(4);
  });

  it('窄屏（≤1140）单独一套阈值：分类 chip 折行会多占高度', () => {
    expect(css).toMatch(/max-width: 1140px\) and \(max-height: \d+px\)/);
  });

  it('矮窗口（≤840）收紧英雄区，且 chip 到面板仍留 24px', () => {
    expect(css).toMatch(/max-height: 840px\)[\s\S]{0,400}?\.home-title/);
    expect(css).toMatch(/max-height: 840px\)[\s\S]{0,600}?padding-bottom: 24px/);
  });

  it('主区给确定高度：只写 min-height 的话面板压不回视口', () => {
    expect(css).toMatch(/\.site-main:has\(\.home-page\) \{[^}]*height: 100vh/);
  });

  it('flex 链三层都通（wrap / feed / twocol），twocol 的单行用 minmax(0, 1fr)', () => {
    expect(css).toMatch(/\.home-page \.home-feed-wrap,\s*\n\s*\.home-page \.home-feed \{[^}]*flex: 1 1 auto/);
    expect(css).toMatch(/\.home-page \.home-feed \.twocol \{[^}]*grid-template-rows: minmax\(0, 1fr\)/);
  });

  it('两栏的按钮都贴底（左栏也要），条目均分剩余高度', () => {
    expect(css).toMatch(/\.home-page \.home-feed \.home-more \{[^}]*margin-top: auto/);
    expect(css).toMatch(/\.home-page \.home-feed section \.item-list > \.item \{[^}]*flex: 1 1 auto/);
  });
});