/**
 * 作者 CLI：文件夹导入 + 断点续传。
 *
 * 为什么是 CLI 而不是网页表单：读整个文件夹要目录选择权限，而浏览器拿不到"真正的相对路径"；
 * 真正需要断点续传的正是「一批几百 MB 的图片 + 十几篇 md」。CLI 能直接算 sha256、按 8MB 切片、
 * 断网后从 offset 继续，并且把状态落在服务端（换机器也能接着传）。
 *
 * 用法：
 *   npx tsx scripts/import-author-folder.mjs <目录> [--to http://127.0.0.1:3100] [--cookie <会话 Cookie>]
 *
 * 两步：先 register（只登记清单，不传字节），再 upload（逐文件传，中断后重跑即续传），
 * 最后 finalize（生成草稿、改写图片引用）。
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const MARKDOWN = /\.(md|markdown|txt)$/i;
const IMAGE = /\.(png|jpe?g|webp)$/i;
const CHUNK = 8 * 1024 * 1024;

function usage() {
  console.error('用法：node scripts/import-author-folder.mjs <目录> [--to <baseUrl>] [--cookie <会话 Cookie>]');
  process.exit(2);
}

const args = process.argv.slice(2);
const dir = args[0];
if (!dir || dir.startsWith('--')) usage();
const toIndex = args.indexOf('--to');
const baseUrl = toIndex >= 0 ? args[toIndex + 1] : process.env.DSH_REVIEW_BASE_URL || 'http://127.0.0.1:3100';
const cookieIndex = args.indexOf('--cookie');
const cookie = cookieIndex >= 0 ? args[cookieIndex + 1] : process.env.DSH_REVIEW_COOKIE || '';
if (!cookie) {
  console.error('需要登录态 Cookie：--cookie "dsh_session=..."（从浏览器开发者工具复制）');
  process.exit(2);
}

async function walk(root) {
  const out = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

async function postJson(path, body) {
  const response = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error((payload.error && payload.error.message) || '请求失败：' + response.status);
  }
  return payload.data;
}

async function main() {
  const files = await walk(dir);
  const declarations = [];
  for (const file of files) {
    const rel = relative(dir, file).replace(/\\/g, '/');
    if (!MARKDOWN.test(rel) && !IMAGE.test(rel)) continue;
    const bytes = await readFile(file);
    declarations.push({
      path: rel,
      kind: MARKDOWN.test(rel) ? 'markdown' : 'image',
      byteSize: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  if (declarations.length === 0) {
    console.error('目录里没有 .md 或 png/jpeg/webp。');
    process.exit(1);
  }

  const batch = await postJson('/api/imports/author', {
    inputs: declarations,
    requestKey: 'cli-' + Date.now(),
  });
  console.log('批次 ' + batch.batchId + '：' + batch.inputs + ' 个文件，' + batch.items + ' 篇 Markdown');

  const status = await (await fetch(baseUrl + '/api/imports/author/' + batch.batchId, { headers: { cookie } })).json();
  if (!status.ok) throw new Error('读取批次失败');
  const byPath = new Map(status.data.inputs.map((input) => [input.path, input]));

  for (const declaration of declarations) {
    const input = byPath.get(declaration.path);
    if (!input) throw new Error('服务端缺少输入：' + declaration.path);
    if (input.uploadState === 'ready') {
      console.log('跳过（已完整接收）：' + declaration.path);
      continue;
    }
    const bytes = await readFile(join(dir, declaration.path));
    let received = input.receivedByteSize;
    let attemptId = null;
    while (received < bytes.byteLength) {
      const slice = bytes.subarray(received, Math.min(received + CHUNK, bytes.byteLength));
      const result = await postJson('/api/imports/author/' + batch.batchId + '/chunk', {
        inputId: input.inputId,
        attemptId,
        offset: received,
        base64: slice.toString('base64'),
      });
      attemptId = result.attemptId;
      received = result.received;
    }
    await postJson('/api/imports/author/' + batch.batchId + '/finish', { inputId: input.inputId, attemptId });
    console.log('已传完：' + declaration.path);
  }

  const done = await postJson('/api/imports/author/' + batch.batchId + '/finalize', {});
  console.log('生成草稿 ' + done.created + ' 篇，失败 ' + done.failed + ' 篇，跳过 ' + done.skipped + ' 篇');
  for (const issue of done.issues) {
    if (issue.issues.length > 0) console.log(' - ' + issue.itemKey + '：' + issue.issues.join('；'));
  }
  console.log('打开「我的评测 · 草稿」查看：' + baseUrl + '/me');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
