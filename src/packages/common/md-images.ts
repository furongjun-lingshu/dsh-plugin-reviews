/**
 * 批量导入 .md 时的本地图片匹配（纯函数，无 DOM / 无网络）。
 *
 * 输入是浏览器目录选择拿到的文件清单（`webkitRelativePath` 形如 `综述/images/a.png`）
 * 和一篇 .md 的正文；输出是「这条 Markdown 图片引用对应哪个本地文件」以及「把引用
 * 换成站内地址后的正文」。上传本身不在这里做（组件里调用草稿附件接口）。
 *
 * 两个索引键（需求：去掉第一层目录后的相对路径 + basename）：
 *  - 第一个键解决「不同 md 在同一父目录」：选择目录会带一层根目录名，先把根目录剥掉，
 *    再把引用按 md 所在目录解析成同一坐标系里的路径；
 *  - basename 兜底解决「作者把图片放在别的子目录、但文件名唯一」的情况。
 *    同名文件有多个时**不猜**（置空），留给调用方报「未匹配」，避免把 A 图配到 B 文章。
 *
 * 明确不处理的边界（不用正则硬吃，写清楚）：
 *  - reference 风格图片 `![alt][id]`、脚注式定义：不识别，保持原样；
 *  - 原始 HTML `<img src="...">`：本站渲染管线默认丢弃原始 HTML，不处理；
 *  - URL 里未转义的圆括号 `![](a(1).png)`：Markdown 本身会截断，不猜；
 *  - 代码块 / 行内代码里的图片语法：识别时跳过（不替换示例代码）；
 *  - 反斜杠转义（`a\(1\).png`）：不还原转义，按字面匹配，未命中就保持原样；
 *  - 大小写：按不区分大小写匹配（Windows 作者常见），回写的是索引里的真实路径。
 */

/** 目录选择拿到的一个图片文件：path 用 webkitRelativePath（单文件选择时是文件名）。 */
export interface ImageFileEntry {
  path: string;
  name?: string;
}

/** 正文里的一条 Markdown 图片引用及其在原文中的位置。 */
export interface MarkdownImageRef {
  /** 完整原文（含 `![](...)`），用于核对。 */
  raw: string;
  /** alt 原文（不转义、不裁剪）。 */
  alt: string;
  /** 引用里的目标地址（已去掉 < > 包裹，未解码）。 */
  url: string;
  /** 目标地址后面的原文（含前导空白与可选标题），回写时原样拼回。 */
  titleSuffix: string;
  /** 原引用是否用 `<...>` 包住地址（地址含空格时必须这样写）。 */
  angleBracket: boolean;
  /** 在原文中的起止下标（左闭右开）。 */
  start: number;
  end: number;
}

/** 图片索引：值是「去掉第一层目录后的真实相对路径」。 */
export interface ImageIndex {
  /** lower(相对路径) → 真实相对路径。 */
  byPath: Map<string, string>;
  /** lower(basename) → 真实相对路径；同名多个时为 null（歧义，不猜）。 */
  byBasename: Map<string, string | null>;
}

const IMAGE_REF_RE = /!\[([^\]]*)\]\(([^)\n]*)\)/g;

/** 统一斜杠、去掉开头的 ./ 与多余的 /，保留大小写与 ..（交给解析阶段处理）。 */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * 去掉选择目录带来的第一层目录名。
 * `综述合集/images/a.png` → `images/a.png`；没有斜杠（单文件选择）时原样返回。
 */
export function stripCollectionRoot(path: string): string {
  const normalized = normalizePath(path);
  const slash = normalized.indexOf('/');
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

function dirnameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function basenameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

/** 解码 %XX（解码失败按原文处理；不把异常抛给批量导入流程）。 */
function decodeMaybe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 是否为「不该去本地文件里找」的引用：协议地址（http/https/data/blob/file…）、
 * 协议相对地址（//host）、站内绝对路径（/media/...）、纯锚点。
 */
export function isExternalImageUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed === '') return true;
  if (trimmed.startsWith('//')) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return true;
  if (trimmed.startsWith('/')) return true;
  if (trimmed.startsWith('#')) return true;
  return false;
}

/**
 * 建图片索引。同一个相对路径重复出现时保留第一个；同名不同路径时 basename 键置 null。
 */
export function buildImageIndex(
  entries: readonly ImageFileEntry[],
  /**
   * `stripRoot` 默认 true：浏览器 `webkitRelativePath` 带一层选择目录名，要去掉。
   * 服务端已经存的是**规范化后的相对路径**（首层已剥），必须传 false，否则会把
   * `images/a.png` 再削成 `a.png`，与正文引用对不上。
   */
  options: { stripRoot?: boolean } = {},
): ImageIndex {
  const byPath = new Map<string, string>();
  const byBasename = new Map<string, string | null>();
  const stripRoot = options.stripRoot !== false;

  for (const entry of entries) {
    const raw = entry.path !== '' ? entry.path : (entry.name ?? '');
    const stripped = stripRoot ? stripCollectionRoot(raw) : normalizePath(raw);
    if (stripped === '') continue;

    const pathKey = stripped.toLowerCase();
    if (!byPath.has(pathKey)) byPath.set(pathKey, stripped);

    const nameKey = basenameOf(stripped).toLowerCase();
    const existing = byBasename.get(nameKey);
    if (existing === undefined) {
      byBasename.set(nameKey, stripped);
    } else if (existing !== null && existing.toLowerCase() !== pathKey) {
      // 同名不同路径：歧义。宁可报未匹配，也不把别人的图配进来。
      byBasename.set(nameKey, null);
    }
  }

  return { byPath, byBasename };
}

/** 把 md 所在目录 + 相对引用拼成集合内的路径；`..` 超出根目录时钳在根上。 */
function resolveRelativePath(baseDir: string, reference: string): string {
  const segments = baseDir === '' ? [] : baseDir.split('/').filter((part) => part !== '');
  for (const part of reference.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.join('/');
}

/**
 * 把一条引用解析成索引里的本地图片路径；解析不到返回 null。
 *
 * markdownPath 传 .md 的 webkitRelativePath（或文件名），内部同样剥掉第一层目录，
 * 这样「选择根目录」和「单文件选择」得到的是同一套相对坐标。
 */
export function resolveImageReference(
  url: string,
  markdownPath: string,
  index: ImageIndex,
): string | null {
  if (isExternalImageUrl(url)) return null;

  // 去掉 query / hash（`a.png?v=2`、`a.png#x` 仍然指向同一个文件）。
  const withoutFragment = url.trim().split('#')[0] ?? '';
  const withoutQuery = withoutFragment.split('?')[0] ?? '';
  const decoded = decodeMaybe(withoutQuery).replace(/\\/g, '/');
  if (decoded === '') return null;

  const mdPath = stripCollectionRoot(markdownPath);
  const resolved = resolveRelativePath(dirnameOf(mdPath), decoded);
  if (resolved === '') return null;

  const direct = index.byPath.get(resolved.toLowerCase());
  if (direct !== undefined) return direct;

  // basename 回退：只对唯一文件名生效；歧义（null）与没找到都返回 null。
  return index.byBasename.get(basenameOf(resolved).toLowerCase()) ?? null;
}

/**
 * 把代码块与行内代码替换成等长空格（保留下标），这样后面的引用扫描不会命中示例代码。
 *
 * 围栏代码块按行识别（三个反引号或三个波浪线，允许 0-3 个前导空格）；行内代码按
 * 反引号串长度配对。这是「够用」的实现，不是完整 CommonMark 解析：缩进 4 空格代码块
 * 不屏蔽（批量导入的作者稿里极少见，真出现时引用会按普通文本处理，不会误删内容）。
 */
function maskCodeRegions(markdown: string): string {
  const chars = markdown.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) chars[i] = ' ';
  };

  let cursor = 0;
  let fence: { char: string; length: number } | null = null;
  while (cursor < markdown.length) {
    const newline = markdown.indexOf('\n', cursor);
    const lineEnd = newline === -1 ? markdown.length : newline;
    const line = markdown.slice(cursor, lineEnd);

    if (fence) {
      blank(cursor, lineEnd);
      const escapedChar = fence.char === '`' ? '\\`' : '~';
      const close = new RegExp('^ {0,3}' + escapedChar + '{' + fence.length + ',}\\s*$').test(line);
      if (close) fence = null;
    } else {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (open !== null) {
        const marker = open[1] ?? '';
        fence = { char: marker.charAt(0), length: marker.length };
        blank(cursor, lineEnd);
      }
    }
    cursor = lineEnd + 1;
  }

  // 行内代码：按反引号串长度找配对，配对成功就整段屏蔽。
  let i = 0;
  while (i < chars.length) {
    if (chars[i] !== '`') {
      i += 1;
      continue;
    }
    let openRun = 1;
    while (chars[i + openRun] === '`') openRun += 1;
    let j = i + openRun;
    let closed = false;
    while (j < chars.length) {
      if (chars[j] !== '`') {
        j += 1;
        continue;
      }
      let closeRun = 1;
      while (chars[j + closeRun] === '`') closeRun += 1;
      if (closeRun === openRun) {
        blank(i, j + closeRun);
        i = j + closeRun;
        closed = true;
        break;
      }
      j += closeRun;
    }
    if (!closed) i += openRun;
  }

  return chars.join('');
}

/**
 * 拆出正文里的 Markdown 图片引用（跳过代码块 / 行内代码）。
 * 返回按出现顺序排列，位置可直接用于字符串拼接替换。
 */
export function collectImageRefs(markdown: string): MarkdownImageRef[] {
  if (typeof markdown !== 'string' || markdown.length === 0) return [];
  const masked = maskCodeRegions(markdown);
  const refs: MarkdownImageRef[] = [];

  IMAGE_REF_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMAGE_REF_RE.exec(masked)) !== null) {
    const alt = match[1] ?? '';
    const inner = match[2] ?? '';
    const parsed = parseDestination(inner);
    if (parsed === null) continue;

    const start = match.index;
    refs.push({
      raw: markdown.slice(start, start + match[0].length),
      alt,
      url: parsed.url,
      titleSuffix: parsed.titleSuffix,
      angleBracket: parsed.angleBracket,
      start,
      end: start + match[0].length,
    });
  }

  return refs;
}

/** 解析 `(...)` 里的内容：地址 + 可选标题。 */
function parseDestination(
  inner: string,
): { url: string; titleSuffix: string; angleBracket: boolean } | null {
  const leading = inner.length - inner.trimStart().length;
  const text = inner.trim();
  if (text === '') return null;

  if (text.startsWith('<')) {
    const close = text.indexOf('>');
    if (close === -1) return null;
    const url = text.slice(1, close).trim();
    if (url === '') return null;
    return { url, titleSuffix: inner.slice(leading + close + 1), angleBracket: true };
  }

  const whitespace = text.search(/\s/);
  if (whitespace === -1) {
    return { url: text, titleSuffix: inner.slice(leading + text.length), angleBracket: false };
  }
  const url = text.slice(0, whitespace);
  if (url === '') return null;
  return { url, titleSuffix: inner.slice(leading + whitespace), angleBracket: false };
}

/** 用新地址重建一条图片引用（保留 alt 与标题；括号内空白规范化）。 */
function renderImageRef(ref: MarkdownImageRef, url: string): string {
  const target = ref.angleBracket ? '<' + url + '>' : url;
  return '![' + ref.alt + '](' + target + ref.titleSuffix + ')';
}

/**
 * 按「原引用地址 → 站内 displayUrl」替换正文里的图片引用。
 * 没有提供映射的引用（外链、未匹配、上传失败）**原样保留**；无图片时原样返回。
 */
export function applyImageReplacements(
  markdown: string,
  replacements: ReadonlyMap<string, string>,
): { markdown: string; replaced: number } {
  const refs = collectImageRefs(markdown);
  if (refs.length === 0 || replacements.size === 0) return { markdown, replaced: 0 };

  let out = '';
  let cursor = 0;
  let replaced = 0;
  for (const ref of refs) {
    const next = replacements.get(ref.url);
    if (next === undefined) continue;
    out += markdown.slice(cursor, ref.start);
    out += renderImageRef(ref, next);
    cursor = ref.end;
    replaced += 1;
  }
  if (replaced === 0) return { markdown, replaced: 0 };
  out += markdown.slice(cursor);
  return { markdown: out, replaced };
}
