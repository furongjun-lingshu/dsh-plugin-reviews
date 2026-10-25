/**
 * 收藏夹：默认夹懒创建、历史收藏回填、新建/重名、收藏/移动/取消、跨夹搜索。
 *
 * 鉴别方式：去掉 ensureDefaultFolderInTx 的默认夹创建 → 第一条红；
 * 去掉 setFavorite 的 folder_id 更新 → 「移动收藏夹」红。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertPlugin, insertRepository, insertUser, type TestDb } from './support/db';
import {
  DEFAULT_FAVORITE_FOLDER_NAME,
  createInteractionsService,
} from '../src/server/modules/interactions';
import type { CallerContext } from '../src/server/platform/context';
import { ErrorCodes, isDomainError } from '../src/packages/common/errors';

let ctx: TestDb | null = null;

afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

function setup(): TestDb {
  ctx = createTestDb();
  return ctx;
}

function caller(userId: string): CallerContext {
  return { userId, role: 'user', accountStatus: 'active' };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (e) {
    expect(isDomainError(e)).toBe(true);
    if (isDomainError(e)) expect(e.code).toBe(code);
    return;
  }
  throw new Error(`预期抛出 ${code}，但调用成功了`);
}

describe('收藏夹', () => {
  it('首次访问创建默认收藏夹，历史 NULL 收藏回填', async () => {
    const { db } = setup();
    const user = insertUser(db);
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    // 迁移 0019 之前的收藏：folder_id 为 NULL
    db.prepare('INSERT INTO plugin_favorites (user_id, plugin_id, created_at) VALUES (?, ?, ?)').run(
      user,
      plugin,
      Date.now(),
    );

    const service = createInteractionsService({ db });
    const folders = await service.listFavoriteFolders(caller(user));

    expect(folders).toHaveLength(1);
    expect(folders[0].name).toBe(DEFAULT_FAVORITE_FOLDER_NAME);
    expect(folders[0].isDefault).toBe(true);
    expect(folders[0].count).toBe(1);

    const row = db
      .prepare('SELECT folder_id FROM plugin_favorites WHERE user_id = ? AND plugin_id = ?')
      .get(user, plugin) as { folder_id: string | null };
    expect(row.folder_id).toBe(folders[0].folderId);
  });

  it('创建收藏夹：重名/空白/超长被拒', async () => {
    const { db } = setup();
    const user = insertUser(db);
    const service = createInteractionsService({ db });

    const folder = await service.createFavoriteFolder(caller(user), '我的工具');
    expect(folder.name).toBe('我的工具');
    expect(folder.isDefault).toBe(false);

    await expectCode(service.createFavoriteFolder(caller(user), '我的工具'), ErrorCodes.INPUT_INVALID);
    await expectCode(service.createFavoriteFolder(caller(user), '   '), ErrorCodes.INPUT_INVALID);
    await expectCode(
      service.createFavoriteFolder(caller(user), 'x'.repeat(41)),
      ErrorCodes.INPUT_INVALID,
    );
  });

  it('收藏到指定夹、移动到另一个夹、取消收藏', async () => {
    const { db } = setup();
    const user = insertUser(db);
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    const service = createInteractionsService({ db });

    const a = await service.createFavoriteFolder(caller(user), '夹 A');
    const b = await service.createFavoriteFolder(caller(user), '夹 B');

    await service.setFavorite(caller(user), { pluginId: plugin, folderId: a.folderId });
    let folders = await service.listFavoriteFolders(caller(user));
    expect(folders.find((f) => f.folderId === a.folderId)?.count).toBe(1);
    expect(folders.find((f) => f.folderId === b.folderId)?.count).toBe(0);

    // 移动到 B：同一插件只有一条收藏，只是换夹
    await service.setFavorite(caller(user), { pluginId: plugin, folderId: b.folderId });
    folders = await service.listFavoriteFolders(caller(user));
    expect(folders.find((f) => f.folderId === a.folderId)?.count).toBe(0);
    expect(folders.find((f) => f.folderId === b.folderId)?.count).toBe(1);

    const inA = await service.getFavoriteFolder(caller(user), a.folderId);
    expect(inA.plugins).toHaveLength(0);

    await service.removeFavorite(caller(user), plugin);
    folders = await service.listFavoriteFolders(caller(user));
    expect(folders.reduce((sum, f) => sum + f.count, 0)).toBe(0);
  });

  it('未指定收藏夹时进默认夹', async () => {
    const { db } = setup();
    const user = insertUser(db);
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    const service = createInteractionsService({ db });

    await service.setFavorite(caller(user), { pluginId: plugin });
    const folders = await service.listFavoriteFolders(caller(user));
    const defaultFolder = folders.find((f) => f.isDefault);
    expect(defaultFolder?.count).toBe(1);
  });

  it('收藏夹只能本人访问', async () => {
    const { db } = setup();
    const user1 = insertUser(db);
    const user2 = insertUser(db);
    const service = createInteractionsService({ db });
    const folder = await service.createFavoriteFolder(caller(user1), '私有夹');

    await expectCode(
      service.getFavoriteFolder(caller(user2), folder.folderId),
      ErrorCodes.TARGET_UNAVAILABLE,
    );
  });

  it('收藏页标题搜索：跨收藏夹返回所在收藏夹', async () => {
    const { db } = setup();
    const user = insertUser(db);
    const repo = insertRepository(db);
    const p1 = insertPlugin(db, repo);
    const p2 = insertPlugin(db, repo, 'sub');
    db.prepare('UPDATE plugins SET display_name = ? WHERE id = ?').run('记忆插件', p1);
    db.prepare('UPDATE plugins SET display_name = ? WHERE id = ?').run('天气插件', p2);

    const service = createInteractionsService({ db });
    const folder = await service.createFavoriteFolder(caller(user), '记忆收藏');
    await service.setFavorite(caller(user), { pluginId: p1, folderId: folder.folderId });
    await service.setFavorite(caller(user), { pluginId: p2 });

    const results = await service.searchFavorites(caller(user), '记忆');
    expect(results).toHaveLength(1);
    expect(results[0].displayName).toBe('记忆插件');
    expect(results[0].folderName).toBe('记忆收藏');

    expect(await service.searchFavorites(caller(user), '不存在的标题')).toHaveLength(0);
  });

  it('收藏夹改名：成功、重名拒绝、默认夹可改名', async () => {
    const { db } = setup();
    const user = insertUser(db);
    const service = createInteractionsService({ db });

    const folder = await service.createFavoriteFolder(caller(user), '旧名字');
    const other = await service.createFavoriteFolder(caller(user), '另一个夹');

    await service.renameFavoriteFolder(caller(user), folder.folderId, '新名字');
    let folders = await service.listFavoriteFolders(caller(user));
    expect(folders.find((f) => f.folderId === folder.folderId)?.name).toBe('新名字');

    await expectCode(
      service.renameFavoriteFolder(caller(user), folder.folderId, '另一个夹'),
      ErrorCodes.INPUT_INVALID,
    );
    expect(other.name).toBe('另一个夹');

    const defaultFolder = folders.find((f) => f.isDefault)!;
    await service.renameFavoriteFolder(caller(user), defaultFolder.folderId, '我的默认夹');
    folders = await service.listFavoriteFolders(caller(user));
    expect(folders.find((f) => f.folderId === defaultFolder.folderId)?.name).toBe('我的默认夹');
    expect(folders.find((f) => f.folderId === defaultFolder.folderId)?.isDefault).toBe(true);
  });

  it('删除收藏夹：夹内收藏移到默认夹；默认夹不可删；越权拒绝', async () => {
    const { db } = setup();
    const user = insertUser(db);
    const other = insertUser(db);
    const repo = insertRepository(db);
    const plugin = insertPlugin(db, repo);
    const service = createInteractionsService({ db });

    const folder = await service.createFavoriteFolder(caller(user), '待删除夹');
    await service.setFavorite(caller(user), { pluginId: plugin, folderId: folder.folderId });

    const result = await service.deleteFavoriteFolder(caller(user), folder.folderId);
    expect(result.moved).toBe(1);

    const folders = await service.listFavoriteFolders(caller(user));
    expect(folders.find((f) => f.folderId === folder.folderId)).toBeUndefined();
    const defaultFolder = folders.find((f) => f.isDefault)!;
    expect(defaultFolder.count).toBe(1);

    // 默认夹不可删
    await expectCode(
      service.deleteFavoriteFolder(caller(user), defaultFolder.folderId),
      ErrorCodes.INPUT_INVALID,
    );

    // 别人的夹不可删
    const othersFolder = await service.createFavoriteFolder(caller(other), '别人的夹');
    await expectCode(
      service.deleteFavoriteFolder(caller(user), othersFolder.folderId),
      ErrorCodes.TARGET_UNAVAILABLE,
    );
  });
});
