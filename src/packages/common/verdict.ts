/**
 * 五状态判定与证据链（对齐 dsh-bench 测评规范 v3.0）。
 *
 * 硬约束（来自规范，代码里守着）：
 *  - **不给总分、不用星级**：一篇评测的结论只能是五个状态之一。
 *  - **「真有用／帮倒忙／没啥差别」是有结论的判定**，必须带证据链（≥1 条可复核链接）；
 *    「还说不准／没法测」照常展示，但证据可以缺席——它们本身就是「信息不足」的表达。
 *  - 证据链是**可复现、可复核**的链接（配对 A/B 记录、门禁读数、复现步骤或日志），
 *    不是感受；链接必须可点开（http/https），不接受裸域名或空串。
 *  - 「没啥差别」不是「绝对一样」：判定文案由客户端按规范解释，这里只管键值合法。
 *
 * 客户端与服务端共用本模块：提交表单、API 校验、详情页渲染同源。
 *
 * @module packages/common/verdict
 */

import { err } from './errors';

export type VerdictKey = 'helpful' | 'harmful' | 'no-difference' | 'undetermined' | 'untestable';

export interface VerdictDef {
  readonly key: VerdictKey;
  readonly label: string;
  /** 有结论的判定：必须有证据链（规范：证据链是结论的前提，不是装饰）。 */
  readonly conclusive: boolean;
}

/** 规范写死的五个状态，顺序即界面顺序。 */
export const VERDICTS: readonly VerdictDef[] = Object.freeze([
  { key: 'helpful', label: '真有用', conclusive: true },
  { key: 'harmful', label: '帮倒忙', conclusive: true },
  { key: 'no-difference', label: '没啥差别', conclusive: true },
  { key: 'undetermined', label: '还说不准', conclusive: false },
  { key: 'untestable', label: '没法测', conclusive: false },
]);

export function isVerdictKey(value: unknown): value is VerdictKey {
  return typeof value === 'string' && VERDICTS.some((v) => v.key === value);
}

export function verdictDef(key: VerdictKey): VerdictDef {
  const found = VERDICTS.find((v) => v.key === key);
  if (!found) throw new Error(`未知判定：${key}`);
  return found;
}

/** 判定键 → 中文标签；未知键返回 null（调用方自行决定如何呈现，不要假装知道）。 */
export function verdictLabel(key: string | null | undefined): string | null {
  if (!key || !isVerdictKey(key)) return null;
  return verdictDef(key).label;
}

/** 一条证据：可点开的链接 + 可选备注（为什么这条能支撑结论）。 */
export interface EvidenceRef {
  readonly url: string;
  readonly note: string | null;
}

export const EVIDENCE_MAX_ITEMS = 10;
export const EVIDENCE_URL_MAX = 500;
export const EVIDENCE_NOTE_MAX = 200;

/**
 * 解析判定键。**必填**：没判定的评测不能提交（规范：结论是评测的交付物）。
 * @param raw 请求里的原始值
 * @param path 字段路径（用于字段级错误）
 */
export function parseVerdict(raw: unknown, path = 'verdict'): VerdictKey {
  if (raw === undefined || raw === null || raw === '') {
    throw err.input('评测必须给出一个判定（五状态之一）。', [
      { path, message: '必填：真有用／帮倒忙／没啥差别／还说不准／没法测' },
    ]);
  }
  if (!isVerdictKey(raw)) {
    throw err.input('判定不在五状态之内。', [
      { path, message: '只接受：' + VERDICTS.map((v) => `${v.label}（${v.key}）`).join('、') },
    ]);
  }
  return raw;
}

/**
 * 解析证据链。
 * @param raw 请求里的原始值（[{ url, note? }]）
 * @param options.required 是否有结论的判定（conclusive）——是则至少一条
 * @param options.path 字段路径
 */
export function parseEvidenceRefs(
  raw: unknown,
  { required, path = 'evidenceRefs' }: { required: boolean; path?: string },
): EvidenceRef[] {
  const list = raw === undefined || raw === null ? [] : raw;
  if (!Array.isArray(list)) {
    throw err.input('证据链必须是数组。', [{ path, message: '类型不正确' }]);
  }
  if (list.length > EVIDENCE_MAX_ITEMS) {
    throw err.input(`证据最多 ${EVIDENCE_MAX_ITEMS} 条。`, [{ path, message: '超出上限' }]);
  }
  const out: EvidenceRef[] = [];
  for (const [index, item] of list.entries()) {
    const itemPath = `${path}[${index}]`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw err.input('证据条目结构不正确。', [{ path: itemPath, message: '必须是 { url, note? }' }]);
    }
    const obj = item as Record<string, unknown>;
    if (typeof obj.url !== 'string') {
      throw err.input('证据链接必须是文本。', [{ path: `${itemPath}.url`, message: '类型不正确' }]);
    }
    const url = obj.url.trim();
    if (url.length === 0 || url.length > EVIDENCE_URL_MAX) {
      throw err.input('证据链接长度不合法。', [{ path: `${itemPath}.url`, message: '空串或超长' }]);
    }
    if (!/^https?:\/\//i.test(url) || /\s/.test(url)) {
      throw err.input('证据链接必须是可点开的 http(s) 地址。', [
        { path: `${itemPath}.url`, message: '需要以 http:// 或 https:// 开头，且不含空白' },
      ]);
    }
    const noteRaw = obj.note;
    if (noteRaw !== undefined && noteRaw !== null && typeof noteRaw !== 'string') {
      throw err.input('证据备注必须是文本或 null。', [{ path: `${itemPath}.note`, message: '类型不正确' }]);
    }
    const note = typeof noteRaw === 'string' && noteRaw.trim().length > 0 ? noteRaw.trim() : null;
    if (note !== null && note.length > EVIDENCE_NOTE_MAX) {
      throw err.input(`证据备注最长 ${EVIDENCE_NOTE_MAX} 字。`, [{ path: `${itemPath}.note`, message: '超长' }]);
    }
    out.push({ url, note });
  }
  if (required && out.length === 0) {
    throw err.input('有结论的判定必须带证据链（至少一条可复核链接）。', [
      { path: `${path}`, message: '「真有用／帮倒忙／没啥差别」需要证据；还说不准／没法测可以没有' },
    ]);
  }
  return out;
}
