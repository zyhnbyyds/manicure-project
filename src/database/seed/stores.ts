import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { eq, isNull } from 'drizzle-orm';
import { configs, sysStores } from '../schema/index.js';
import { BIZ_CONFIG_DEFAULTS } from '../../modules/biz/common/biz-config.service.js';

/**
 * 门店档案 seed（连锁直营 · 阶段 0）。
 *
 * ## 与迁移的分工
 *
 * 迁移 `..._gigantic_landau` 建表时**已经**用当时的 `biz.shop.*` 落了一条默认门店 ——
 * 但新库的迁移跑在 `db:seed` **之前**，那一刻 `sys_config` 还是空的，所以门店行的
 * 电话/地址/经纬度会是 null。这里做两件事：
 * 1. 一条门店都没有 → 用 `BIZ_CONFIG_DEFAULTS` 建默认门店（老库走不到这一步，迁移已建）；
 * 2. 有门店但某些字段还是 null → **只补空**（不覆盖运营改过的值）。
 *
 * 这就是「门店表优先、配置兜底」在数据层的落点：两边并存期谁都不许把对方的值冲掉。
 */

type SeedStat = { table: string; inserted: number; skipped: number };

/** `sys_config` 里门店相关的键 → 门店列 */
const STORE_FIELD_KEYS = {
  name: 'biz.shop.name',
  nameEn: 'biz.shop.nameEn',
  phone: 'biz.shop.phone',
  address: 'biz.shop.address',
  hours: 'biz.shop.hours',
  notice: 'biz.shop.notice',
} as const;

export async function seedStores(pool?: mysql.Pool): Promise<void> {
  const url = Bun.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const owned = !pool;
  const target = pool ?? mysql.createPool(url);
  const db = drizzle({ client: target });

  try {
    const stat = await db.transaction(async (tx) => {
      const rows = await tx.select().from(configs);
      const configOf = (key: string): string | null => {
        const hit = rows.find((row) => row.key === key);
        return hit && hit.value !== '' ? hit.value : null;
      };
      const fallback = (
        key: keyof typeof BIZ_CONFIG_DEFAULTS,
      ): string | null => {
        // `BIZ_CONFIG_DEFAULTS` 是 `Record<string, string>`，取值可能是 undefined
        const value = BIZ_CONFIG_DEFAULTS[key];
        return value === undefined || value === '' ? null : value;
      };
      const pick = (
        configKey: string,
        fallbackKey: keyof typeof BIZ_CONFIG_DEFAULTS,
      ) => configOf(configKey) ?? fallback(fallbackKey);

      const existing = await tx
        .select()
        .from(sysStores)
        .where(isNull(sysStores.deletedAt));

      // 一条都没有：建默认门店（与迁移同口径，只是这次配置已经灌好了）
      if (existing.length === 0) {
        await tx.insert(sysStores).values({
          code: 'MAIN',
          name: pick('biz.shop.name', 'biz.shop.name') ?? '美甲小铺',
          nameEn: pick('biz.shop.nameEn', 'biz.shop.nameEn'),
          phone: pick('biz.shop.phone', 'biz.shop.phone'),
          address: pick('biz.shop.address', 'biz.shop.address'),
          hours: pick('biz.shop.hours', 'biz.shop.hours'),
          latitude:
            Number(pick('biz.shop.latitude', 'biz.shop.latitude') ?? 0) || null,
          longitude:
            Number(pick('biz.shop.longitude', 'biz.shop.longitude') ?? 0) ||
            null,
          notice: pick('biz.shop.notice', 'biz.shop.notice'),
          isDefault: true,
          remark: '默认门店（由单店配置生成）',
        });
        return {
          table: 'sys_store',
          inserted: 1,
          skipped: 0,
        } satisfies SeedStat;
      }

      // 已有门店：只把 null 的字段补上（不覆盖运营改过的值）
      const defaultStore = existing.find((row) => row.isDefault) ?? existing[0];
      if (!defaultStore) return { table: 'sys_store', inserted: 0, skipped: 0 };
      const patch: Record<string, string | number | null> = {};
      for (const [column, configKey] of Object.entries(STORE_FIELD_KEYS)) {
        const current = defaultStore[column as keyof typeof defaultStore];
        if (current !== null && current !== undefined) continue;
        const value = pick(
          configKey,
          configKey as keyof typeof BIZ_CONFIG_DEFAULTS,
        );
        if (value !== null) patch[column] = value;
      }
      // 经纬度单独补（数值列）
      if (defaultStore.latitude === null) {
        const value = Number(
          pick('biz.shop.latitude', 'biz.shop.latitude') ?? 0,
        );
        if (value) patch.latitude = value;
      }
      if (defaultStore.longitude === null) {
        const value = Number(
          pick('biz.shop.longitude', 'biz.shop.longitude') ?? 0,
        );
        if (value) patch.longitude = value;
      }

      if (Object.keys(patch).length > 0) {
        await tx
          .update(sysStores)
          .set(patch)
          .where(eq(sysStores.id, defaultStore.id));
      }
      return {
        table: 'sys_store',
        inserted: 0,
        skipped: existing.length,
      } satisfies SeedStat;
    });

    console.log(
      `[seed:stores] ${stat.table} inserted=${stat.inserted} skipped=${stat.skipped}`,
    );
  } finally {
    if (owned) await target.end();
  }
}

if (import.meta.main) {
  await seedStores();
}
