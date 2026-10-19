// 超级管理员引导（部署时用）。**不是**"随便指定一个管理员"的工具。
//
// 架构（见 src/server/modules/identity/super-admin.ts）：
//   * 谁当超级管理员由**部署配置** SUPER_ADMIN_GITHUB_ID 决定（GitHub 稳定数字 ID）；
//   * 站内**没有任何**入口能授予、撤销或转移这个身份；配置绑定的账号也不能被
//     降级为普通管理员、不能被禁用（服务层守卫）；
//   * 数据库里**不存**"谁是超管"——每次请求现算，所以改配置 + 重启即生效。
//
// 本脚本只做一件事：把配置里绑定的那个身份**引导进库**（首次登录后提升为管理员）。
// 日常的"授予/撤销管理员"必须走后台，而且只有超级管理员能做（还要手打对方昵称确认）。
//
// 用法：
//   node scripts/set-super-admin.mjs --list       # 看当前绑定与库里的用户（默认行为）
//   node scripts/set-super-admin.mjs --bootstrap  # 按配置把该身份提升为管理员（幂等）
//
// 前置：目标账号必须**已经登录过一次**（users 行由首次登录建立）。
//       通常不必跑 --bootstrap —— 超管身份登录时会自动绑定。

import Database from 'better-sqlite3';
import { dirname, isAbsolute, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
for (const a of args) {
  if (a !== '--list' && a !== '--bootstrap') {
    console.error(`不认识参数：${a}`);
    console.error('用法：node scripts/set-super-admin.mjs [--list | --bootstrap]');
    process.exit(2);
  }
}
const bootstrap = args.includes('--bootstrap');

function resolveDbPath() {
  const raw = process.env.DSH_REVIEW_DB_PATH ?? '.data/app.sqlite';
  const abs = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  mkdirSync(dirname(abs), { recursive: true });
  return abs;
}

const raw = (process.env.SUPER_ADMIN_GITHUB_ID ?? '').trim();
if (raw !== '' && /[\s,;]/.test(raw)) {
  console.error('SUPER_ADMIN_GITHUB_ID 只能填一个 GitHub 稳定数字 ID（当前值里出现空白或分隔符）。');
  console.error('超级管理员必须唯一；配置有问题时按"未配置"处理 —— 没人是超管，谁都授不了权（fail-closed）。');
  process.exit(1);
}
const configured = raw === '' ? null : raw;

const file = resolveDbPath();
const db = new Database(file);
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

function listUsers() {
  console.log(`库：${file}`);
  console.log(`超级管理员配置：${configured === null ? '（未配置 SUPER_ADMIN_GITHUB_ID）' : configured}`);
  console.log('');
  const rows = db
    .prepare(
      `SELECT u.id, u.nickname, u.role, u.account_status, ei.provider_user_id, ei.provider_username
         FROM users u
         LEFT JOIN external_identities ei ON ei.user_id = u.id AND ei.provider = 'github'
        ORDER BY (u.role = 'admin') DESC, u.created_at ASC`,
    )
    .all();
  if (rows.length === 0) {
    console.log('库里还没有任何用户 —— 让目标账号先在站点上登录一次，再来引导。');
    return;
  }
  console.log('  role    账户            站内 ID                                超级管理员');
  for (const r of rows) {
    const isSuper = configured !== null && r.provider_user_id === configured;
    const status = r.account_status === 'active' ? '' : '（已禁用）';
    console.log(
      `  ${(r.role === 'admin' ? '管理员' : '普通用户').padEnd(6)} ${status.padEnd(8)}${
        String(r.nickname).padEnd(16)
      } ${r.id}  ${isSuper ? '← 是（部署绑定）' : ''}`,
    );
  }
  const admins = rows.filter((r) => r.role === 'admin' && r.account_status === 'active').length;
  console.log('');
  console.log(`当前可用管理员：${admins} 个`);
  if (configured === null) {
    console.log('⚠️ 没配置超级管理员：站内没有任何人能授予或撤销管理员（这是刻意的 fail-closed）。');
  } else if (!rows.some((r) => r.provider_user_id === configured)) {
    console.log(`⚠️ 配置的超级管理员（${configured}）还没有站内账号：让他先登录一次即可自动绑定。`);
  }
}

if (!bootstrap) {
  listUsers();
  db.close();
  process.exit(0);
}

if (configured === null) {
  console.error('拒绝执行：没有配置 SUPER_ADMIN_GITHUB_ID，无法引导。');
  process.exit(1);
}

const identity = db
  .prepare("SELECT u.id, u.nickname, u.role, u.account_status FROM external_identities ei JOIN users u ON u.id = ei.user_id WHERE ei.provider = 'github' AND ei.provider_user_id = ?")
  .get(configured);
if (!identity) {
  console.error(`找不到 GitHub 稳定 ID = ${configured} 的站内用户：该账号还没登录过本站。`);
  console.error('让他在站点上登录一次（超管身份登录时会自动绑定），然后再执行本命令。');
  process.exit(1);
}
if (identity.account_status !== 'active') {
  console.error(`拒绝执行：${identity.nickname} 的账户状态是 ${identity.account_status}，不能作为超级管理员。`);
  process.exit(1);
}
if (identity.role === 'admin') {
  console.log(`${identity.nickname}（${identity.id}）已经是管理员 —— 超管绑定无需额外操作。`);
} else {
  const now = Date.now();
  const info = db
    .prepare(
      `UPDATE users SET role = 'admin', management_version = management_version + 1, updated_at = ?
        WHERE id = ? AND role = 'user' AND account_status = 'active'`,
    )
    .run(now, identity.id);
  console.log(
    info.changes === 1
      ? `已把 ${identity.nickname}（${identity.id}）提升为管理员（部署绑定的超级管理员）。`
      : '未发生变更（条件不满足，可能已被并发修改）。',
  );
}
listUsers();
db.close();
