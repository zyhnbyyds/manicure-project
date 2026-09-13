import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { buildDocNo } from '../../modules/biz/common/doc-no.js';
import { DEFAULT_SHOP_TIMEZONE } from '../../modules/biz/common/shop-time.js';
import { bizCustomers, bizMemberLevels, configs } from '../schema/index.js';

/**
 * 演示用顾客 / 会员档案 seed（**可选**，仅供开发与演示环境）
 * 运行：`bun run db:seed:demo` 或 `bun src/database/seed/demo.ts`
 *
 * ⚠️ 这是**演示数据**，不是初始化数据。生产环境不要跑。
 *
 * 只写「身份与档案」字段，**账务字段一律不写**：
 *
 * | 字段 | 是否 seed | 原因 |
 * | --- | --- | --- |
 * | `name` / `phone` / `gender` / `birthday` / `remark` | ✅ | 纯档案 |
 * | `member_no` / `member_since` / `level_id` | ✅ | 身份标识，与 `ensureMembership` 同算法回填 |
 * | `points` / `points_total` | ❌ | 由 `biz_member_transaction` 流水驱动（§15.7） |
 * | `balance_principal` / `balance_bonus` | ❌ | 同上；对账等式 `SUM(balance_delta_principal) = balance_principal` 必须成立 |
 * | `total_spent` / `visit_count` / `last_visit_at` | ❌ | 由消费落账与到店统计驱动 |
 *
 * 想让演示会员带上余额或积分，**走正常业务接口**（充值 / 消费 / 积分兑换），
 * 不要在 seed 里直接赋值 —— 那样账实不符，报表与对账从第一天就是错的。
 *
 * 幂等：按 `phone` 判断（`uq_customer_phone`），已存在则整行跳过。
 * 清空演示数据：`DELETE FROM biz_customer WHERE phone LIKE '137000000%';`
 */

type CustomerSeed = {
  name: string;
  phone: string;
  gender: 'unknown' | 'male' | 'female';
  birthday: string;
  remark: string;
};

export const CUSTOMER_SEEDS: CustomerSeed[] = [
  {
    name: '张小雨',
    phone: '13700000001',
    gender: 'female',
    birthday: '1996-03-12',
    remark: '偏爱裸色系，不喜欢太长的甲型',
  },
  {
    name: '李思思',
    phone: '13700000002',
    gender: 'female',
    birthday: '1993-08-25',
    remark: '常做猫眼，对光泽度要求高',
  },
  {
    name: '王曼',
    phone: '13700000003',
    gender: 'female',
    birthday: '1999-01-07',
    remark: '喜欢贴钻款，重要场合前会来',
  },
  {
    name: '陈静',
    phone: '13700000004',
    gender: 'female',
    birthday: '1990-11-30',
    remark: '固定做光疗延长，两周一次补甲',
  },
  {
    name: '赵蕾',
    phone: '13700000005',
    gender: 'female',
    birthday: '1995-06-18',
    remark: '只做基础款，价格敏感',
  },
  {
    name: '周晓萌',
    phone: '13700000006',
    gender: 'female',
    birthday: '2001-09-03',
    remark: '学生党，节假日有活动才来',
  },
  {
    name: '孙浩',
    phone: '13700000007',
    gender: 'male',
    birthday: '1992-04-21',
    remark: '男顾客，定期手部护理',
  },
  {
    name: '吴莉',
    phone: '13700000008',
    gender: 'female',
    birthday: '1988-12-14',
    remark: '公司行政，负责团建美甲对接',
  },
];

/** 店内时区：读 `biz.booking.timezone`，缺失时回落默认值 */
async function shopTimeZone(db: ReturnType<typeof drizzle>): Promise<string> {
  const [row] = await db
    .select({ value: configs.value })
    .from(configs)
    .where(eq(configs.key, 'biz.booking.timezone'))
    .limit(1);
  return row?.value && row.value.length > 0 ? row.value : DEFAULT_SHOP_TIMEZONE;
}

/**
 * 写入演示顾客档案。
 *
 * - 默认自行建连并结束（供 `bun run db:seed:demo`）。
 * - 传入 `pool` 时复用调用方的连接池。
 */
export async function seedDemo(pool?: mysql.Pool): Promise<void> {
  const url = Bun.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const owned = !pool;
  const target = pool ?? mysql.createPool(url);
  const db = drizzle({ client: target });

  try {
    const timeZone = await shopTimeZone(db);
    // 默认等级（门槛最低的那一档）：与 `total_spent = 0` 保持一致
    const [defaultLevel] = await db
      .select({ id: bizMemberLevels.id })
      .from(bizMemberLevels)
      .where(eq(bizMemberLevels.status, 'active'))
      .orderBy(asc(bizMemberLevels.upgradeAmount), asc(bizMemberLevels.sort))
      .limit(1);

    const existing = await db
      .select({ phone: bizCustomers.phone })
      .from(bizCustomers);
    const known = new Set(
      existing
        .map((row) => row.phone)
        .filter((phone): phone is string => !!phone),
    );
    const pending = CUSTOMER_SEEDS.filter((row) => !known.has(row.phone));

    let inserted = 0;
    for (const row of pending) {
      const memberSince = new Date();
      // 会员号与 `CustomersService.ensureMembership` 同一算法（主键回填），
      // 保证格式一致：M{yyyyMMdd}{主键补零 6 位}
      const [result] = await db.insert(bizCustomers).values({
        name: row.name,
        phone: row.phone,
        gender: row.gender,
        birthday: row.birthday,
        remark: row.remark,
        levelId: defaultLevel?.id ?? null,
        memberSince,
        // member_no 先占位、拿到主键后回填（列上有 UNIQUE）
        memberNo: null,
      });
      const id = Number(result.insertId);
      await db
        .update(bizCustomers)
        .set({ memberNo: buildDocNo('M', id, timeZone, memberSince) })
        .where(eq(bizCustomers.id, id));
      inserted += 1;
    }

    console.log(
      `[seed:demo] biz_customer inserted=${inserted} skipped=${known.size}`,
    );
    console.log('[seed:demo] Done.');
  } finally {
    if (owned) await target.end();
  }
}

if (import.meta.main) {
  await seedDemo();
}
