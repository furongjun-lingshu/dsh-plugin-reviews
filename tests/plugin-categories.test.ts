/**
 * 用途分类（迁移 0010）。
 *
 * 要钉住的三件事（都是线上实测暴露的问题）：
 *  1. **计数按不同仓库**：一个仓库拆 5 个插件，分类的计数仍是 1 —— 否则 monorepo 能把
 *     一个分类放大成"很多人都在用"；
 *  2. **噪声不进口径**：`dsh-plugin` 这类自指 topic 没有分类认领 → 不进 chip 行，
 *     但 `listTopicUsage` 会如实列出它"未被归类"，让运营看得见；
 *  3. **未分类是算出来的**：不落表、不硬编码，随分类认领关系实时变化。
 *
 * ⚠️ 测试用的 topic 一律带 `zz` 前缀：迁移里带了 10 个种子分类（memory / docker / rag…），
 * 用真实词汇当测试数据会撞上种子认领关系，测出来的"未分类"其实已被归类（第一版就踩了）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { insertPlugin, insertRepository, insertUser, createTestDb, type TestDb } from './support/db';
import { createCatalogService, UNCATEGORIZED_CATEGORY } from '../src/server/modules/catalog/service';
import type { CallerContext } from '@/server/platform/context';

let ctx: TestDb | null = null;
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

function adminCaller(db: TestDb['db']): CallerContext {
  const id = insertUser(db, { nickname: '分类管理员', role: 'admin' });
  return { userId: id, role: 'admin', accountStatus: 'active' };
}

function normalCaller(db: TestDb['db']): CallerContext {
  const id = insertUser(db, { nickname: '普通用户' });
  return { userId: id, role: 'user', accountStatus: 'active' };
}

/** 造一个仓库 + 若干插件，并写入 topics。 */
function seedRepo(db: TestDb['db'], topics: string[] | null, pluginCount: number): string {
  const repoId = insertRepository(db, `gh-${Math.random().toString(16).slice(2)}`);
  db.prepare('UPDATE repositories SET topics = ? WHERE id = ?').run(
    topics === null ? null : JSON.stringify(topics),
    repoId,
  );
  for (let i = 0; i < pluginCount; i += 1) {
    insertPlugin(db, repoId, `packages/p${i}`);
  }
  return repoId;
}

const T_MEM = 'zzmemory';
const T_RAG = 'zzrag';
const T_OTHER = 'zzother';
const NOISE = ['dsh-plugin', 'deepseek-harness'];

describe('用途分类：聚合口径', () => {
  it('计数按**不同仓库**，monorepo 不会把分类放大', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createCatalogService({ db });
    const admin = adminCaller(db);

    // 仓库 A：5 个插件；仓库 B：1 个插件 —— 都命中同一个分类
    seedRepo(db, [T_MEM, 'dsh-plugin'], 5);
    seedRepo(db, [T_RAG], 1);

    await service.upsertCategory(admin, { slug: 'zzmem', label: '测试记忆', topics: [T_MEM, T_RAG] }, db);

    const categories = await service.listCategories();
    const mem = categories.find((c) => c.slug === 'zzmem');
    expect(mem).toBeDefined();
    expect(mem!.repositoryCount).toBe(2); // ← 两个仓库，不是六个插件
    expect(mem!.pluginCount).toBe(6);

    // 没有仓库命中的分类不出现（空分类没有信息量）
    expect(categories.find((c) => c.slug === 'security')).toBeUndefined();
  });

  it('噪声 topic 不会变成分类；未归类的关系能被看见', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createCatalogService({ db });
    const admin = adminCaller(db);

    seedRepo(db, NOISE, 2); // 只有自指噪声
    seedRepo(db, [T_MEM], 1);
    await service.upsertCategory(admin, { slug: 'zzmem', label: '测试记忆', topics: [T_MEM] }, db);

    const categories = await service.listCategories();
    expect(categories.map((c) => c.slug)).not.toContain('dsh-plugin');
    expect(categories.map((c) => c.slug)).not.toContain('deepseek-harness');

    const usage = await service.listTopicUsage();
    expect(usage.find((t) => t.topic === 'dsh-plugin')).toMatchObject({ repositoryCount: 1, mapped: false });
    expect(usage.find((t) => t.topic === T_MEM)).toMatchObject({ repositoryCount: 1, mapped: true });

    // 「未分类」= 有插件但一个分类都没命中 → 2 个插件（来自噪声仓库）
    const none = categories.find((c) => c.slug === UNCATEGORIZED_CATEGORY);
    expect(none).toMatchObject({ repositoryCount: 1, pluginCount: 2, label: '未分类' });
  });

  it('插件条目带上分类展示名（同一仓库的多个插件共享同一组分类，且不重复）', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createCatalogService({ db });
    const admin = adminCaller(db);

    seedRepo(db, [T_MEM, T_RAG], 3);
    // 一个分类同时认领两个 topic：同一仓库命中两次，但展示名只能出现一次
    await service.upsertCategory(admin, { slug: 'zzmem', label: '测试记忆', topics: [T_MEM, T_RAG] }, db);

    const page = await service.listPlugins({ page: 1, page_size: 10 });
    expect(page.items).toHaveLength(3);
    for (const item of page.items) {
      expect(item.categories).toEqual(['测试记忆']);
    }
    // 原始 topics 仍然保留（详情页要展示原料）
    const view = await service.getPlugin(page.items[0]!.pluginId);
    expect(view?.topics).toEqual([T_MEM, T_RAG]);
    expect(view?.categories).toEqual(['测试记忆']);
  });
});

describe('用途分类：筛选', () => {
  it('按分类筛只返回命中该分类的插件；未分类筛返回没命中的', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createCatalogService({ db });
    const admin = adminCaller(db);

    seedRepo(db, [T_MEM], 2); // 命中
    seedRepo(db, NOISE, 1); // 未命中（噪声 topic 没有分类认领）
    await service.upsertCategory(admin, { slug: 'zzmem', label: '测试记忆', topics: [T_MEM] }, db);

    const hit = await service.listPlugins({ page: 1, page_size: 10, category: 'zzmem' });
    expect(hit.total).toBe(2);

    const miss = await service.listPlugins({ page: 1, page_size: 10, category: UNCATEGORIZED_CATEGORY });
    expect(miss.total).toBe(1);

    // 原始 tag 筛选仍然可用（旧链接兼容），且口径与分类无关
    const rawTagged = await service.listPlugins({ page: 1, page_size: 10, tag: 'dsh-plugin' });
    expect(rawTagged.total).toBe(1);

    void T_OTHER;
  });

  it('隐藏的分类不参与筛选，也不出现在 chip 行', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createCatalogService({ db });
    const admin = adminCaller(db);

    seedRepo(db, [T_MEM], 1);
    await service.upsertCategory(
      admin,
      { slug: 'zzmem', label: '测试记忆', topics: [T_MEM], isVisible: false },
      db,
    );

    expect((await service.listCategories()).find((c) => c.slug === 'zzmem')).toBeUndefined();
    // 隐藏后，这个插件就落进"未分类"
    expect((await service.listPlugins({ page: 1, page_size: 10, category: 'zzmem' })).total).toBe(0);
    expect((await service.listPlugins({ page: 1, page_size: 10, category: UNCATEGORIZED_CATEGORY })).total).toBe(1);
    // 后台仍然看得见它
    expect((await service.listAllCategories()).find((c) => c.slug === 'zzmem')).toBeDefined();
  });
});

describe('用途分类：后台维护', () => {
  it('新增 / 更新 / 删除；同名 slug 是更新而不是第二条', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createCatalogService({ db });
    const admin = adminCaller(db);

    const created = await service.upsertCategory(
      admin,
      { slug: 'zztools', label: '测试工具', topics: ['zzterminal', 'zztty'], sortOrder: 50 },
      db,
    );
    expect(created).toMatchObject({ slug: 'zztools', label: '测试工具', sortOrder: 50, isVisible: true });

    const updated = await service.upsertCategory(
      admin,
      { slug: 'zztools', label: '测试工具', topics: ['zzterminal', 'zztty', 'zzssh'], sortOrder: 60 },
      db,
    );
    expect(updated.topics).toEqual(['zzterminal', 'zztty', 'zzssh']);
    expect(updated.sortOrder).toBe(60);
    expect((await service.listAllCategories()).filter((c) => c.slug === 'zztools')).toHaveLength(1);

    expect(await service.deleteCategory(admin, 'zztools', db)).toEqual({ deleted: true });
    expect(await service.deleteCategory(admin, 'zztools', db)).toEqual({ deleted: false });
  });

  it('同一毫秒内连续维护同一分类：审计键不撞（曾把合法操作变成 500）', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createCatalogService({ db });
    const admin = adminCaller(db);

    // 冻结时间，逼出"同一毫秒"的场景：删两次同名分类、连续两次 upsert。
    const realNow = Date.now;
    Date.now = () => 1_700_000_000_000;
    try {
      await service.upsertCategory(admin, { slug: 'zzdup', label: '撞键测试', topics: ['zzdup'] }, db);
      await service.upsertCategory(
        admin,
        { slug: 'zzdup', label: '撞键测试', topics: ['zzdup', 'zzdup2'] },
        db,
      );
      expect(await service.deleteCategory(admin, 'zzdup', db)).toEqual({ deleted: true });
      // 第二次删同一分类：返回 deleted:false，而不是抛 request_key_reused
      expect(await service.deleteCategory(admin, 'zzdup', db)).toEqual({ deleted: false });
    } finally {
      Date.now = realNow;
    }

    const rows = db
      .prepare("SELECT COUNT(*) AS c FROM operation_records WHERE action_type IN ('category.upsert','category.delete')")
      .get() as { c: number };
    expect(rows.c).toBe(4);
  });

  it('校验：非法 slug / 空 topics / 保留值 / 重名 / 非管理员 都被拒绝', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const service = createCatalogService({ db });
    const admin = adminCaller(db);
    const normal = normalCaller(db);

    await expect(
      service.upsertCategory(admin, { slug: 'Bad Slug', label: '坏', topics: ['x'] }, db),
    ).rejects.toMatchObject({ code: 'input_invalid' });

    await expect(
      service.upsertCategory(admin, { slug: 'zzempty', label: '空', topics: [] }, db),
    ).rejects.toMatchObject({ code: 'input_invalid' });

    await expect(
      service.upsertCategory(admin, { slug: UNCATEGORIZED_CATEGORY, label: '保留值', topics: ['x'] }, db),
    ).rejects.toMatchObject({ code: 'input_invalid' });

    await expect(
      service.upsertCategory(admin, { slug: 'zzbad', label: '非法 topic', topics: ['Bad Topic!'] }, db),
    ).rejects.toMatchObject({ code: 'input_invalid' });

    // 重名：种子里已有「记忆与知识」，不允许第二个分类叫同一个名字
    await expect(
      service.upsertCategory(admin, { slug: 'zzdup', label: '记忆与知识', topics: ['zzwhatever'] }, db),
    ).rejects.toMatchObject({ code: 'input_invalid' });

    await expect(
      service.upsertCategory(normal, { slug: 'zzok', label: '越权', topics: ['zzx'] }, db),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(service.deleteCategory(normal, 'memory', db)).rejects.toMatchObject({ code: 'forbidden' });

    // 一条都没落库
    expect((await service.listAllCategories()).filter((c) => c.slug.startsWith('zz')).length).toBe(0);
  });

  it('迁移自带的种子分类存在（中文标签 + 认领 topics），且不认领噪声 topic', async () => {
    ctx = createTestDb();
    const service = createCatalogService({ db: ctx.db });
    const all = await service.listAllCategories();
    expect(all.length).toBeGreaterThanOrEqual(10);
    const mem = all.find((c) => c.slug === 'memory');
    expect(mem?.label).toBe('记忆与知识');
    expect(mem?.topics).toContain('memory');
    // 标签唯一（否则 chip 行会出现两个一样的名字）
    expect(new Set(all.map((c) => c.label)).size).toBe(all.length);
    // 噪声 topic 不该被任何种子分类认领
    for (const noisy of ['dsh-plugin', 'deepseek-harness', 'dsh']) {
      for (const c of all) expect(c.topics).not.toContain(noisy);
    }
  });
});
