/**
 * 批量导入 .md 的本地图片匹配（纯函数）。
 *
 * 每个用例都对应一个会被破坏的行为：
 *  - 去掉首层目录 / 按 md 目录解析 → 三种相对写法用例红；
 *  - basename 回退 → 回退用例红；同名歧义 → 歧义用例红；
 *  - 外链判定 → 外链用例红（否则会把 https 图片当本地图去上传）；
 *  - 只替换有映射的引用 → 外链/未匹配保持原样用例红；
 *  - 跳过代码块 → 代码块用例红（否则示例代码被改掉）。
 */

import { describe, expect, it } from 'vitest';
import {
  applyImageReplacements,
  buildImageIndex,
  collectImageRefs,
  isExternalImageUrl,
  resolveImageReference,
  stripCollectionRoot,
} from '../src/packages/common/md-images';

const index = buildImageIndex([
  { path: '综述合集/images/a.png' },
  { path: '综述合集/images/b.PNG' },
  { path: '综述合集/图.png' },
  { path: '综述合集/子目录/c.webp' },
  { path: '综述合集/images/my pic.png' },
]);

function md(lines: string[]): string {
  return lines.join('\n');
}

describe('去掉选择目录的第一层目录', () => {
  it('剥掉根目录名；单文件（无目录）原样返回；反斜杠也归一化', () => {
    expect(stripCollectionRoot('综述合集/images/a.png')).toBe('images/a.png');
    expect(stripCollectionRoot('a.png')).toBe('a.png');
    expect(stripCollectionRoot('综述合集\\images\\a.png')).toBe('images/a.png');
  });
});

describe('相对路径解析（三种写法）', () => {
  const article = '综述合集/综述.md';

  it('./images/a.png 命中', () => {
    expect(resolveImageReference('./images/a.png', article, index)).toBe('images/a.png');
  });

  it('images/a.png（无 ./ 前缀）命中', () => {
    expect(resolveImageReference('images/a.png', article, index)).toBe('images/a.png');
  });

  it('../images/a.png（根目录下越界被钳住）命中', () => {
    expect(resolveImageReference('../images/a.png', article, index)).toBe('images/a.png');
  });

  it('子目录里的 md 用 ../ 指向父目录图片也命中', () => {
    const nested = '综述合集/子目录/笔记.md';
    expect(resolveImageReference('../images/a.png', nested, index)).toBe('images/a.png');
    expect(resolveImageReference('./c.webp', nested, index)).toBe('子目录/c.webp');
  });

  it('大小写不同也命中，回写真实路径（Windows 作者常见）', () => {
    expect(resolveImageReference('./images/A.PNG', article, index)).toBe('images/a.png');
  });

  it('query / hash 不影响匹配', () => {
    expect(resolveImageReference('./images/a.png?raw=1', article, index)).toBe('images/a.png');
    expect(resolveImageReference('./images/a.png#preview', article, index)).toBe('images/a.png');
  });

  it('URL 编码的中文文件名会先解码再匹配', () => {
    expect(resolveImageReference('./images/%E5%9B%BE.png', article, index)).toBe('图.png');
  });
});

describe('basename 回退与歧义', () => {
  it('路径对不上但文件名唯一时按 basename 命中', () => {
    const article = '综述合集/其他/笔记.md';
    expect(resolveImageReference('./assets/a.png', article, index)).toBe('images/a.png');
  });

  it('同名文件分布在两个目录时不做猜测（返回 null）', () => {
    const ambiguous = buildImageIndex([
      { path: 'root/x/logo.png' },
      { path: 'root/y/logo.png' },
    ]);
    expect(ambiguous.byBasename.get('logo.png')).toBeNull();
    expect(resolveImageReference('./logo.png', 'root/笔记.md', ambiguous)).toBeNull();
  });
});

describe('外链 / 站内绝对地址不参与本地匹配', () => {
  it('isExternalImageUrl 认协议、协议相对、站内绝对路径与锚点', () => {
    expect(isExternalImageUrl('https://example.com/a.png')).toBe(true);
    expect(isExternalImageUrl('http://example.com/a.png')).toBe(true);
    expect(isExternalImageUrl('//cdn.example.com/a.png')).toBe(true);
    expect(isExternalImageUrl('/media/01920000-0000-7000-8000-0000000000aa/DISPLAY')).toBe(true);
    expect(isExternalImageUrl('data:image/png;base64,AAAA')).toBe(true);
    expect(isExternalImageUrl('#preview')).toBe(true);
    expect(isExternalImageUrl('./images/a.png')).toBe(false);
    expect(isExternalImageUrl('images/a.png')).toBe(false);
  });

  it('https 引用不当作本地文件', () => {
    expect(resolveImageReference('https://example.com/images/a.png', '综述合集/综述.md', index)).toBeNull();
  });
});

describe('替换正文里的引用', () => {
  it('无图片时原样返回（不重建正文）', () => {
    const source = '只有文字，没有图片。';
    const result = applyImageReplacements(source, new Map());
    expect(result.markdown).toBe(source);
    expect(result.replaced).toBe(0);
  });

  it('只替换有映射的引用，http(s) 外链与未匹配引用保持原样', () => {
    const source = md([
      '![本地](./images/a.png)',
      '![外链](https://example.com/a.png)',
      '![没匹配](./images/missing.png)',
    ]);
    const result = applyImageReplacements(
      source,
      new Map([['./images/a.png', '/media/att-1/DISPLAY']]),
    );
    expect(result.replaced).toBe(1);
    expect(result.markdown).toContain('![本地](/media/att-1/DISPLAY)');
    expect(result.markdown).toContain('![外链](https://example.com/a.png)');
    expect(result.markdown).toContain('![没匹配](./images/missing.png)');
  });

  it('保留标题与 alt', () => {
    const result = applyImageReplacements(
      '![截图](./images/a.png "首页截图")',
      new Map([['./images/a.png', '/media/att-1/DISPLAY']]),
    );
    expect(result.markdown).toBe('![截图](/media/att-1/DISPLAY "首页截图")');
  });

  it('同一引用出现多次时全部替换', () => {
    const source = md(['![一](./images/a.png)', '![二](./images/a.png)']);
    const result = applyImageReplacements(source, new Map([['./images/a.png', '/media/att-1/DISPLAY']]));
    expect(result.replaced).toBe(2);
    expect(result.markdown.match(/\/media\/att-1\/DISPLAY/g)?.length).toBe(2);
  });

  it('代码块与行内代码里的图片语法不替换', () => {
    const source = md([
      '正文 ![](./images/a.png)',
      '',
      '示例：',
      '',
      '```md',
      '![](./images/a.png)',
      '```',
      '',
      '行内 `![](./images/a.png)` 也不动。',
    ]);
    const result = applyImageReplacements(source, new Map([['./images/a.png', '/media/att-1/DISPLAY']]));
    expect(result.replaced).toBe(1);
    expect(result.markdown).toContain('```md\n![](./images/a.png)');
    expect(result.markdown).toContain('行内 `![](./images/a.png)` 也不动。');
  });

  it('尖括号包裹的地址（含空格）替换后仍合法', () => {
    const source = '![图](<./images/my pic.png>)';
    const result = applyImageReplacements(
      source,
      new Map([['./images/my pic.png', '/media/att-1/DISPLAY']]),
    );
    expect(result.markdown).toBe('![图](</media/att-1/DISPLAY>)');
  });

  it('collectImageRefs 给出原文位置与 alt，不把普通链接当图片', () => {
    const source = '开头 ![图](./images/a.png) 与 [链接](https://example.com)';
    const refs = collectImageRefs(source);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.alt).toBe('图');
    expect(source.slice(refs[0]?.start ?? 0, refs[0]?.end ?? 0)).toBe('![图](./images/a.png)');
  });
});
