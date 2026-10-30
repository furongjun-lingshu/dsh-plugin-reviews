/**
 * 插件清单批量导入：解析、预演、导入、查重（仓库+子路径）、单条重试。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertUser, type TestDb } from './support/db';
import { createImportService, parseManifest } from '../src/server/modules/imports';
import type { CatalogProbe } from '../src/server/modules/catalog';
import type { CallerContext } from '@/server/platform/context';
import { ErrorCodes, isDomainError } from '../src/packages/common/errors';

let ctx: TestDb | null = null;
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

function caller(db: TestDb['db'], userId: string): CallerContext {
  const row = db.prepare('SELECT role, account_status FROM users WHERE id = ?').get(userId) as {
    role: 'user' | 'admin';
    account_status: 'active' | 'disabled';
  };
  return { userId, role: row.role, accountStatus: row.account_status };
}

/** 桩探针：只有 `good` 仓库有 package.json 且声明了 dsh.bundle。 */
function stubProbe(options: { withManifest?: boolean } = {}): CatalogProbe {
  const withManifest = options.withManifest !== false;
  return {
    async fetchRepository({ owner, repo }) {
      return {
        githubRepositoryId: 'gh-' + owner + '-' + repo,
        fullName: owner + '/' + repo,
        htmlUrl: 'https://github.com/' + owner + '/' + repo,
        isArchived: false,
        description: null,
        topics: [],
        ownerLogin: owner,
        ownerAvatarUrl: null,
        repoUpdatedAt: null,
      };
    },
    async findPluginDirs() {
      return [];
    },
    async fetchPluginManifest({ owner, repo, pluginPath }) {
      if (!withManifest) return null;
      if (repo !== 'good') return null;
      return {
        bundlePath: (pluginPath === '.' ? '' : pluginPath + '/') + 'dist/index.js',
        bundleExists: true,
        name: 'good-plugin',
        description: null,
        author: owner,
        version: '1.0.0',
      };
    },
  };
}

describe('清单解析', () => {
  it('一行一链接：归一化子路径，空行与注释忽略', () => {
    const parsed = parseManifest(
      [
        '# 建站初期清单',
        '',
        'https://github.com/acme/alpha',
        'https://github.com/acme/beta/tree/main/packages/beta',
        'https://github.com/acme/beta/tree/main/packages/beta',
      ].join('\n'),
    );
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].key).toBe('acme/alpha/.');
    expect(parsed.entries[1].key).toBe('acme/beta/packages/beta');
    // 第三条与第二条同键 → 合并
    expect(parsed.mergedDuplicates).toBe(1);
    expect(parsed.problems.some((p) => p.message.includes('已合并'))).toBe(true);
  });

  it('CSV：首行表头，path 覆盖链接里的路径，非法行进问题清单', () => {
    const parsed = parseManifest(
      ['url,path,note', 'https://github.com/acme/gamma,packages/gamma,主插件', 'not-a-url,,', 'https://example.com/x/y,,'].join('\n'),
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].pluginPath).toBe('packages/gamma');
    expect(parsed.entries[0].url).toContain('/tree/HEAD/packages/gamma');
    expect(parsed.entries[0].note).toBe('主插件');
    expect(parsed.problems.filter((p) => p.line > 1)).toHaveLength(2);
  });
});

describe('批次与执行', () => {
  it('非管理员不能建批次；空清单被拒绝', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const user = insertUser(db);
    const service = createImportService({ db, probe: stubProbe() });

    try {
      await service.createBatch(caller(db, user), {
        manifest: 'https://github.com/acme/alpha',
        mode: 'dry_run',
        requestKey: 'k1',
      });
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.FORBIDDEN);
    }

    const admin = insertUser(db, { role: 'admin' });
    try {
      await service.createBatch(caller(db, admin), { manifest: '   ', mode: 'dry_run', requestKey: 'k2' });
      throw new Error('应当被拒绝');
    } catch (e) {
      expect(isDomainError(e)).toBe(true);
      if (isDomainError(e)) expect(e.code).toBe(ErrorCodes.INPUT_INVALID);
    }
  });

  it('预演：能收的标通过、不是插件的标未通过，且一个都不入库', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const admin = insertUser(db, { role: 'admin' });
    const service = createImportService({ db, probe: stubProbe() });

    const created = await service.createBatch(caller(db, admin), {
      manifest: ['https://github.com/acme/good', 'https://github.com/acme/bad'].join('\n'),
      mode: 'dry_run',
      requestKey: 'dry-1',
    });
    expect(created.entries).toBe(2);

    const result = await service.runBatch(caller(db, admin), created.batchId);
    expect(result.done).toBe(1);
    expect(result.failed).toBe(1);

    const view = await service.getBatch(caller(db, admin), created.batchId);
    expect(view.items[0].state).toBe('done');
    expect(view.items[0].issues.join()).toContain('预演通过');
    expect(view.items[1].state).toBe('failed');
    expect(view.items[1].issues.join()).toContain('package.json');

    // 预演不入库
    const plugins = db.prepare('SELECT COUNT(*) AS c FROM plugins').get() as { c: number };
    expect(plugins.c).toBe(0);
  });

  it('导入：检查通过即收录；重复执行不重复建插件；已有条目关联既有插件', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const admin = insertUser(db, { role: 'admin' });
    const service = createImportService({ db, probe: stubProbe() });

    const created = await service.createBatch(caller(db, admin), {
      manifest: 'https://github.com/acme/good',
      mode: 'apply',
      requestKey: 'apply-1',
    });
    const result = await service.runBatch(caller(db, admin), created.batchId);
    expect(result.done).toBe(1);

    const view = await service.getBatch(caller(db, admin), created.batchId);
    expect(view.items[0].pluginId).toBeTruthy();
    const plugins = db.prepare('SELECT COUNT(*) AS c FROM plugins').get() as { c: number };
    expect(plugins.c).toBe(1);

    // 再建一个批次导入同一链接：不新增插件，直接关联
    const again = await service.createBatch(caller(db, admin), {
      manifest: 'https://github.com/acme/good',
      mode: 'apply',
      requestKey: 'apply-2',
    });
    await service.runBatch(caller(db, admin), again.batchId);
    const after = db.prepare('SELECT COUNT(*) AS c FROM plugins').get() as { c: number };
    expect(after.c).toBe(1);
    const view2 = await service.getBatch(caller(db, admin), again.batchId);
    expect(view2.items[0].state).toBe('done');
    expect(view2.items[0].issues.join()).toContain('已存在');
  });

  it('单条重试：失败条目可以只重试那一条（不影响已成功的）', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const admin = insertUser(db, { role: 'admin' });

    // 第一次：探针读不到清单 → 两条都失败
    const failing = createImportService({ db, probe: stubProbe({ withManifest: false }) });
    const created = await failing.createBatch(caller(db, admin), {
      manifest: ['https://github.com/acme/good', 'https://github.com/acme/other'].join('\n'),
      mode: 'dry_run',
      requestKey: 'retry-1',
    });
    const first = await failing.runBatch(caller(db, admin), created.batchId);
    expect(first.failed).toBe(2);

    const view = await failing.getBatch(caller(db, admin), created.batchId);
    const target = view.items[0];

    // 第二次：换一个能读到清单的探针，只重试第一条
    const working = createImportService({ db, probe: stubProbe() });
    const retried = await working.runBatch(caller(db, admin), created.batchId, { itemId: target.itemId });
    expect(retried.processed).toBe(1);
    expect(retried.done).toBe(1);

    const afterView = await working.getBatch(caller(db, admin), created.batchId);
    expect(afterView.items[0].state).toBe('done');
    expect(afterView.items[1].state).toBe('failed');
  });
});
