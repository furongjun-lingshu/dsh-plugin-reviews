/**
 * 插件清单批量导入（管理员）：批次 + 条目（迁移 0031，规范见架构 §49 / 需求 §25）。
 *
 * 四条边界：
 *   1. **预演与导入共用一套检查**：预演只跑检查、不写插件；导入在检查通过后走既有收录服务
 *      （acceptPluginSubmission），不另写一套入库逻辑。
 *   2. **查重按「仓库 + 子路径」**：命中已有插件算**已处理**（item.plugin_id 指过去），不是失败。
 *   3. **预算是借的**：条目处理会打 GitHub API，与每日自动发现共用同一份上游预算
 *      （discoveryBudgetFor）—— 每轮最多处理 maxPlugins 条、请求数到顶就停下，
 *      剩下的留到下一轮（不把定时发现饿死）。
 *   4. **单条重试**：runBatch 只处理 pending，或只处理指定的一条（失败条目可单独重来）。
 */

import { createHash } from 'node:crypto';
import type { SqliteDatabase } from '@/server/platform/db';
import { getDb } from '@/server/platform/db';
import { withRead, withTransaction } from '@/server/platform/tx';
import { newId } from '@/server/platform/id';
import { nowMs } from '@/server/platform/time';
import { err, isDomainError } from '@/packages/common/errors';
import { isAdmin, type CallerContext } from '@/server/platform/context';
import { parseSubmissionUrl, ROOT_PLUGIN_PATH, createCatalogService } from '@/server/modules/catalog';
import { discoveryBudgetFor } from '@/server/modules/catalog/discovery';
import type { CatalogProbe } from '@/server/modules/catalog';
import { createGithubCatalogProbe } from '@/server/adapters/catalog/github-probe';
import { recordOperationInTx } from '@/server/modules/operations';

/** 清单里的一个条目。 */
export interface ImportEntry {
  /** 生效链接（CSV 给了子路径时会拼成 /tree/HEAD/<path>）。 */
  url: string;
  /** 原始输入（排错时给人看）。 */
  source: string;
  /** 批次内固定键：owner/repo[/path]（小写，用于合并重复）。 */
  key: string;
  pluginPath: string;
  note: string | null;
  /** 它在清单里的行号（从 1 开始，报错定位用）。 */
  line: number;
}

export interface ManifestProblem {
  line: number;
  message: string;
}

export interface ParsedManifest {
  entries: ImportEntry[];
  problems: ManifestProblem[];
  /** 因为与前面某行指向同一仓库+路径而被合并掉的行数。 */
  mergedDuplicates: number;
}

function isCsvHeader(line: string): boolean {
  const first = line.split(',')[0]?.trim().toLowerCase() ?? '';
  return first === 'url' || first === '链接';
}

/**
 * 解析清单。格式二选一（产品确认：两种都支持）：
 *   - **一行一个链接**：https://github.com/owner/repo 或 .../tree/main/sub；
 *   - **CSV**：首行 url,path,note（path/note 可空），支持中文表头 链接,子路径,备注。
 *
 * 空行与 # 开头的行忽略。CSV 用简单切分，**不支持带逗号的引号字段** —— 清单里出现逗号
 * 本身就是"该改用一行一链接"的信号，这里按列切并在问题里写明，不猜。
 */
export function parseManifest(text: string): ParsedManifest {
  const lines = String(text ?? '').split(/\r?\n/);
  const entries: ImportEntry[] = [];
  const problems: ManifestProblem[] = [];
  const seen = new Map<string, number>();
  let mergedDuplicates = 0;
  let csv = false;
  let firstContentLine = true;

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) return;

    if (firstContentLine) {
      firstContentLine = false;
      if (isCsvHeader(line)) {
        csv = true;
        return;
      }
    }

    let url = line;
    let path: string | null = null;
    let note: string | null = null;

    if (csv) {
      const cells = line.split(',').map((cell) => cell.trim());
      url = cells[0] ?? '';
      path = cells[1] && cells[1].length > 0 ? cells[1] : null;
      note = cells[2] && cells[2].length > 0 ? cells[2] : null;
    }

    if (!/^https?:\/\//i.test(url)) {
      problems.push({ line: index + 1, message: '不是链接：请填 https://github.com/owner/repo' });
      return;
    }

    const parsed = parseSubmissionUrl(url);
    if ('error' in parsed) {
      problems.push({ line: index + 1, message: parsed.error });
      return;
    }

    const pluginPath = path === null ? parsed.pluginPath : path.replace(/^\/+|\/+$/g, '') || ROOT_PLUGIN_PATH;
    const effectiveUrl =
      pluginPath === parsed.pluginPath
        ? url
        : 'https://github.com/' + parsed.owner + '/' + parsed.repo + '/tree/HEAD/' + pluginPath;

    const key = (parsed.owner + '/' + parsed.repo).toLowerCase() + '/' + pluginPath;
    const previous = seen.get(key);
    if (previous !== undefined) {
      mergedDuplicates += 1;
      problems.push({ line: index + 1, message: '与第 ' + previous + ' 行指向同一仓库与子路径，已合并' });
      return;
    }
    seen.set(key, index + 1);

    entries.push({ url: effectiveUrl, source: url, key, pluginPath, note, line: index + 1 });
  });

  return { entries, problems, mergedDuplicates };
}

export interface ImportBatchView {
  batchId: string;
  mode: 'dry_run' | 'apply';
  createdAt: number;
  counts: { total: number; pending: number; done: number; failed: number };
  items: Array<{
    itemId: string;
    position: number;
    key: string;
    url: string;
    note: string | null;
    state: 'pending' | 'done' | 'failed';
    pluginId: string | null;
    issues: string[];
    updatedAt: number;
  }>;
}

interface ItemRow {
  id: string;
  item_key: string;
  position: number;
  input_metadata: string;
  processing_state: 'pending' | 'done' | 'failed';
  plugin_id: string | null;
  issues: string;
  updated_at: number;
}

function readItems(db: SqliteDatabase, batchId: string): ItemRow[] {
  return db
    .prepare(
      'SELECT id, item_key, position, input_metadata, processing_state, plugin_id, issues, updated_at FROM batch_job_items WHERE batch_id = ? ORDER BY position ASC, id ASC',
    )
    .all(batchId) as ItemRow[];
}

function metaOf(row: ItemRow): { url: string; note: string | null; key: string; line: number } {
  try {
    const parsed = JSON.parse(row.input_metadata) as { url?: unknown; note?: unknown; key?: unknown; line?: unknown };
    return {
      url: typeof parsed.url === 'string' ? parsed.url : '',
      note: typeof parsed.note === 'string' ? parsed.note : null,
      key: typeof parsed.key === 'string' ? parsed.key : row.item_key,
      line: typeof parsed.line === 'number' ? parsed.line : 0,
    };
  } catch {
    return { url: '', note: null, key: row.item_key, line: 0 };
  }
}

function issuesOf(row: ItemRow): string[] {
  try {
    const parsed = JSON.parse(row.issues) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 命中既有插件（仓库 + 子路径）：返回 pluginId 或 null。 */
function findExistingPlugin(db: SqliteDatabase, owner: string, repo: string, pluginPath: string): string | null {
  const row = db
    .prepare(
      'SELECT p.id AS plugin_id FROM plugins p JOIN repositories r ON r.id = p.repository_id WHERE lower(r.full_name) = lower(?) AND p.plugin_path = ?',
    )
    .get(owner + '/' + repo, pluginPath) as { plugin_id: string } | undefined;
  return row?.plugin_id ?? null;
}

/** 探针请求计数：预算到顶就抛 input_invalid，由调用方把本条留待下一轮。 */
function withRequestBudget(probe: CatalogProbe, limit: number, counter: { used: number }): CatalogProbe {
  const guard = () => {
    if (counter.used >= limit) {
      throw err.input('本轮 GitHub 请求预算已用尽，剩余条目留到下一轮。');
    }
    counter.used += 1;
  };
  return {
    async fetchRepository(input) {
      guard();
      return probe.fetchRepository(input);
    },
    async findPluginDirs(input) {
      if (typeof probe.findPluginDirs !== 'function') return [];
      guard();
      return probe.findPluginDirs(input);
    },
    async fetchPluginManifest(input) {
      guard();
      return probe.fetchPluginManifest(input);
    },
  };
}

export function createImportService(deps: { db?: SqliteDatabase; probe?: CatalogProbe } = {}) {
  const db = deps.db ?? getDb();

  /** 写入条目结果（独立小事务：每条结果立即可见，不必等整批跑完）。 */
  function writeItemResult(
    itemId: string,
    state: 'pending' | 'done' | 'failed',
    pluginId: string | null,
    issues: string[],
  ): void {
    withTransaction((tx) => {
      tx.db
        .prepare(
          'UPDATE batch_job_items SET processing_state = ?, plugin_id = ?, issues = ?, state_version = state_version + 1, updated_at = ? WHERE id = ?',
        )
        .run(state, pluginId, JSON.stringify(issues), nowMs(), itemId);
      return { ok: true };
    }, db);
  }

  return {
    /** 新建批次。预演与导入都走这里，差别只在 mode。 */
    async createBatch(
      ctx: CallerContext,
      input: { manifest: string; mode: 'dry_run' | 'apply'; requestKey: string },
    ): Promise<{ batchId: string; entries: number; mergedDuplicates: number; problems: ManifestProblem[] }> {
      if (!isAdmin(ctx)) throw err.forbidden('只有管理员可以启动批量导入。');
      const adminId = ctx.userId;
      if (!adminId) throw err.forbidden('只有管理员可以启动批量导入。');
      if (typeof input.requestKey !== 'string' || input.requestKey.trim().length === 0) {
        throw err.input('缺少请求标识。', [{ path: 'requestKey', message: '必填' }]);
      }
      if (input.mode !== 'dry_run' && input.mode !== 'apply') {
        throw err.input('模式只能是预演或导入。', [{ path: 'mode', message: '取值不合法' }]);
      }
      const manifest = String(input.manifest ?? '');
      if (manifest.trim().length === 0) {
        throw err.input('清单是空的。', [{ path: 'manifest', message: '至少一行链接' }]);
      }

      const parsed = parseManifest(manifest);
      if (parsed.entries.length === 0) {
        throw err.input(
          '清单里没有可用条目。',
          parsed.problems.map((p) => ({ path: 'manifest', message: '第 ' + p.line + ' 行：' + p.message })),
        );
      }

      const digest = createHash('sha256').update(manifest).digest('hex');

      return withTransaction((tx) => {
        const conn = tx.db;
        const existing = conn
          .prepare('SELECT id FROM batch_jobs WHERE requested_by = ? AND request_key = ?')
          .get(adminId, input.requestKey) as { id: string } | undefined;
        if (existing) {
          return {
            batchId: existing.id,
            entries: parsed.entries.length,
            mergedDuplicates: parsed.mergedDuplicates,
            problems: parsed.problems,
          };
        }

        const now = nowMs();
        const batchId = newId(now);
        conn
          .prepare(
            'INSERT INTO batch_jobs (id, requested_by, batch_type, mode, request_key, request_digest, input_manifest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            batchId,
            adminId,
            'plugin_import',
            input.mode,
            input.requestKey,
            digest,
            JSON.stringify({ entries: parsed.entries.length, merged: parsed.mergedDuplicates, problems: parsed.problems }),
            now,
          );

        parsed.entries.forEach((entry, index) => {
          conn
            .prepare(
              'INSERT INTO batch_job_items (id, batch_id, item_key, position, input_metadata, processing_state, issues, state_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
            )
            .run(
              newId(now),
              batchId,
              entry.key,
              index,
              JSON.stringify({ url: entry.url, note: entry.note, key: entry.key, line: entry.line, source: entry.source }),
              'pending',
              '[]',
              now,
              now,
            );
        });

        recordOperationInTx(
          conn,
          {
            actionType: 'plugin.import.batch',
            operationKey: input.requestKey,
            actorKind: 'admin',
            actorUserId: adminId,
            targetType: 'import_batch',
            targetId: batchId,
            targetSnapshot: { mode: input.mode, entries: parsed.entries.length },
            changes: { merged_duplicates: parsed.mergedDuplicates, problems: parsed.problems.length },
            reason: input.mode === 'dry_run' ? '管理员启动插件清单预演' : '管理员启动插件清单批量导入',
          },
          now,
        );

        return {
          batchId,
          entries: parsed.entries.length,
          mergedDuplicates: parsed.mergedDuplicates,
          problems: parsed.problems,
        };
      }, db);
    },

    async getBatch(ctx: CallerContext, batchId: string): Promise<ImportBatchView> {
      if (!isAdmin(ctx)) throw err.forbidden('只有管理员可以查看批量导入。');
      return withRead((conn) => {
        const batch = conn
          .prepare('SELECT id, mode, created_at FROM batch_jobs WHERE id = ?')
          .get(batchId) as { id: string; mode: 'dry_run' | 'apply'; created_at: number } | undefined;
        if (!batch) throw err.unavailable('批次不存在。');
        const rows = readItems(conn, batchId);
        const counts = { total: rows.length, pending: 0, done: 0, failed: 0 };
        for (const row of rows) counts[row.processing_state] += 1;
        return {
          batchId: batch.id,
          mode: batch.mode,
          createdAt: batch.created_at,
          counts,
          items: rows.map((row) => {
            const meta = metaOf(row);
            return {
              itemId: row.id,
              position: row.position,
              key: row.item_key,
              url: meta.url,
              note: meta.note,
              state: row.processing_state,
              pluginId: row.plugin_id,
              issues: issuesOf(row),
              updatedAt: row.updated_at,
            };
          }),
        };
      }, db);
    },

    /**
     * 处理批次：不给 itemId 就按顺序处理 pending（受预算限制）；给了 itemId 就只重试那一条。
     */
    async runBatch(
      ctx: CallerContext,
      batchId: string,
      options: { itemId?: string } = {},
    ): Promise<{ processed: number; done: number; failed: number; pending: number; budgetExhausted: boolean }> {
      if (!isAdmin(ctx)) throw err.forbidden('只有管理员可以运行批量导入。');
      const adminId = ctx.userId;
      if (!adminId) throw err.forbidden('只有管理员可以运行批量导入。');

      const batch = db
        .prepare('SELECT id, mode FROM batch_jobs WHERE id = ?')
        .get(batchId) as { id: string; mode: 'dry_run' | 'apply' } | undefined;
      if (!batch) throw err.unavailable('批次不存在。');

      const budget = discoveryBudgetFor(process.env);
      const allRows = readItems(db, batchId);
      const targets = options.itemId
        ? allRows.filter((row) => row.id === options.itemId)
        : allRows.filter((row) => row.processing_state === 'pending').slice(0, budget.maxPlugins);
      if (targets.length === 0) {
        return {
          processed: 0,
          done: 0,
          failed: 0,
          pending: allRows.filter((r) => r.processing_state === 'pending').length,
          budgetExhausted: false,
        };
      }

      const probe = deps.probe ?? createGithubCatalogProbe();
      const counter = { used: 0 };
      const counted = withRequestBudget(probe, budget.maxRequests, counter);
      const catalog = createCatalogService({ db });

      let done = 0;
      let failed = 0;
      let budgetExhausted = false;

      for (const row of targets) {
        const meta = metaOf(row);
        const parsed = parseSubmissionUrl(meta.url);
        if ('error' in parsed) {
          writeItemResult(row.id, 'failed', null, [parsed.error]);
          failed += 1;
          continue;
        }

        const existing = findExistingPlugin(db, parsed.owner, parsed.repo, parsed.pluginPath);
        if (existing !== null) {
          writeItemResult(row.id, 'done', existing, ['已存在：关联到既有插件']);
          done += 1;
          continue;
        }

        if (batch.mode === 'dry_run') {
          try {
            const repo = await counted.fetchRepository({ owner: parsed.owner, repo: parsed.repo });
            const manifest = await counted.fetchPluginManifest({
              owner: parsed.owner,
              repo: parsed.repo,
              pluginPath: parsed.pluginPath,
            });
            if (!manifest) {
              writeItemResult(row.id, 'failed', null, [
                '目录里没有 package.json' +
                  (parsed.pluginPath === ROOT_PLUGIN_PATH ? '（根目录）；若插件在子目录请给出子目录链接' : ''),
              ]);
              failed += 1;
              continue;
            }
            if (!manifest.bundleExists) {
              writeItemResult(row.id, 'failed', null, ['声明了 dsh.bundle 但文件不存在：' + manifest.bundlePath]);
              failed += 1;
              continue;
            }
            writeItemResult(row.id, 'done', null, [
              '预演通过（未入库）：' +
                repo.fullName +
                (parsed.pluginPath === ROOT_PLUGIN_PATH ? '' : ' / ' + parsed.pluginPath),
            ]);
            done += 1;
          } catch (e) {
            if (isDomainError(e) && e.code === 'input_invalid' && counter.used >= budget.maxRequests) {
              budgetExhausted = true;
              writeItemResult(row.id, 'pending', null, ['本轮请求预算已用尽，留待下一轮']);
              break;
            }
            writeItemResult(row.id, 'failed', null, [e instanceof Error ? e.message : '检查失败']);
            failed += 1;
          }
          continue;
        }

        // apply：走既有收录服务（同一套检查与入库，不另写一份）。
        try {
          const result = await catalog.acceptPluginSubmission(
            ctx,
            { url: meta.url, requestKey: 'import:' + batchId + ':' + row.item_key },
            { probe: counted },
          );
          writeItemResult(row.id, 'done', result.pluginId, [result.created ? '已收录' : '已存在：关联到既有插件']);
          done += 1;
        } catch (e) {
          if (isDomainError(e) && e.code === 'input_invalid' && counter.used >= budget.maxRequests) {
            budgetExhausted = true;
            writeItemResult(row.id, 'pending', null, ['本轮请求预算已用尽，留待下一轮']);
            break;
          }
          writeItemResult(row.id, 'failed', null, [e instanceof Error ? e.message : '收录失败']);
          failed += 1;
        }
      }

      const after = readItems(db, batchId);
      const pending = after.filter((r) => r.processing_state === 'pending').length;

      withTransaction((tx) => {
        recordOperationInTx(
          tx.db,
          {
            actionType: 'plugin.import.run',
            // 时间戳做键在同一毫秒内会撞（连续两次运行会被判 keyReused），用 id 保证唯一。
            operationKey: 'import_run:' + batchId + ':' + newId(),
            actorKind: 'admin',
            actorUserId: adminId,
            targetType: 'import_batch',
            targetId: batchId,
            targetSnapshot: { mode: batch.mode, targets: targets.length },
            changes: { done, failed, pending },
            reason: options.itemId ? '管理员重试单条导入' : '管理员运行批量导入',
          },
          nowMs(),
        );
        return { ok: true };
      }, db);

      return { processed: targets.length, done, failed, pending, budgetExhausted };
    },
  };
}

export type ImportService = ReturnType<typeof createImportService>;
