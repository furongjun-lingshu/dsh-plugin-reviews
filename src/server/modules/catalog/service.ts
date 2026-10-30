/**
 * catalog 服务（工作包 GI，契约 已删除的设计稿《模块签名契约》 第 2 节）。
 *
 * 关键不变量：
 *  1. **收录检查必须真的做**：仓库可访问 **且** package.json 有 `dsh.bundle` 声明
 *     **且** 引用的配置文件存在。任何一条不满足即拒绝，不得"先收录再说"。
 *  2. **按 (repository_id, plugin_path) 幂等**：同一仓库同一子路径重复提交
 *     只产生一个 plugin 行，第二次起 created=false 且返回**原插件 ID**。
 *  3. **request_key 去重**：同键同摘要 → 返回原结果（replayed）；同键不同摘要 →
 *     request_key_reused。
 *  4. **外部探针在事务外调用**：better-sqlite3 是同步驱动，事务内做网络请求会长时间持锁。
 *
 * 关于 request_key 去重的落点（必须说明，否则会被当成"漏了不可变表"）：
 * 本切片基线的三张去重表是 `draft_save_receipts` / `content_submissions` /
 * `operation_records`，它们分别绑定草稿、提交与审计，**没有**通用请求回执表。
 * 而本模块的可写范围不含 migrations/**，不得自行建表。因此这里把同一套语义
 * ——「同键同摘要返回原结果，同键不同摘要报 request_key_reused」——落在
 * `operation_records(action_type, operation_key)` 上：它正是审计去重表，
 * 且 (action_type, operation_key) 是 UNIQUE，天然提供并发下的原子性。
 * 摘要存放在该行的 `changes` JSON 里，用于区分"同键同摘要"与"同键不同摘要"。
 */

import type { SqliteDatabase } from '@/server/platform/db';
import { getDb } from '@/server/platform/db';
import { isAdmin, type CallerContext } from '@/server/platform/context';
import { overridesFor } from '@/server/modules/corrections';
import { withRead, withTransaction } from '@/server/platform/tx';
import { digest } from '@/server/platform/digest';
import { newId } from '@/server/platform/id';
import { err } from '@/packages/common/errors';
import { recordOperationInTx } from '@/server/modules/operations';
import { buildPage, type PageResult } from '@/packages/common/result';
import type { AssessmentTier } from '@/packages/common/assessment';
import { ROOT_PLUGIN_PATH, parseSubmissionUrl } from './parse-url';
import type {
  AcceptPluginSubmissionInput,
  AcceptPluginSubmissionResult,
  CallerContextLike,
  CatalogProbe,
  CatalogService,
  PluginCategoryRecord,
  PluginCategorySummary,
  PluginDirectoryQuery,
  PluginSummary,
  PluginTagSummary,
  PluginView,
} from './types';

/** operation_records.action_type：收录动作的固定动作名。 */
export const ACCEPT_PLUGIN_ACTION = 'catalog.accept_plugin_submission';

/** 目录筛选里"未分类"的固定标签值（URL 里也用它，前端与后端共用这一个常量）。 */
export const UNCLASSIFIED_TAG = '__none__';

/**
 * "没有命中任何可见分类"的筛选值（迁移 0010 引入）。
 *
 * 与 `UNCLASSIFIED_TAG` 的区别要记住：
 *   * `UNCLASSIFIED_TAG` = 仓库**没有任何 topics**（原始数据缺失）；
 *   * `UNCATEGORIZED_CATEGORY` = 有 topics，但**没有一个被分类认领**（需要去后台补映射）。
 * 两者都不该被悄悄合并 —— 前者是抓取问题，后者是运营待办。
 */
export const UNCATEGORIZED_CATEGORY = '__none__';

/** 分类 slug 的合法形态：小写字母数字与连字符，2–32 位（要进 URL）。 */
const CATEGORY_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

/** 单个 topic 的合法形态（GitHub 的 topics 规则：小写字母数字 + `-` `_` `.`）。 */
const TOPIC_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** 分类输入的规范化（后台写入前统一校验；错误带字段路径，前端能直接标红）。 */
function normalizeCategorySlug(raw: unknown): string {
  const slug = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (slug === UNCATEGORIZED_CATEGORY) {
    throw err.input('`__none__` 是"未分类"的保留值，不能用作分类标识。', [{ path: 'slug', message: '保留值' }]);
  }
  if (!CATEGORY_SLUG_RE.test(slug)) {
    throw err.input('分类标识需为 2–32 位小写字母/数字/连字符（会进 URL）。', [
      { path: 'slug', message: '取值不合法' },
    ]);
  }
  return slug;
}

function normalizeCategoryLabel(raw: unknown): string {
  const label = typeof raw === 'string' ? raw.trim() : '';
  if (label.length === 0 || label.length > 20) {
    throw err.input('分类名称需为 1–20 个字符。', [{ path: 'label', message: '取值不合法' }]);
  }
  return label;
}

function normalizeCategoryTopics(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw err.input('topics 必须是字符串数组。', [{ path: 'topics', message: '类型不合法' }]);
  }
  const out: string[] = [];
  for (const item of raw) {
    const topic = typeof item === 'string' ? item.trim().toLowerCase() : '';
    if (!TOPIC_RE.test(topic)) {
      throw err.input(`topic 不合法：${String(item).slice(0, 40)}（只允许小写字母/数字/._-，≤64 字符）`, [
        { path: 'topics', message: '取值不合法' },
      ]);
    }
    if (!out.includes(topic)) out.push(topic);
  }
  if (out.length === 0) {
    throw err.input('至少要认领一个 topic，否则这个分类永远不会命中任何仓库。', [
      { path: 'topics', message: '不能为空' },
    ]);
  }
  if (out.length > 50) {
    throw err.input('一个分类最多认领 50 个 topic。', [{ path: 'topics', message: '最多 50 个' }]);
  }
  return out;
}

function normalizeSortOrder(raw: unknown): number {
  if (raw === undefined) return 100;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 9999) {
    throw err.input('排序值需为 0–9999 的整数。', [{ path: 'sortOrder', message: '取值不合法' }]);
  }
  return raw;
}

/**
 * **公开评测计数**：目录里唯一的判据来源（筛选、排序、卡片数字都用它）。
 *
 * ⚠️ 必须与 `resolveVisibilityInTx`（`src/server/modules/content/index.ts`）**逐条一致**：
 *   存在已发布修订（且修订确实属于该评测）+ **未撤回** + **未隐藏**。
 * 两处判据一旦分叉，就会出现"卡片显示有 2 篇评测，筛选'已有评测'却查不到它"这种自相矛盾。
 * `tests/catalog-browse.test.ts` 用"撤回一篇评测"的用例把这条一致性钉住。
 *
 * 用相关子查询而不是 JOIN + GROUP BY：目录页同时还要按条件过滤与排序，
 * 子查询能在 SELECT / WHERE / ORDER BY 三处复用同一个表达式，避免三份手写 SQL 漂移。
 */
const PUBLIC_REVIEW_COUNT_SQL = `(
  SELECT COUNT(*)
    FROM reviews r
    JOIN review_revisions rev ON rev.id = r.published_revision_id
    JOIN content_entities ce ON ce.id = r.id
   WHERE r.plugin_id = p.id
     AND r.published_revision_id IS NOT NULL
     AND rev.review_id = r.id
     AND ce.withdrawn_at IS NULL
     AND ce.hidden_at IS NULL
)`;

/**
 * 公开修订的**档位聚合**（与 PUBLIC_REVIEW_COUNT_SQL 同一可见性口径）：
 *  - 0 = 没有档位或只有「仅安全审计」；1 = 快测；2 = 标准测评 / 深度审计。
 */
const PUBLIC_ASSESSMENT_TIER_SQL = `(
  SELECT COALESCE(MAX(CASE rev.assessment_level
                        WHEN 'standard' THEN 2
                        WHEN 'deep' THEN 2
                        WHEN 'quick' THEN 1
                        ELSE 0 END), 0)
    FROM reviews r
    JOIN review_revisions rev ON rev.id = r.published_revision_id
    JOIN content_entities ce ON ce.id = r.id
   WHERE r.plugin_id = p.id
     AND r.published_revision_id IS NOT NULL
     AND rev.review_id = r.id
     AND ce.withdrawn_at IS NULL
     AND ce.hidden_at IS NULL
)`;

/** 公开修订中带安全审计的篇数（deep / security）。 */
const PUBLIC_SECURITY_AUDIT_COUNT_SQL = `(
  SELECT COUNT(*)
    FROM reviews r
    JOIN review_revisions rev ON rev.id = r.published_revision_id
    JOIN content_entities ce ON ce.id = r.id
   WHERE r.plugin_id = p.id
     AND r.published_revision_id IS NOT NULL
     AND rev.review_id = r.id
     AND ce.withdrawn_at IS NULL
     AND ce.hidden_at IS NULL
     AND rev.assessment_level IN ('deep','security')
)`;

/** 公开修订中**带档位**的篇数（区分「未测评」与「未标注档位」）。 */
const PUBLIC_ASSESSED_COUNT_SQL = `(
  SELECT COUNT(rev.assessment_level)
    FROM reviews r
    JOIN review_revisions rev ON rev.id = r.published_revision_id
    JOIN content_entities ce ON ce.id = r.id
   WHERE r.plugin_id = p.id
     AND r.published_revision_id IS NOT NULL
     AND rev.review_id = r.id
     AND ce.withdrawn_at IS NULL
     AND ce.hidden_at IS NULL
)`;

/**
 * 三个聚合读数 → 插件标签。
 *
 * 口径（与 assessment 模块的 aggregateAssessment 一致）：
 *  - 没有任何公开评测 → 未测评 + 未安全审计；
 *  - 有公开评测但全部无档位（历史数据）→ 未标注档位 + 安全审计未标注（不猜）；
 *  - 档位取最高；安全审计任一 deep/security 即已审计，
 *    否则仍有历史无档位修订时为未标注，全部带档位且都不含安全审计时为未安全审计。
 */
export function assessmentBadgeOf(input: {
  publicReviewCount: number;
  tierValue: number;
  securityCount: number;
  assessedCount: number;
}): { assessmentTier: AssessmentTier; securityAudit: boolean | null } {
  if (input.publicReviewCount === 0) return { assessmentTier: 'none', securityAudit: false };
  if (input.assessedCount === 0) return { assessmentTier: 'unlabelled', securityAudit: null };
  const assessmentTier: AssessmentTier =
    input.tierValue >= 2 ? 'standard' : input.tierValue === 1 ? 'quick' : 'none';
  const securityAudit =
    input.securityCount > 0 ? true : input.assessedCount < input.publicReviewCount ? null : false;
  return { assessmentTier, securityAudit };
}

/**
 * 转义 `LIKE` 的通配符。
 *
 * 不转义的后果很具体：用户在搜索框里输入一个 `%`，`LIKE '%%%'` 会匹配**全表**，
 * 看起来像"搜索失效"；输入 `_` 会匹配任意单字符。这里把 `\` `%` `_` 都加上反斜杠前缀，
 * SQL 侧统一用 `ESCAPE '\'`。
 */
export function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** topics 列（JSON 数组文本）→ 字符串数组；坏数据一律按"没有标签"处理，绝不抛错。 */
export function parseTopics(raw: string | null): string[] {  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * 批量取「仓库 → 命中的分类展示名」映射（**一次查询**，避免 N+1）。
 *
 * 为什么按仓库算而不是按插件算：分类来自仓库级 topics，同一仓库的 11 个 packages
 * 会得到**同一组**分类。按仓库查一次再分发，既省查询也保证同仓插件分类完全一致。
 */
function categoriesByRepository(conn: SqliteDatabase, repositoryIds: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (repositoryIds.length === 0) return out;
  const placeholders = repositoryIds.map(() => '?').join(', ');
  const rows = conn
    .prepare(
      `SELECT DISTINCT r.id AS repository_id, c.slug, c.label, c.sort_order
         FROM repositories r
         JOIN json_each(r.topics) rt
         JOIN plugin_categories c ON c.is_visible = 1
         JOIN json_each(c.topics) ct ON ct.value = rt.value
        WHERE r.id IN (${placeholders})
        ORDER BY c.sort_order ASC, c.slug ASC`,
    )
    .all(...repositoryIds) as Array<{ repository_id: string; slug: string; label: string }>;
  for (const row of rows) {
    const list = out.get(row.repository_id) ?? [];
    list.push(row.label);
    out.set(row.repository_id, list);
  }
  return out;
}

/** 由浏览条件拼出 WHERE 子句与参数（计数与取列表**共用**，保证 total 与 items 口径一致）。 */
export function buildDirectoryWhere(req: PluginDirectoryQuery): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  const keyword = req.q?.trim();
  if (keyword) {
    const like = `%${escapeLikePattern(keyword)}%`;
    conditions.push(
      `(p.display_name LIKE ? ESCAPE '\\' OR r.full_name LIKE ? ESCAPE '\\' OR COALESCE(p.description, r.description) LIKE ? ESCAPE '\\')`,
    );
    params.push(like, like, like);
  }

  if (req.tag === UNCLASSIFIED_TAG) {
    conditions.push('r.topics IS NULL');
  } else if (req.tag) {
    conditions.push('EXISTS (SELECT 1 FROM json_each(r.topics) je WHERE je.value = ?)');
    params.push(req.tag);
  }

  // 分类筛选（迁移 0010）：一条 SQL 表达"该仓库的任一 topic 被该分类认领"。
  // `json_each(NULL)` 不产生行，所以没有 topics 的仓库自然不会被任何分类命中 ✓。
  const category = req.category?.trim();
  if (category === UNCATEGORIZED_CATEGORY) {
    conditions.push(
      `NOT EXISTS (
         SELECT 1 FROM plugin_categories c, json_each(c.topics) ct
          WHERE c.is_visible = 1
            AND ct.value IN (SELECT value FROM json_each(r.topics))
       )`,
    );
  } else if (category) {
    conditions.push(
      `EXISTS (
         SELECT 1 FROM plugin_categories c, json_each(c.topics) ct
          WHERE c.is_visible = 1 AND c.slug = ?
            AND ct.value IN (SELECT value FROM json_each(r.topics))
       )`,
    );
    params.push(category);
  }

  if (req.hasReviews === 'yes') conditions.push(`${PUBLIC_REVIEW_COUNT_SQL} > 0`);
  if (req.hasReviews === 'no') conditions.push(`${PUBLIC_REVIEW_COUNT_SQL} = 0`);

  // 档位筛选与插件标签同一口径：快测=最高档 1；标测=最高档 2。
  if (req.assessment === 'quick') conditions.push(`${PUBLIC_ASSESSMENT_TIER_SQL} = 1`);
  if (req.assessment === 'standard') conditions.push(`${PUBLIC_ASSESSMENT_TIER_SQL} = 2`);
  // 安全审计单独一栏：yes=存在 deep/security；no=完全没有。
  if (req.security === 'yes') conditions.push(`${PUBLIC_SECURITY_AUDIT_COUNT_SQL} > 0`);
  if (req.security === 'no') conditions.push(`${PUBLIC_SECURITY_AUDIT_COUNT_SQL} = 0`);

  const clause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { clause, params };
}

/**
 * 收录的**共享实现**（用户路径与系统路径共用同一套检查与入库）。
 *
 * 两条路径的差别在这里显式参数化：
 *   - actor.kind：用户路径 user、自动发现 system；
 *   - actor.userId：系统路径必须是 null（operation_records 的 CHECK 要求
 *     actor_kind='system' AND actor_user_id IS NULL）；
 *   - actor.operationKey：用户路径 = requestKey（有同键重放语义）；系统路径 = 每轮唯一的键
 *     （发现每轮都该留一条自己的审计；任务层按天去重保证一天只跑一轮）；
 *   - actor.taskId：系统路径带上触发它的任务，事后能顺着任务查回整轮发现。
 */
interface AcceptActor {
  kind: 'user' | 'system';
  userId: string | null;
  operationKey: string;
  reason: string;
  taskId: string | null;
}

type ParsedSubmission = { owner: string; repo: string; pluginPath: string };

async function runAccept(params: {
  db: SqliteDatabase;
  probe: CatalogProbe;
  url: string;
  parsed: ParsedSubmission;
  requestDigest: string;
  actor: AcceptActor;
}): Promise<AcceptPluginSubmissionResult> {
  const { db, probe, parsed, requestDigest, actor } = params;

      // ---- 收录检查（事务外：网络调用不得占用写事务）----
      // 1) 仓库可访问
      const repoInfo = await probe.fetchRepository({ owner: parsed.owner, repo: parsed.repo });
      if (!repoInfo || typeof repoInfo.githubRepositoryId !== 'string' || repoInfo.githubRepositoryId.trim().length === 0) {
        throw err.providerDown('无法确认仓库身份，收录已中止。');
      }
      // 归档仓库不许收录：归档意味着不再接受变更，收录后无法维护。
      if (repoInfo.isArchived) {
        throw err.unavailable('该仓库已归档，不接受新的插件收录。');
      }

      // 2) package.json 有 dsh.bundle 声明
      const manifest = await probe.fetchPluginManifest({
        owner: parsed.owner,
        repo: parsed.repo,
        pluginPath: parsed.pluginPath,
      });
      if (manifest === null) {
        // 只填了仓库根链接时，先探子目录：monorepo 把插件放在 examples/、packages/ 之类很常见。
        // 直接报"未声明 dsh.bundle"会让人以为这个仓库不是 DSH 插件（实际上只是路径没指到）。
        if (parsed.pluginPath === ROOT_PLUGIN_PATH && typeof probe.findPluginDirs === 'function') {
          // 探测是"帮用户找路径"的辅助：它失败时只应退回原理由，
          // 不该把一次正常的拒绝变成 500（探测本身要读树 + 若干清单，失败概率不低）。
          let dirs: string[] = [];
          try {
            dirs = await probe.findPluginDirs({ owner: parsed.owner, repo: parsed.repo });
          } catch {
            dirs = [];
          }
          if (dirs.length === 1) {
            const full = `https://github.com/${parsed.owner}/${parsed.repo}/tree/HEAD/${dirs[0]}`;
            throw err.input(
              `这个仓库的 DSH 插件在子目录 ${dirs[0]}，不在根目录。请改用这个链接提交：${full}`,
              [{ path: 'url', message: `请把链接填到子目录 ${dirs[0]}。` }],
            );
          }
          if (dirs.length > 1) {
            throw err.input(
              `这个仓库里有多个 DSH 插件：${dirs.join('、')}。请把链接填到具体的那一个子目录。`,
              [{ path: 'url', message: `候选子目录：${dirs.join('、')}。` }],
            );
          }
        }
        throw err.input(
          '该目录下的 package.json 没有声明 dsh.bundle，无法作为 DSH 插件收录。',
          [{ path: 'url', message: `路径 ${parsed.pluginPath} 未声明 dsh.bundle。` }],
        );
      }
      const bundlePath = typeof manifest.bundlePath === 'string' ? manifest.bundlePath.trim() : '';
      if (bundlePath.length === 0) {
        throw err.input('dsh.bundle 声明为空，无法确定插件配置文件。', [
          { path: 'url', message: 'dsh.bundle 必须指向具体文件。' },
        ]);
      }
      // 3) 引用的配置文件存在
      if (manifest.bundleExists !== true) {
        throw err.input(`dsh.bundle 引用的配置文件不存在：${bundlePath}`, [
          { path: 'url', message: `未找到 ${bundlePath}。` },
        ]);
      }

      const now = Date.now();
      const pluginPath = parsed.pluginPath === ROOT_PLUGIN_PATH ? ROOT_PLUGIN_PATH : parsed.pluginPath;

      // ---- 入库（单事务）：仓库 upsert + 插件幂等 + 回执 ----
      return withTransaction(
        (tx) => {
          const existingRepo = tx.db
            .prepare('SELECT id FROM repositories WHERE github_repository_id = ?')
            .get(repoInfo.githubRepositoryId) as { id: string } | undefined;

          let repositoryId: string;
          // 展示字段（迁移 0005）：空数组按"没有标签"存 NULL，避免 '[]' 与"有标签但都非法"混为一谈。
          const topicsJson = repoInfo.topics.length > 0 ? JSON.stringify(repoInfo.topics) : null;
          if (existingRepo) {
            repositoryId = existingRepo.id;
            tx.db
              .prepare(
                `UPDATE repositories
                    SET full_name = ?, html_url = ?, is_archived = ?,
                        description = ?, topics = ?, owner_login = ?, owner_avatar_url = ?, repo_updated_at = ?,
                        availability_state = 'available', last_checked_at = ?, last_successful_check_at = ?, updated_at = ?
                  WHERE id = ?`,
              )
              .run(
                repoInfo.fullName,
                repoInfo.htmlUrl,
                repoInfo.isArchived ? 1 : 0,
                repoInfo.description,
                topicsJson,
                repoInfo.ownerLogin,
                repoInfo.ownerAvatarUrl,
                repoInfo.repoUpdatedAt,
                now,
                now,
                now,
                repositoryId,
              );
          } else {
            repositoryId = newId(now);
            tx.db
              .prepare(
                `INSERT INTO repositories
                   (id, github_repository_id, full_name, html_url, is_archived, availability_state,
                    description, topics, owner_login, owner_avatar_url, repo_updated_at,
                    last_checked_at, last_successful_check_at, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, 'available', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                repositoryId,
                repoInfo.githubRepositoryId,
                repoInfo.fullName,
                repoInfo.htmlUrl,
                repoInfo.isArchived ? 1 : 0,
                repoInfo.description,
                topicsJson,
                repoInfo.ownerLogin,
                repoInfo.ownerAvatarUrl,
                repoInfo.repoUpdatedAt,
                now,
                now,
                now,
                now,
              );
          }

          // 幂等核心：先按 (repository_id, plugin_path) 查；命中即复用，
          // 只更新 updated_at（资料同步），绝不新建第二行。
          const existingPlugin = tx.db
            .prepare('SELECT id, created_at FROM plugins WHERE repository_id = ? AND plugin_path = ?')
            .get(repositoryId, pluginPath) as { id: string; created_at: number } | undefined;

          let pluginId: string;
          let created: boolean;
          if (existingPlugin) {
            pluginId = existingPlugin.id;
            created = false;
            // 命中既有条目 = 一次"资料刷新"：展示字段一起更新，并推进 info_updated_at
            // （页面上的"资料更新时间"以它为准，而不是每次随便 touch 的 updated_at）。
            // ⚠️ 管理员修正过的字段**不写**（迁移 0015）：同步值只写没被覆盖的列，
            // 否则下一次刷新会把修正冲掉，而 override 表里的"谁改的、为什么"还留着 —— 数据与记录就对不上。
            const ov = overridesFor(tx.db, [pluginId]).get(pluginId) ?? {};
            const setClauses = ['updated_at = ?', 'author_login = ?', 'manifest_version = ?', 'info_updated_at = ?'];
            const setArgs: unknown[] = [now, manifest.author, manifest.version, now];
            if (ov.display_name === undefined) {
              setClauses.push('display_name = ?');
              setArgs.push(manifest.name);
            }
            if (ov.description === undefined) {
              setClauses.push('description = ?');
              setArgs.push(manifest.description);
            }
            setArgs.push(pluginId);
            tx.db.prepare(`UPDATE plugins SET ${setClauses.join(', ')} WHERE id = ?`).run(...setArgs);
          } else {
            pluginId = newId(now);
            created = true;
            tx.db
              .prepare(
                `INSERT INTO plugins
                   (id, repository_id, plugin_path, created_at, updated_at,
                    display_name, description, author_login, manifest_version, info_updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                pluginId,
                repositoryId,
                pluginPath,
                now,
                now,
                manifest.name,
                manifest.description,
                manifest.author,
                manifest.version,
                now,
              );
          }

          // 回执：target_type 携带 repositoryId 以便重放还原；
          // changes 内保存请求摘要，用于区分同键同摘要与同键不同摘要。
          const already = tx.db
            .prepare('SELECT 1 AS x FROM operation_records WHERE action_type = ? AND operation_key = ?')
            .get(ACCEPT_PLUGIN_ACTION, params.actor.operationKey) as { x: number } | undefined;
          if (!already) {
            tx.db
              .prepare(
                `INSERT INTO operation_records
                   (id, action_type, operation_key, actor_kind, actor_user_id, target_type, target_id,
                    target_snapshot, changes, reason, task_id, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                newId(now),
                ACCEPT_PLUGIN_ACTION,
                params.actor.operationKey,
                params.actor.kind,
                params.actor.userId,
                `plugin:${repositoryId}`,
                pluginId,
                JSON.stringify({ url: params.url, owner: parsed.owner, repo: parsed.repo, plugin_path: pluginPath }),
                JSON.stringify({ request_digest: requestDigest, created, bundle_path: bundlePath }),
                actor.reason,
                actor.taskId,
                now,
              );
          }

          return { pluginId, repositoryId, created, replayed: false, status: 'accepted' as const };
        },
        db,
      );
}

export interface CatalogServiceDeps {
  /** 显式连接（测试用真实临时库）。省略时回退平台单例。 */
  db?: SqliteDatabase;
}

interface OperationRow {
  target_id: string;
  changes: string;
}

export function createCatalogService(deps: CatalogServiceDeps = {}): CatalogService {
  const db: SqliteDatabase = deps.db ?? getDb();

  /** 读取已存在的回执行；返回其记录的摘要。 */
  function receiptDigest(operationKey: string): string | null {
    const row = db
      .prepare('SELECT target_id, changes FROM operation_records WHERE action_type = ? AND operation_key = ?')
      .get(ACCEPT_PLUGIN_ACTION, operationKey) as OperationRow | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.changes) as { request_digest?: unknown };
      return typeof parsed.request_digest === 'string' ? parsed.request_digest : null;
    } catch {
      return null;
    }
  }

  return {
    parseSubmissionUrl,

    async acceptPluginSubmission(
      ctx: CallerContextLike,
      input: AcceptPluginSubmissionInput,
      probeDeps: { probe: CatalogProbe },
    ): Promise<AcceptPluginSubmissionResult> {
      // ---- 前置校验：写操作必须登录且账户正常（DomainError，不是裸 Error）----
      if (ctx == null || ctx.userId === null) throw err.unauthenticated('收录插件需要先登录。');
      if (ctx.accountStatus !== 'active') throw err.disabled();
      if (typeof input.requestKey !== "string" || input.requestKey.trim().length === 0) {
        throw err.input('缺少请求标识。', [{ path: 'request_key', message: '必填且不能为纯空白。' }]);
      }
      if (probeDeps == null || probeDeps.probe == null) {
        // 没有探针就无法完成"收录检查"。此时**不能**放行，否则等于关掉收录门槛。
        throw err.notConfigured('未提供 GitHub 探针，无法完成收录检查。');
      }

      const parsed = parseSubmissionUrl(input.url);
      if ('error' in parsed) {
        throw err.input(parsed.error, [{ path: 'url', message: parsed.error }]);
      }

      // ---- 请求去重（第一步）：同键同摘要 → 原结果；同键不同摘要 → 冲突 ----
      const requestDigest = digest({ url: parsed, operation: ACCEPT_PLUGIN_ACTION });
      const priorDigest = receiptDigest(input.requestKey);
      if (priorDigest !== null) {
        if (priorDigest !== requestDigest) {
          throw err.keyReused('同一请求标识已被用于另一次收录提交。');
        }
        const replay = db
          .prepare('SELECT target_type, target_id FROM operation_records WHERE action_type = ? AND operation_key = ?')
          .get(ACCEPT_PLUGIN_ACTION, input.requestKey) as { target_type: string; target_id: string } | undefined;
        // target_type 形如 'plugin:<repositoryId>'，重放时据此还原原结果。
        if (replay) {
          const separator = replay.target_type.indexOf(':');
          const repositoryId = separator >= 0 ? replay.target_type.slice(separator + 1) : '';
          return { pluginId: replay.target_id, repositoryId, created: false, replayed: true, status: 'accepted' };
        }
      }

      return runAccept({
        db,
        probe: probeDeps.probe,
        url: input.url,
        parsed,
        requestDigest,
        actor: {
          kind: 'user',
          userId: ctx.userId,
          operationKey: input.requestKey,
          reason: '用户提交插件收录。',
          taskId: null,
        },
      });
    },

    /**
     * **系统路径**收录（插件目录自动发现用）。
     *
     * 与用户路径共用同一套收录检查与入库（见 runAccept）；差别只在审计与额度：
     *   - 审计记 actor_kind='system' + actor_user_id=NULL + task_id（数据库 schema 本来就支持）；
     *   - **不做同键重放**：发现每轮的 operationKey 都不同，靠任务层的按天去重保证一天只跑一轮；
     *   - **不占单个用户的 10 次/时额度**（参数与管理规则.md 第 29 行：定时发现走系统调度预算）；
     *   - 只允许在服务端调用（**没有**对应的 HTTP 路由）。
     */
    async acceptPluginSubmissionBySystem(
      input: { url: string; operationKey: string; taskId: string | null; reason?: string },
      probeDeps: { probe: CatalogProbe },
    ): Promise<AcceptPluginSubmissionResult> {
      if (typeof input.operationKey !== "string" || input.operationKey.trim().length === 0) {
        throw err.input('系统收录需要审计键。', [{ path: 'operation_key', message: '必填且不能为纯空白。' }]);
      }
      if (probeDeps == null || probeDeps.probe == null) {
        throw err.notConfigured('未提供 GitHub 探针，无法完成收录检查。');
      }

      const parsed = parseSubmissionUrl(input.url);
      if ('error' in parsed) {
        throw err.input(parsed.error, [{ path: 'url', message: parsed.error }]);
      }

      return runAccept({
        db,
        probe: probeDeps.probe,
        url: input.url,
        parsed,
        requestDigest: digest({ url: parsed, operation: ACCEPT_PLUGIN_ACTION }),
        actor: {
          kind: 'system',
          userId: null,
          operationKey: input.operationKey,
          reason: input.reason ?? '自动发现收录（系统调度）。',
          taskId: input.taskId,
        },
      });
    },

    async getPlugin(pluginId: string): Promise<PluginView | null> {
      if (typeof pluginId !== 'string' || pluginId.length === 0) return null;
      return withRead((conn) => {
        const row = conn
          .prepare(
            `SELECT p.id AS plugin_id, p.plugin_path, p.created_at AS plugin_created_at, p.updated_at AS plugin_updated_at,
                    p.display_name, p.description AS plugin_description, p.author_login, p.manifest_version, p.info_updated_at,
                    r.id AS repository_id, r.github_repository_id, r.full_name, r.html_url, r.is_archived,
                    r.description AS repo_description, r.topics, r.owner_login, r.owner_avatar_url, r.repo_updated_at,
                    r.availability_state, r.last_checked_at, r.last_successful_check_at,
                    ${PUBLIC_REVIEW_COUNT_SQL} AS public_review_count,
                    ${PUBLIC_ASSESSMENT_TIER_SQL} AS assessment_tier_value,
                    ${PUBLIC_SECURITY_AUDIT_COUNT_SQL} AS security_audit_count,
                    ${PUBLIC_ASSESSED_COUNT_SQL} AS assessed_count
               FROM plugins p
               JOIN repositories r ON r.id = p.repository_id
              WHERE p.id = ?`,
          )
          .get(pluginId) as
          | {
              plugin_id: string;
              plugin_path: string;
              plugin_created_at: number;
              plugin_updated_at: number;
              display_name: string | null;
              plugin_description: string | null;
              author_login: string | null;
              manifest_version: string | null;
              info_updated_at: number | null;
              repository_id: string;
              github_repository_id: string;
              full_name: string;
              html_url: string;
              is_archived: number;
              repo_description: string | null;
              topics: string | null;
              owner_login: string | null;
              owner_avatar_url: string | null;
              repo_updated_at: number | null;
              availability_state: 'unknown' | 'available' | 'unavailable';
              last_checked_at: number | null;
              last_successful_check_at: number | null;
              public_review_count: number;
              assessment_tier_value: number;
              security_audit_count: number;
              assessed_count: number;
            }
          | undefined;
        if (!row) return null;
        // 管理员修正过的字段优先于同步值（迁移 0015）
        const ov = overridesFor(conn, [row.plugin_id]).get(row.plugin_id) ?? {};
        return {
          pluginId: row.plugin_id,
          pluginPath: row.plugin_path,
          createdAt: row.plugin_created_at,
          updatedAt: row.plugin_updated_at,
          displayName: ov.display_name ?? row.display_name,
          description: ov.description ?? row.plugin_description ?? row.repo_description,
          authorLogin: row.author_login,
          manifestVersion: row.manifest_version,
          infoUpdatedAt: row.info_updated_at,
          topics: parseTopics(row.topics),
          categories: categoriesByRepository(conn, [row.repository_id]).get(row.repository_id) ?? [],
          ownerLogin: row.owner_login,
          ownerAvatarUrl: row.owner_avatar_url,
          repoUpdatedAt: row.repo_updated_at,
          ...assessmentBadgeOf({
            publicReviewCount: Number(row.public_review_count ?? 0),
            tierValue: Number(row.assessment_tier_value ?? 0),
            securityCount: Number(row.security_audit_count ?? 0),
            assessedCount: Number(row.assessed_count ?? 0),
          }),
          repository: {
            repositoryId: row.repository_id,
            githubRepositoryId: row.github_repository_id,
            fullName: row.full_name,
            htmlUrl: row.html_url,
            isArchived: row.is_archived === 1,
            availabilityState: row.availability_state,
            lastCheckedAt: row.last_checked_at,
            lastSuccessfulCheckAt: row.last_successful_check_at,
          },
        };
      }, db);
    },

    async listPlugins(req: PluginDirectoryQuery): Promise<PageResult<PluginSummary>> {
      return withRead((conn) => {
        const { clause, params } = buildDirectoryWhere(req);

        const total = conn.prepare(`SELECT COUNT(*) AS c FROM plugins p JOIN repositories r ON r.id = p.repository_id ${clause}`).get(...params) as { c: number };

        // 分页纪律：排序键**必须唯一**（都带 p.id 兜底），否则同 updated_at 的条目翻页会重漏。
        //
        // 带关键词时先按**匹配程度**排（`idea.md §18`："搜索结果优先按关键词匹配程度排列"）：
        //   名称全等 > 名称前缀 > 仓库名前缀 > 其它（名称/简介/仓库名包含）。
        // 相关度参数排在 WHERE 参数之后（SQL 文本顺序决定绑定顺序），最后才是 LIMIT/OFFSET。
        const keyword = req.q?.trim();
        const relevanceParams: string[] = [];
        let relevanceOrder = '';
        if (keyword) {
          const escaped = escapeLikePattern(keyword).toLowerCase();
          relevanceParams.push(keyword.toLowerCase(), `${escaped}%`, `${escaped}%`);
          relevanceOrder = `
            CASE
              WHEN LOWER(COALESCE(p.display_name, '')) = ? THEN 0
              WHEN LOWER(COALESCE(p.display_name, '')) LIKE ? ESCAPE '\\' THEN 1
              WHEN LOWER(r.full_name) LIKE ? ESCAPE '\\' THEN 2
              ELSE 3
            END ASC,`;
        }
        // dir 缺省 = desc（保持旧行为）；相关度排序固定 ASC，方向只作用于主排序键。
        const direction = req.dir === 'asc' ? 'ASC' : 'DESC';
        const orderBy =
          req.sort === 'reviews'
            ? `${relevanceOrder} ${PUBLIC_REVIEW_COUNT_SQL} ${direction}, p.id ASC`
            : `${relevanceOrder} p.updated_at ${direction}, p.id ASC`;

        const rows = conn
          .prepare(
            `SELECT p.id AS plugin_id, p.plugin_path, p.updated_at, p.info_updated_at,
                    p.display_name, p.description AS plugin_description, p.author_login, p.manifest_version,
                    r.id AS repository_id, r.full_name, r.html_url, r.is_archived, r.availability_state,
                    r.description AS repo_description, r.topics, r.owner_login, r.owner_avatar_url, r.repo_updated_at,
                    ${PUBLIC_REVIEW_COUNT_SQL} AS public_review_count,
                    ${PUBLIC_ASSESSMENT_TIER_SQL} AS assessment_tier_value,
                    ${PUBLIC_SECURITY_AUDIT_COUNT_SQL} AS security_audit_count,
                    ${PUBLIC_ASSESSED_COUNT_SQL} AS assessed_count
               FROM plugins p
               JOIN repositories r ON r.id = p.repository_id
               ${clause}
              ORDER BY ${orderBy}
              LIMIT ? OFFSET ?`,
          )
          .all(...params, ...relevanceParams, req.page_size, (req.page - 1) * req.page_size) as {
          plugin_id: string;
          plugin_path: string;
          updated_at: number;
          info_updated_at: number | null;
          display_name: string | null;
          plugin_description: string | null;
          author_login: string | null;
          manifest_version: string | null;
          repository_id: string;
          full_name: string;
          html_url: string;
          is_archived: number;
          availability_state: 'unknown' | 'available' | 'unavailable';
          repo_description: string | null;
          topics: string | null;
          owner_login: string | null;
          owner_avatar_url: string | null;
          repo_updated_at: number | null;
          public_review_count: number;
          assessment_tier_value: number;
          security_audit_count: number;
          assessed_count: number;
        }[];

        // 分类按仓库一次性取好再分发（同一仓库的多个插件共享同一组分类）
        const categoriesMap = categoriesByRepository(
          conn,
          [...new Set(rows.map((r) => r.repository_id))],
        );
        // 管理员修正过的字段优先于同步值（迁移 0015）
        const overrides = overridesFor(conn, rows.map((r) => r.plugin_id));
        const items: PluginSummary[] = rows.map((r) => {
          const ov = overrides.get(r.plugin_id) ?? {};
          return {
          pluginId: r.plugin_id,
          pluginPath: r.plugin_path,
          repositoryFullName: r.full_name,
          repositoryHtmlUrl: r.html_url,
          isArchived: r.is_archived === 1,
          updatedAt: r.updated_at,
          displayName: ov.display_name ?? r.display_name,
          // 插件清单的简介优先；没有才回退仓库简介（**不拼接、不编**）；管理员修正最优先。
          description: ov.description ?? r.plugin_description ?? r.repo_description,
          ownerLogin: r.owner_login,
          ownerAvatarUrl: r.owner_avatar_url,
          topics: parseTopics(r.topics),
          categories: categoriesMap.get(r.repository_id) ?? [],
          authorLogin: r.author_login,
          manifestVersion: r.manifest_version,
          infoUpdatedAt: r.info_updated_at,
          repoUpdatedAt: r.repo_updated_at,
          publicReviewCount: Number(r.public_review_count ?? 0),
          ...assessmentBadgeOf({
            publicReviewCount: Number(r.public_review_count ?? 0),
            tierValue: Number(r.assessment_tier_value ?? 0),
            securityCount: Number(r.security_audit_count ?? 0),
            assessedCount: Number(r.assessed_count ?? 0),
          }),
          availabilityState: r.availability_state,
          };
        });

        return buildPage(items, total.c, req);
      }, db);
    },

    /**
     * 用途标签聚合（筛选 chip 行）。
     *
     * 口径：**直接拿 GitHub topics 当标签**，本切片没有中文分类字典（见
     * docs/HANDOFF.md 的"未做"清单）；没有 topics 的条目归到 `__none__`。
     */
    async listPluginTags(): Promise<PluginTagSummary[]> {
      return withRead((conn) => {
        const rows = conn
          .prepare(
            `SELECT je.value AS tag, COUNT(*) AS c
               FROM plugins p
               JOIN repositories r ON r.id = p.repository_id,
                    json_each(r.topics) je
              WHERE r.topics IS NOT NULL
              GROUP BY je.value
              ORDER BY c DESC, tag ASC`,
          )
          .all() as { tag: string; c: number }[];

        const none = conn
          .prepare(
            `SELECT COUNT(*) AS c FROM plugins p
               JOIN repositories r ON r.id = p.repository_id
              WHERE r.topics IS NULL`,
          )
          .get() as { c: number };

        const out: PluginTagSummary[] = rows.map((r) => ({ tag: r.tag, pluginCount: r.c }));
        if (none.c > 0) out.push({ tag: UNCLASSIFIED_TAG, pluginCount: none.c });
        return out;
      }, db);
    },

    /**
     * 原始 topics 视角：每个 topic 覆盖多少**不同仓库**、是否已被分类认领。
     *
     * 与 `listPluginTags` 的区别：这个按 distinct repository 计数（monorepo 不放大），
     * 并标出 `mapped` —— 后台「分类管理」据此列出"还没归类的 topics"，避免凭空猜分类。
     */
    async listTopicUsage(): Promise<Array<{ topic: string; repositoryCount: number; mapped: boolean }>> {
      return withRead((conn) => {
        const rows = conn
          .prepare(
            `SELECT rt.value AS topic,
                    COUNT(DISTINCT r.id) AS repo_count,
                    EXISTS (
                      SELECT 1 FROM plugin_categories c, json_each(c.topics) ct
                       WHERE ct.value = rt.value
                    ) AS mapped
               FROM repositories r, json_each(r.topics) rt
              GROUP BY rt.value
              ORDER BY repo_count DESC, topic ASC`,
          )
          .all() as Array<{ topic: string; repo_count: number; mapped: number }>;
        return rows.map((r) => ({ topic: r.topic, repositoryCount: r.repo_count, mapped: r.mapped === 1 }));
      }, db);
    },

    /**
     * 可见分类聚合（页面 chip 行）。
     *
     * **计数口径是 distinct repository**：一个仓库拆 11 个 packages 时，如果按插件数算，
     * 这个仓库的话题会让每个分类都 +11 —— 用户看到的是"很多人在用"，实际只有一个仓库。
     */
    async listCategories(): Promise<PluginCategorySummary[]> {
      return withRead((conn) => {
        const rows = conn
          .prepare(
            `SELECT c.slug, c.label, c.sort_order,
                    COUNT(DISTINCT r.id) AS repository_count,
                    COUNT(DISTINCT p.id) AS plugin_count
               FROM plugin_categories c
               JOIN json_each(c.topics) ct
               JOIN repositories r
                 ON EXISTS (SELECT 1 FROM json_each(r.topics) rt WHERE rt.value = ct.value)
               JOIN plugins p ON p.repository_id = r.id
              WHERE c.is_visible = 1
              GROUP BY c.slug, c.label, c.sort_order
              ORDER BY c.sort_order ASC, c.slug ASC`,
          )
          .all() as Array<{
          slug: string;
          label: string;
          sort_order: number;
          repository_count: number;
          plugin_count: number;
        }>;

        const out: PluginCategorySummary[] = rows.map((r) => ({
          slug: r.slug,
          label: r.label,
          repositoryCount: r.repository_count,
          pluginCount: r.plugin_count,
          sortOrder: r.sort_order,
          isVisible: true,
        }));

        // 「未分类」= 有插件、但仓库 topics 没被任何可见分类认领（含 topics 为 NULL 的情况）。
        const none = conn
          .prepare(
            `SELECT COUNT(DISTINCT r.id) AS repository_count, COUNT(DISTINCT p.id) AS plugin_count
               FROM plugins p
               JOIN repositories r ON r.id = p.repository_id
              WHERE NOT EXISTS (
                      SELECT 1 FROM plugin_categories c, json_each(c.topics) ct
                       WHERE c.is_visible = 1
                         AND ct.value IN (SELECT value FROM json_each(r.topics))
                    )`,
          )
          .get() as { repository_count: number; plugin_count: number };
        if (none.plugin_count > 0) {
          out.push({
            slug: UNCATEGORIZED_CATEGORY,
            label: '未分类',
            repositoryCount: none.repository_count,
            pluginCount: none.plugin_count,
            sortOrder: 9_999,
            isVisible: true,
          });
        }
        return out;
      }, db);
    },

    /** 全部分类（含隐藏）—— 后台维护用。 */
    async listAllCategories(): Promise<PluginCategoryRecord[]> {
      return withRead((conn) => {
        const rows = conn
          .prepare(
            `SELECT c.slug, c.label, c.topics, c.sort_order, c.is_visible, c.updated_at,
                    (SELECT COUNT(DISTINCT r.id)
                       FROM repositories r, json_each(r.topics) rt
                      WHERE rt.value IN (SELECT value FROM json_each(c.topics))) AS repository_count,
                    (SELECT COUNT(DISTINCT p.id)
                       FROM plugins p
                       JOIN repositories r ON r.id = p.repository_id
                      WHERE EXISTS (SELECT 1 FROM json_each(r.topics) rt
                                     WHERE rt.value IN (SELECT value FROM json_each(c.topics)))) AS plugin_count
               FROM plugin_categories c
              ORDER BY c.sort_order ASC, c.slug ASC`,
          )
          .all() as Array<{
          slug: string;
          label: string;
          topics: string;
          sort_order: number;
          is_visible: number;
          updated_at: number;
          repository_count: number;
          plugin_count: number;
        }>;
        return rows.map((r) => ({
          slug: r.slug,
          label: r.label,
          topics: parseTopics(r.topics) ?? [],
          repositoryCount: r.repository_count,
          pluginCount: r.plugin_count,
          sortOrder: r.sort_order,
          isVisible: r.is_visible === 1,
          updatedAt: r.updated_at,
        }));
      }, db);
    },

    /** 新增或更新分类（管理员）。slug 是主键，冲突即更新。 */
    async upsertCategory(
      ctx: CallerContext,
      input: { slug: string; label: string; topics: string[]; sortOrder?: number; isVisible?: boolean },
      injectedDb?: SqliteDatabase,
    ): Promise<PluginCategoryRecord> {
      if (!isAdmin(ctx)) throw err.forbidden('只有管理员可以维护用途分类。');
      const adminId = ctx.userId;
      if (!adminId) throw err.forbidden('只有管理员可以维护用途分类。');
      const slug = normalizeCategorySlug(input.slug);
      const label = normalizeCategoryLabel(input.label);
      const topics = normalizeCategoryTopics(input.topics);
      const sortOrder = normalizeSortOrder(input.sortOrder);
      const isVisible = input.isVisible === undefined ? true : input.isVisible === true;
      const now = Date.now();

      const run = (conn: SqliteDatabase): PluginCategoryRecord => {
        // 重名校验：两个分类同名会让 chip 行出现两个一模一样的项，用户无法区分。
        // 这里**拒绝**而不是自动改名 —— 自动改名会悄悄改变线上展示，运营更难排查。
        const clash = conn
          .prepare('SELECT slug FROM plugin_categories WHERE label = ? AND slug <> ?')
          .get(label, slug) as { slug: string } | undefined;
        if (clash) {
          throw err.input(`分类名称「${label}」已被分类 ${clash.slug} 使用。`, [
            { path: 'label', message: '与既有分类重名' },
          ]);
        }

        conn
          .prepare(
            `INSERT INTO plugin_categories (slug, label, topics, sort_order, is_visible, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (slug) DO UPDATE SET
               label = excluded.label,
               topics = excluded.topics,
               sort_order = excluded.sort_order,
               is_visible = excluded.is_visible,
               updated_at = excluded.updated_at`,
          )
          .run(slug, label, JSON.stringify(topics), sortOrder, isVisible ? 1 : 0, now, now);

        // 审计：分类决定"插件出现在哪个 chip 下"，是线上展示的开关，管理员改动要能查。
        recordOperationInTx(
          conn,
          {
            actionType: 'category.upsert',
            // 键必须**每次唯一**：用时间戳在同一毫秒内会撞（删除两次同名分类的用例就撞了），
            // 撞了会按"同键不同摘要"判为 keyReused，把一次合法操作变成 500。
            operationKey: `category_upsert:${slug}:${newId(now)}`,
            actorKind: 'admin',
            actorUserId: adminId,
            targetType: 'plugin_category',
            targetId: slug,
            targetSnapshot: { slug, label, topics, sort_order: sortOrder, is_visible: isVisible },
            changes: { label, topics, is_visible: isVisible },
            reason: `维护用途分类：${label}`,
          },
          now,
        );

        const row = conn
          .prepare('SELECT slug, label, topics, sort_order, is_visible, updated_at FROM plugin_categories WHERE slug = ?')
          .get(slug) as {
          slug: string;
          label: string;
          topics: string;
          sort_order: number;
          is_visible: number;
          updated_at: number;
        };
        return {
          slug: row.slug,
          label: row.label,
          topics: parseTopics(row.topics) ?? [],
          repositoryCount: 0,
          pluginCount: 0,
          sortOrder: row.sort_order,
          isVisible: row.is_visible === 1,
          updatedAt: row.updated_at,
        };
      };

      if (injectedDb) {
        return withTransaction((tx) => run(tx.db), injectedDb);
      }
      return withTransaction((tx) => run(tx.db), db);
    },

    /** 删除分类（管理员）。看不见的分类同样可删（后台要能清理）。 */
    async deleteCategory(ctx: CallerContext, slug: string, injectedDb?: SqliteDatabase): Promise<{ deleted: boolean }> {
      if (!isAdmin(ctx)) throw err.forbidden('只有管理员可以维护用途分类。');
      const adminId = ctx.userId;
      if (!adminId) throw err.forbidden('只有管理员可以维护用途分类。');
      const normalized = normalizeCategorySlug(slug);
      const run = (conn: SqliteDatabase): { deleted: boolean } => {
        const now = Date.now();
        const result = conn.prepare('DELETE FROM plugin_categories WHERE slug = ?').run(normalized);
        recordOperationInTx(
          conn,
          {
            actionType: 'category.delete',
            operationKey: `category_delete:${normalized}:${newId(now)}`,
            actorKind: 'admin',
            actorUserId: adminId,
            targetType: 'plugin_category',
            targetId: normalized,
            targetSnapshot: { slug: normalized },
            changes: { deleted: result.changes > 0 },
            reason: `删除用途分类：${normalized}`,
          },
          now,
        );
        return { deleted: result.changes > 0 };
      };
      if (injectedDb) {
        return withTransaction((tx) => run(tx.db), injectedDb);
      }
      return withTransaction((tx) => run(tx.db), db);
    },
  };
}


/**
 * 连续不可访问的阈值（规划 §5.3：连续三轮打不开才算「暂不可访问」）。
 *
 * 为什么是三次：单次失败太容易来自网络抖动/对方 502/限流；而十次才会让一个真下线的插件
 * 在站上挂很久。三轮是"既不被抖动骗，也不拖着坏数据"的折中，且与每日探测的节奏吻合。
 */
export const UNAVAILABLE_ROUNDS_THRESHOLD = 3;

/**
 * 结算一次可达性探测的结果（数据保留 §5.3 的轮次逻辑）。
 *
 * 语义：
 *   - reachable=true  → 连续失败计数归零，状态置 available，记录最近成功时间；
 *   - reachable=false → 计数 +1；**累计到阈值**才把状态置 unavailable，
 *     未到阈值保持原状态（一次失败不足以改变结论，页面上仍显示"最近一次检查失败"）。
 *
 * 只动这三列，不写 operation_records：探测是高频系统行为，审计表留给人工变更
 * （收录、隐藏、用户管理）。要追历史看 last_checked_at 时间线即可。
 */
export function recordAvailabilityRound(
  db: SqliteDatabase,
  repositoryId: string,
  input: { reachable: boolean; now: number },
): { state: 'available' | 'unavailable' | 'unknown'; consecutiveUnavailable: number } {
  return withTransaction((tx) => {
    const row = tx.db
      .prepare(
        'SELECT consecutive_unavailable, availability_state FROM repositories WHERE id = ?',
      )
      .get(repositoryId) as
      | { consecutive_unavailable: number; availability_state: 'unknown' | 'available' | 'unavailable' }
      | undefined;
    if (!row) throw err.unavailable('仓库不存在。');

    if (input.reachable) {
      tx.db
        .prepare(
          `UPDATE repositories
              SET availability_state = 'available', consecutive_unavailable = 0,
                  last_checked_at = ?, last_successful_check_at = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(input.now, input.now, input.now, repositoryId);
      return { state: 'available' as const, consecutiveUnavailable: 0 };
    }

    const next = Number(row.consecutive_unavailable) + 1;
    const state = next >= UNAVAILABLE_ROUNDS_THRESHOLD ? ('unavailable' as const) : row.availability_state;
    tx.db
      .prepare(
        `UPDATE repositories
            SET availability_state = ?, consecutive_unavailable = ?, last_checked_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(state, next, input.now, input.now, repositoryId);
    return { state, consecutiveUnavailable: next };
  }, db);
}
