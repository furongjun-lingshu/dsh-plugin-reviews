// 端到端验收：真人路径「登录 → 收录插件 → 写评测 → 提交 → worker 发布 → 评论」。
//
// 与 acceptance-http*.mjs 的分工：
//   - 那三个脚本验证**单段链路**（读/写/上传）；
//   - 本脚本验证**整条链真的走到底**：提交后由**独立 worker 进程**处理任务，
//     内容真的变成 published，评论也真的公开。
//
// 为什么必须跑真 worker：曾经 handlers 注册表是空 `{}`，
// 提交后任务永远没人处理 —— 单测和单段验收都是绿的，只有真进程能暴露。
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const BASE = 'http://127.0.0.1:3100';
const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
const jar = join(dir, 'cookies.txt');
const RUN = Date.now().toString(36);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

function curl(args) {
  return execFileSync('curl.exe', ['-s', '-b', jar, '-c', jar, ...args], { encoding: 'utf8' });
}
function json(args) {
  const raw = curl(args);
  try {
    return JSON.parse(raw);
  } catch {
    return { __raw: raw.slice(0, 300) };
  }
}
function sendJson(method, path, body) {
  const f = join(dir, `b-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(body));
  return json(['-X', method, '-H', 'content-type: application/json', '--data-binary', `@${f}`, `${BASE}${path}`]);
}

const dbPath = join(process.cwd(), '.data', 'app.sqlite');
const loader = new Database(dbPath);
loader.pragma('foreign_keys = ON');

// 1) 登录（开发测试通道）
const login = sendJson('POST', '/api/testing/session', {
  providerUserId: `gh-e2e-${RUN}`,
  providerUsername: `e2euser-${RUN}`,
});
check('登录成功', login.ok === true, login.data?.userId);
const authorId = login.data.userId;

// 2) 会话可读（前端导航依赖它）
const sess = json([`${BASE}/api/session`]);
check(
  '会话接口如实报告 GitHub 登录是否已配置',
  sess.ok === true && typeof sess.data?.githubLoginConfigured === 'boolean',
  `githubLoginConfigured=${sess.data?.githubLoginConfigured} testLoginEnabled=${sess.data?.testLoginEnabled}`,
);

// 3) 收录插件（走真实 GitHub 探针）。
//
// 用的 URL 必须是**真的声明了 dsh.bundle 的目录**：仓库根的 package.json 没有该键，
// 拿根链接会（正确地）被拒。这里指向上游真实的组合包目录 —— 已在真机确认它里面是
//   { "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
// 且 packages/bundle/base/cordis.patch.yml 确实存在。
//
// 三种结果要分清，不能都记成"链路坏了"：
//   - 成功                      → 收录真的通了；
//   - provider_not_configured   → 探针离线（DSH_REVIEW_CATALOG_OFFLINE=1），本脚本跳过；
//   - provider_unavailable      → 多为**匿名限流**（api.github.com 对未认证 IP 只有 60 次/小时）。
//     这时探针的行为是**正确**的（如实报不可用，而不是假装收录成功），
//     所以记账为 SKIP 并在结尾提示配 GITHUB_TOKEN，而不是 FAIL。
const pluginUrl =
  process.env.DSH_REVIEW_E2E_PLUGIN_URL ??
  'https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/bundle/base';
const accepted = sendJson('POST', '/api/plugins', { url: pluginUrl, requestKey: `acc-${RUN}` });
let pluginId = accepted.data?.pluginId ?? null;
let catalogSkipped = null;

if (accepted.ok === true) {
  check('收录插件成功（真实 GitHub 探针）', !!pluginId, `pluginId=${pluginId} created=${accepted.data?.created}`);
} else if (accepted.error?.code === 'provider_not_configured') {
  catalogSkipped = '探针离线（DSH_REVIEW_CATALOG_OFFLINE=1）';
  console.log(`SKIP  收录插件 — ${catalogSkipped}`);
} else if (accepted.error?.code === 'provider_unavailable') {
  catalogSkipped = `GitHub 不可用/限流：${accepted.error?.message ?? ''}`.slice(0, 160);
  check(
    '探针在限流时如实报不可用，且没有假装收录成功',
    accepted.error?.code === 'provider_unavailable' && !accepted.data?.pluginId,
    accepted.error?.code,
  );
} else {
  check('收录插件成功（真实 GitHub 探针）', false, JSON.stringify(accepted.error));
}

// 探针离线时挑一个库内既有插件，保证下游链路仍可验证。
if (!pluginId) {
  const row = loader.prepare('SELECT id FROM plugins LIMIT 1').get();
  pluginId = row?.id ?? null;
  check('找到既有插件用于继续验证', !!pluginId, pluginId ?? '(库内无插件)');
}

// 4) 建草稿
const created = sendJson('POST', '/api/drafts', { requestKey: `draft-${RUN}`, pluginId });
check('建草稿成功', created.ok === true && !!created.data?.draftId, created.data?.draftId);
const draftId = created.data.draftId;
const saveVersion = created.data.saveVersion;

// 5) 保存正文
const BODY = [
  '# 实测评测',
  '',
  '这是通过 HTTP 走完整条链路的评测正文，包含安装步骤、实际表现与结论。',
  '',
  '- 安装：`dsh plugin add`',
  '- 结论：可用',
].join('\n');
const saved = sendJson('PUT', '/api/drafts', {
  draftId,
  requestKey: `save-${RUN}`,
  expectedVersion: saveVersion,
  title: '端到端验收评测',
  pluginId,
  pluginVersion: { kind: 'unknown' },
  dshVersion: { kind: 'unknown' },
  body: [{ key: 'main', markdown: BODY }],
});
check('保存草稿成功并递增 saveVersion', saved.ok === true && saved.data?.saveVersion > saveVersion, `saveVersion=${saved.data?.saveVersion}`);
const newVersion = saved.data.saveVersion;

// 6) 用过期版本保存 → 必须冲突（乐观并发是真生效的，不是摆设）
const stale = sendJson('PUT', '/api/drafts', {
  draftId,
  requestKey: `save-stale-${RUN}`,
  expectedVersion: saveVersion,
  title: '端到端验收评测',
  pluginId,
  pluginVersion: { kind: 'unknown' },
  dshVersion: { kind: 'unknown' },
  body: [{ key: 'main', markdown: BODY }],
});
check('过期版本保存被拒（version_conflict）', stale.ok === false && stale.error?.code === 'version_conflict', stale.error?.code);

// 7) 提交 → 202
const submitted = sendJson('PATCH', '/api/drafts', {
  draftId,
  requestKey: `submit-${RUN}`,
  expectedSaveVersion: newVersion,
  title: '端到端验收评测',
  bodyMarkdown: BODY,
  pluginVersion: { kind: 'unknown' },
  dshVersion: { kind: 'unknown' },
  // 五状态判定 + 证据链（dsh-bench 规范）：publish 提交必填；有结论的判定带证据。
  verdict: 'helpful',
  evidenceRefs: [{ url: 'https://example.com/acceptance/evidence', note: '验收链证据' }],
});
check('提交成功', submitted.ok === true && !!submitted.data?.submissionId, JSON.stringify(submitted.data ?? submitted.error));
const submissionId = submitted.data?.submissionId;
const reviewId = submitted.data?.reviewId;

check('提交后立即处于 pending（未假装已发布）', submitted.data?.processingState === 'pending', submitted.data?.processingState);

// 8) 跑真 worker 进程处理队列。
//
// worker 是**常驻循环**（无任务时休眠、SIGTERM 优雅退出），没有 one-shot 开关。
// 所以这里：拉起真进程 → 轮询数据库直到该提交离开 pending/checking → 优雅停掉。
// 判据取自**库内真实状态**，不是 sleep 猜时间。
function pendingTasks() {
  const row = loader
    .prepare(
      `SELECT count(*) AS c FROM background_tasks
        WHERE processing_state IN ('queued','retrying','running')`,
    )
    .get();
  return row?.c ?? 0;
}

async function runWorkerUntilDrained(submissionId) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker/main.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, DSH_REVIEW_CONTENT_SCREEN: 'basic' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d.toString()));
  child.stderr.on('data', (d) => (out += d.toString()));

  const TERMINAL = new Set(['published', 'needs_changes', 'manual_review', 'ineligible']);
  const deadline = Date.now() + 45000;
  let last = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    const row = loader.prepare('SELECT processing_state FROM content_submissions WHERE id = ?').get(submissionId);
    last = row?.processing_state;
    if (last && TERMINAL.has(last) && pendingTasks() === 0) break;
  }

  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.on('close', () => {
      clearTimeout(t);
      resolve();
    });
  });
  return { out, finalState: last };
}

const workerRun = await runWorkerUntilDrained(submissionId);
check(
  'worker 装配了处理器（不是空注册表）',
  /handler_count/.test(workerRun.out),
  workerRun.out.split('\n').find((l) => l.includes('handler_count'))?.trim().slice(0, 200) ?? '(未见装配日志)',
);

// 9) 库里核对终态
const subRow = loader.prepare('SELECT processing_state FROM content_submissions WHERE id = ?').get(submissionId);
const revRow = loader.prepare('SELECT published_revision_id FROM reviews WHERE id = ?').get(reviewId);
const entRow = loader.prepare('SELECT first_published_at FROM content_entities WHERE id = ?').get(reviewId);
check(
  '提交到达 published（真 worker 处理，不是测试桩）',
  subRow?.processing_state === 'published',
  `processing_state=${subRow?.processing_state}`,
);
check('评测公开修订指针已切换', !!revRow?.published_revision_id, revRow?.published_revision_id ?? 'null');
check('首次发布时间为真实时间戳', typeof entRow?.first_published_at === 'number', String(entRow?.first_published_at));

// 10) 公开可见性：匿名应能看到这篇
const anonJar = join(dir, 'anon.txt');
const anonDetail = execFileSync(
  'curl.exe',
  ['-s', '-o', 'NUL', '-w', '%{http_code}', `--cookie-jar`, anonJar, `${BASE}/api/reviews/${reviewId}`],
  { encoding: 'utf8' },
);
check('匿名可读到已发布评测', anonDetail === '200', `status=${anonDetail}`);

// 11) 评论：真发一条并走 worker 发布。
// 真实路由是 /api/content/{contentId}/comments（contentId 就是评测的 content_entity_id，
// 在本切片里等于 reviewId），正文取自当前公开修订，目标不公开则不可评论。
const comment = sendJson('POST', `/api/content/${reviewId}/comments`, {
  body: '这是一条通过 HTTP 发出的真实评论，长度足够通过基础内容筛查。',
  requestKey: `comment-${RUN}`,
});
check('发评论成功（评论走自己的提交与检查）', comment.ok === true, JSON.stringify(comment.data ?? comment.error));

if (comment.ok === true && comment.data?.commentId) {
  const commentSubmissionId = comment.data?.submissionId ?? null;
  if (commentSubmissionId) {
    await runWorkerUntilDrained(commentSubmissionId);
  } else {
    // 没有提交 ID 也要等队列空，否则会读到"还没发布"的中间态而误判。
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && pendingTasks() > 0) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  const cRow = loader
    .prepare('SELECT published_revision_id, first_published_at FROM comments WHERE id = ?')
    .get(comment.data.commentId);
  check('评论经 worker 发布并公开', !!cRow?.published_revision_id && cRow?.first_published_at !== null, JSON.stringify(cRow));

  const list = json([`${BASE}/api/content/${reviewId}/comments`]);
  const ids = (list.data?.items ?? []).map((i) => i.commentId);
  check('公开评论列表包含该评论（未被错误过滤）', ids.includes(comment.data.commentId), `count=${ids.length}`);

  // 11b) 回复：顶层列表里只有 replyCount 这个数字，回复要单独取
  //      （新路由 GET /api/content/{id}/comments/{commentId}/replies）。
  const reply = sendJson('POST', `/api/content/${reviewId}/comments`, {
    body: '这是一条回复，用来验证讨论组内回复的提交、检查、发布与公开读取。',
    replyToCommentId: comment.data.commentId,
    requestKey: `reply-${RUN}`,
  });
  check('发回复成功（携 replyToCommentId）', reply.ok === true, JSON.stringify(reply.data ?? reply.error));

  if (reply.ok === true && reply.data?.commentId) {
    if (reply.data?.submissionId) {
      await runWorkerUntilDrained(reply.data.submissionId);
    }
    const replies = json([`${BASE}/api/content/${reviewId}/comments/${comment.data.commentId}/replies`]);
    const rIds = (replies.data?.items ?? []).map((i) => i.commentId);
    check(
      '回复经 worker 发布后可从「组内回复」路由读到',
      rIds.includes(reply.data.commentId),
      `count=${rIds.length} total=${replies.data?.total}`,
    );

    const rootsAfter = json([`${BASE}/api/content/${reviewId}/comments`]);
    const rootRow = (rootsAfter.data?.items ?? []).find((i) => i.commentId === comment.data.commentId);
    check('回复计入顶层评论的 replyCount', (rootRow?.replyCount ?? 0) >= 1, `replyCount=${rootRow?.replyCount}`);

    // 拿一条回复的 ID 去当 root 取回复组必须被拒（顶层判断不能被绕过）
    const badRoot = json([`${BASE}/api/content/${reviewId}/comments/${reply.data.commentId}/replies`]);
    check('用回复的 ID 当讨论组取回复 → 明确拒绝', badRoot.ok === false, badRoot.error?.code);
  }
}

// 12) 登出后写操作必须 401
const loggedOut = json(['-X', 'DELETE', `${BASE}/api/session`]);
check('登出成功', loggedOut.ok === true, JSON.stringify(loggedOut.data ?? loggedOut.error));
const afterOut = sendJson('POST', '/api/drafts', { requestKey: `after-${RUN}`, pluginId });
check('登出后建草稿被拒（401）', afterOut.ok === false && afterOut.error?.code === 'unauthenticated', afterOut.error?.code);

loader.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n==== 端到端链路验收：${results.length - failed.length}/${results.length} 通过 ====`);
if (catalogSkipped) {
  console.log(`注意：收录插件一步未验证完整 —— ${catalogSkipped}`);
  console.log('      匿名 api.github.com 只有 60 次/小时；把 GITHUB_TOKEN 填进 .env.local 可解除。');
}
process.exit(failed.length === 0 ? 0 : 1);
