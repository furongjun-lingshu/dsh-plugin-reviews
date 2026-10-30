/**
 * 可调参数（12 项）：定义齐全、numberSetting 读取与钳制、后台改动真的被业务读到。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, insertUser, type TestDb } from './support/db';
import {
  SETTING_BY_KEY,
  SETTING_DEFINITIONS,
  createSettingsService,
  numberSetting,
} from '../src/server/modules/settings';
import type { CallerContext } from '@/server/platform/context';

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

describe('可调参数', () => {
  it('12 项定义齐全，新增项的默认值与范围合理', () => {
    expect(SETTING_DEFINITIONS.length).toBeGreaterThanOrEqual(12);
    const defaults: Record<string, number> = {
      'media.max_image_bytes': 10 * 1024 * 1024,
      'media.max_images_per_review': 20,
      'imports.max_markdown_bytes': 512 * 1024,
      'home.latest_review_count': 6,
      'home.recent_plugin_count': 12,
      'catalog.install_check_validity_seconds': 86400,
    };
    for (const [key, expected] of Object.entries(defaults)) {
      const def = SETTING_BY_KEY.get(key);
      expect(def, key).toBeDefined();
      expect(def!.defaultValue).toBe(expected);
      expect(def!.min).toBeLessThan(def!.max!);
    }
  });

  it('numberSetting：未改过时返回默认值；改过则返回新值', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const admin = insertUser(db, { role: 'admin' });
    expect(numberSetting(db, 'home.latest_review_count', 6)).toBe(6);

    const service = createSettingsService({ db });
    await service.update(caller(db, admin), {
      changes: { 'home.latest_review_count': 3 },
      reason: '首页少放几条',
      requestKey: 'cfg-home-1',
    });
    expect(numberSetting(db, 'home.latest_review_count', 6)).toBe(3);
  });

  it('numberSetting：越界值回落默认值，坏值不会变成 NaN', async () => {
    ctx = createTestDb();
    const db = ctx.db;
    const admin = insertUser(db, { role: 'admin' });
    const service = createSettingsService({ db });
    await service.update(caller(db, admin), {
      // 故意写一个**非默认值**：默认值不会落库（服务层按"回到默认"处理），
  // 落库了才谈得上后面"手改库"的模拟。
      changes: { 'media.max_images_per_review': 8, 'home.recent_plugin_count': 10 },
      reason: '先写成合法值',
      requestKey: 'cfg-clamp-1',
    });

    // 绕过服务层直接改库（模拟"有人手改了库"）：
    const force = (key: string, value: unknown) =>
      db.prepare('UPDATE site_settings SET value = ? WHERE key = ?').run(JSON.stringify(value), key);

    // 越界值不会被"照着用"：读侧校验不过就回落默认值（20），不会因为手改库放宽上限。
    force('media.max_images_per_review', 999);
    expect(numberSetting(db, 'media.max_images_per_review', 20)).toBe(20);
    force('media.max_images_per_review', -5);
    expect(numberSetting(db, 'media.max_images_per_review', 20)).toBe(1);
    force('media.max_images_per_review', 8);
    expect(numberSetting(db, 'media.max_images_per_review', 20)).toBe(8);

    // 非数字：回落到定义里的默认值，而不是 NaN
    force('home.recent_plugin_count', 'twelve');
    expect(numberSetting(db, 'home.recent_plugin_count', 12)).toBe(12);
  });
});
