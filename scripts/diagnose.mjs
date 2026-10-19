#!/usr/bin/env node
/**
 * 一条命令看清"现在到底是什么状态"（运维/排障用）。
 *
 * 解决的具体问题：出问题时要回答的通常是这几句 ——
 *   "库结构到哪一版了？" "worker 还活着吗？" "有没有卡住/失败的任务？失败在哪个错误码？"
 *   "磁盘还有多少？" "这个功能配了没？" "最近的错误在哪看？"
 * 这些以前要上机连库手敲 SQL、或者翻 journal，容易漏、也容易敲错。
 *
 * 用法：
 *   node scripts/diagnose.mjs            # 人看
 *   node scripts/diagnose.mjs --json     # 机器读（给监控/工单）
 *
 * 安全：只读；**不打印任何密钥**，配置项只报告"已配置 / 未配置"。
 * 退出码：0 = 没发现结构性故障；1 = 有明确故障（结构缺失、磁盘告急、任务大量失败）。
 */

import Database from 'better-sqlite3';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const asJson = process.argv.includes('--json');
const dbFile = resolve(process.env.DSH_REVIEW_DB_PATH ?? '.data/app.sqlite');
const mediaRoot = resolve(process.env.DSH_REVIEW_MEDIA_ROOT ?? '.data/media');
const workerName = process.env.DSH_REVIEW_WORKER_HEARTBEAT_NAME ?? 'worker';

/** 必需业务表（与 src/server/platform/migrate.ts 的 REQUIRED_TABLES 对齐）。 */
const REQUIRED_TABLES = [
  'users', 'external_identities', 'user_sessions', 'repositories', 'plugins',
  'content_entities', 'reviews', 'review_revisions', 'content_drafts',
  'draft_save_receipts', 'content_submissions', 'content_moderation_records',
  'comments', 'comment_revisions', 'background_tasks', 'background_task_attempts',
  'operation_records', 'configuration_revisions', 'site_settings', 'runtime_heartbeats',
];

const STALE_MS = Number(process.env.DSH_REVIEW_WORKER_STALE_MS ?? 120_000);

const out = {
  checked_at: new Date().toISOString(),
  runtime: { node: process.version, platform: `${process.platform} ${process.arch}`, cwd: process.cwd() },
  config: {},
  db: {},
  counts: {},
  tasks: {},
  worker: {},
  disk: {},
  media: {},
  problems: [],
};

function envState(name, minLength = 1) {
  const v = process.env[name];
  if (typeof v !== 'string' || v.trim().length === 0) return '未配置';
  if (v.length < (minLength === 1 ? 1 : minLength)) return '已配置但过短（无效）';
  return `已配置（长度 ${v.length}）`;
}

// —— 配置：只看"配没配"，永不打值
out.config = {
  NODE_ENV: process.env.NODE_ENV ?? '（未设置）',
  GITHUB_CLIENT_ID: envState('GITHUB_CLIENT_ID'),
  GITHUB_CLIENT_SECRET: envState('GITHUB_CLIENT_SECRET'),
  GITHUB_REDIRECT_URI: process.env.GITHUB_REDIRECT_URI ?? '未配置',
  SESSION_SECRET: envState('SESSION_SECRET', 32),
  BOOTSTRAP_ADMIN_GITHUB_ID: envState('BOOTSTRAP_ADMIN_GITHUB_ID'),
  DSH_REVIEW_TEST_LOGIN: envState('DSH_REVIEW_TEST_LOGIN'),
  DSH_REVIEW_CONTENT_SCREEN: process.env.DSH_REVIEW_CONTENT_SCREEN ?? '未设置（筛查不可用→转人工，保守）',
  DSH_REVIEW_INSECURE_COOKIES: process.env.DSH_REVIEW_INSECURE_COOKIES ?? '未设置',
};

// —— 库
if (!existsSync(dbFile)) {
  out.problems.push(`库文件不存在：${dbFile}`);
  out.db = { file: dbFile, exists: false };
} else {
  const stat = statSync(dbFile);
  const wal = `${dbFile}-wal`;
  const shm = `${dbFile}-shm`;
  out.db = {
    file: dbFile,
    exists: true,
    size_mb: +(stat.size / 1024 / 1024).toFixed(2),
    wal_mb: existsSync(wal) ? +(statSync(wal).size / 1024 / 1024).toFixed(2) : 0,
    shm_present: existsSync(shm),
  };

  let db;
  try {
    db = new Database(dbFile, { readonly: true, fileMustExist: true });
  } catch (e) {
    out.problems.push(`库打不开：${e.message}`);
  }
  if (db) {
    try {
      const version = (() => {
        try {
          return db.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get()?.version ?? null;
        } catch {
          return null;
        }
      })();
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
      const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
      out.db.schema_version = version;
      out.db.foreign_keys = db.pragma('foreign_keys', { simple: true }) === 1;
      out.db.journal_mode = String(db.pragma('journal_mode', { simple: true }));
      out.db.missing_tables = missing;
      out.db.sqlite_version = db.prepare('SELECT sqlite_version() AS v').get().v;
      if (missing.length) out.problems.push(`缺业务表：${missing.join(', ')}`);
      if (!out.db.foreign_keys) out.problems.push('外键未启用（约束不会生效）');
      if (out.db.journal_mode !== 'wal') out.problems.push(`journal_mode=${out.db.journal_mode}，不是 wal`);

      // —— 数据量（只数，不读内容）
      const count = (sql) => {
        try {
          return db.prepare(sql).get().c;
        } catch {
          return null;
        }
      };
      out.counts = {
        users: count('SELECT count(*) AS c FROM users'),
        admins: count("SELECT count(*) AS c FROM users WHERE role='admin' AND account_status='active'"),
        identities: count('SELECT count(*) AS c FROM external_identities'),
        sessions: count('SELECT count(*) AS c FROM user_sessions'),
        repositories: count('SELECT count(*) AS c FROM repositories'),
        plugins: count('SELECT count(*) AS c FROM plugins'),
        reviews: count('SELECT count(*) AS c FROM reviews'),
        published_reviews: count("SELECT count(*) AS c FROM reviews WHERE published_revision_id IS NOT NULL"),
        comments: count('SELECT count(*) AS c FROM comments'),
        submissions: count('SELECT count(*) AS c FROM content_submissions'),
        attachments: count('SELECT count(*) AS c FROM attachments'),
      };
      if (out.counts.admins === 0) out.problems.push('**没有任何可用管理员**（先配 SUPER_ADMIN_GITHUB_ID，再看 scripts/set-super-admin.mjs）');

      // —— 任务队列
      // 列名以迁移为准：processing_state / last_error_code / last_error_summary
      // 枚举：queued | running | retry_wait | succeeded | failed | skipped
      try {
        const byState = db
          .prepare('SELECT processing_state, count(*) AS c FROM background_tasks GROUP BY processing_state ORDER BY processing_state')
          .all();
        out.tasks.by_state = Object.fromEntries(byState.map((r) => [r.processing_state, r.c]));
        out.tasks.running = out.tasks.by_state.running ?? 0;
        // 积压多久没人领：worker 静默死亡时，这是队列侧唯一能看出来的信号
        const oldest = db
          .prepare(
            `SELECT created_at FROM background_tasks
              WHERE processing_state IN ('queued','retry_wait')
              ORDER BY created_at ASC LIMIT 1`,
          )
          .get();
        out.tasks.oldest_waiting_seconds = oldest
          ? Math.round(Math.max(0, Date.now() - Number(oldest.created_at)) / 1000)
          : null;
        out.tasks.recent_problems = db
          .prepare(
            `SELECT task_type, processing_state, attempt_count, last_error_code, last_error_summary, updated_at
               FROM background_tasks
              WHERE processing_state IN ('failed','skipped') OR last_error_code IS NOT NULL
              ORDER BY updated_at DESC LIMIT 10`,
          )
          .all()
          .map((r) => ({
            task_type: r.task_type,
            state: r.processing_state,
            attempts: r.attempt_count,
            error_code: r.last_error_code,
            error_summary: r.last_error_summary,
            at: new Date(Number(r.updated_at)).toISOString(),
          }));
      } catch (e) {
        out.tasks.error = e.message;
        out.problems.push(`读任务队列失败：${e.message}`);
      }

      // —— worker 心跳
      try {
        const row = db.prepare('SELECT beat_at, started_at, detail FROM runtime_heartbeats WHERE name = ?').get(workerName);
        if (!row) {
          out.worker = { state: 'missing', note: 'worker 从未写过心跳（没跑过？）' };
          out.problems.push('worker 从未写过心跳');
        } else {
          const ageMs = Math.max(0, Date.now() - Number(row.beat_at));
          out.worker = {
            state: ageMs > STALE_MS ? 'dead' : 'ok',
            age_seconds: Math.round(ageMs / 1000),
            alive_seconds: Math.round(Math.max(0, Date.now() - Number(row.started_at)) / 1000),
            detail: row.detail ? JSON.parse(row.detail) : null,
          };
          if (ageMs > STALE_MS) out.problems.push(`worker 心跳已 ${out.worker.age_seconds} 秒未更新`);
        }
      } catch (e) {
        out.worker = { state: 'unknown', error: e.message };
        out.problems.push('读不到心跳表（迁移没跑到 0004？）');
      }
    } finally {
      db.close();
    }
  }
}

// —— 磁盘
try {
  const { statfsSync } = await import('node:fs');
  const st = statfsSync(dirname(dbFile));
  const freeMb = Math.floor((Number(st.bavail) * Number(st.bsize)) / 1024 / 1024);
  const totalMb = Math.floor((Number(st.blocks) * Number(st.bsize)) / 1024 / 1024);
  out.disk = { free_mb: freeMb, total_mb: totalMb, used_pct: +(((totalMb - freeMb) / totalMb) * 100).toFixed(1) };
  if (freeMb < 200) out.problems.push(`磁盘余量告急：${freeMb} MB`);
} catch (e) {
  out.disk = { error: e.message };
}

// —— 媒体目录
try {
  if (existsSync(mediaRoot)) {
    let files = 0;
    let bytes = 0;
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else {
          files += 1;
          bytes += statSync(p).size;
        }
      }
    };
    walk(mediaRoot);
    out.media = { root: mediaRoot, files, size_mb: +(bytes / 1024 / 1024).toFixed(2) };
  } else {
    out.media = { root: mediaRoot, exists: false };
  }
} catch (e) {
  out.media = { root: mediaRoot, error: e.message };
}

if (asJson) {
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = out.problems.length > 0 ? 1 : 0;
} else {
  const line = (k, v) => console.log(`  ${String(k).padEnd(26)} ${v}`);
  console.log(`== 运行时 ==`);
  line('检查时间', out.checked_at);
  line('node', out.runtime.node);
  line('平台', out.runtime.platform);
  line('工作目录', out.runtime.cwd);

  console.log(`\n== 配置（只看配没配）==`);
  for (const [k, v] of Object.entries(out.config)) line(k, v);

  console.log(`\n== 库 ==`);
  for (const [k, v] of Object.entries(out.db)) {
    line(k, Array.isArray(v) ? (v.length ? v.join(', ') : '（齐全）') : v);
  }

  console.log(`\n== 数据量 ==`);
  for (const [k, v] of Object.entries(out.counts)) line(k, v);

  console.log(`\n== 任务队列 ==`);
  line('运行中', out.tasks.running ?? '?');
  line('最老排队任务', out.tasks.oldest_waiting_seconds === null ? '（无积压）' : `${out.tasks.oldest_waiting_seconds} 秒前建立`);
  for (const [k, v] of Object.entries(out.tasks.by_state ?? {})) line(k, v);
  if (out.tasks.error) line('读取失败', out.tasks.error);
  const problems = out.tasks.recent_problems ?? [];
  if (problems.length === 0) line('最近失败/跳过', '（无）');
  else {
    console.log(`  最近失败/跳过（${problems.length} 条）：`);
    for (const p of problems) {
      console.log(`    ${p.at}  ${p.task_type}  ${p.state}  尝试 ${p.attempts} 次  ${p.error_code ?? ''} ${p.error_summary ?? ''}`);
    }
  }

  console.log(`\n== worker ==`);
  for (const [k, v] of Object.entries(out.worker)) line(k, typeof v === 'object' ? JSON.stringify(v) : v);

  console.log(`\n== 磁盘 ==`);
  for (const [k, v] of Object.entries(out.disk)) line(k, v);

  console.log(`\n== 媒体 ==`);
  for (const [k, v] of Object.entries(out.media)) line(k, v);

  console.log(`\n== 结论 ==`);
  if (out.problems.length === 0) {
    console.log('  没发现结构性故障。');
  } else {
    for (const p of out.problems) console.log(`  ✗ ${p}`);
  }
  console.log('\n  最近的应用日志（systemd）：journalctl -u dsh-review-web -u dsh-review-worker -n 100 --no-pager');
  console.log('  最近的应用日志（容器）：docker compose logs --tail=100 web worker');
  process.exitCode = out.problems.length > 0 ? 1 : 0;
}
