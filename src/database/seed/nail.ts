import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import {
  bizCommissionRules,
  bizCreditAccounts,
  bizMemberCardTypeItems,
  bizMemberCardTypes,
  bizPointsGoods,
  bizRechargePlans,
  bizServiceItems,
  bizStaffServiceItems,
  bizStaffs,
  bizStaffWeeklyShifts,
} from '../schema/index.js';

/**
 * 美甲业务基础资料 seed（§5.3 / §15.2 / §15.4 / §15.3 / §18 / §20.3）
 * 运行：`bun run db:seed:nail` 或 `bun src/database/seed/nail.ts`
 *
 * 逐项幂等；已存在的行**一律跳过**，绝不覆盖运营改过的值：
 * - `biz_service_item`         按 `name` 判断（该表无唯一索引）
 * - `biz_staff`                按 `nickname` 判断（该表无唯一索引）
 * - `biz_staff_service_item`   按 `(staff_id, service_item_id)` 唯一
 * - `biz_staff_weekly_shift`   按 `(staff_id, weekday, start_time)` 判断
 * - `biz_member_card_type`     按 `name` 唯一
 * - `biz_member_card_type_item` 按 `(card_type_id, service_item_id)` 唯一
 * - `biz_recharge_plan`        按 `name` 唯一
 * - `biz_points_goods`         按 `name` 唯一
 * - `biz_credit_account`       按 `name` 唯一
 * - `biz_commission_rule`      按 `name` 判断（该表无唯一索引）
 *
 * 金额一律整数「分」（§15.8）。赠送比例受 `biz.member.maxBonusPermille`
 * （默认 200‰ = 20%）约束，本文件的方案已按上限校验过。
 *
 * **本文件只写「运营配置数据」，绝不写任何账务字段**
 * （`biz_customer.points` / `balance_principal` / `total_spent` 等）。
 * 那些字段的唯一事实来源是 `biz_member_transaction` 流水（§15.7），
 * seed 直接赋值会造成「账实不符」，让对账等式 `SUM(balance_delta_principal)
 * = balance_principal` 从第一天就不成立。演示顾客见 `seed/demo.ts`。
 */

/* ------------------------------------------------------------------ *
 * 1) 服务项目（§5.3：时长决定占用时段，缓冲参与冲突判定）
 * ------------------------------------------------------------------ */

type ServiceItemSeed = {
  name: string;
  category: string;
  durationMinutes: number;
  /** 与 `biz.booking.stepMinutes`（15 分钟）对齐，避免时段落在网格外 */
  bufferMinutes: number;
  price: number;
  description: string;
  sort: number;
};

export const SERVICE_ITEM_SEEDS: ServiceItemSeed[] = [
  // 基础款
  {
    name: '纯色美甲',
    category: '基础款',
    durationMinutes: 60,
    bufferMinutes: 15,
    price: 8800,
    description: '单色甲油胶，可自选色号',
    sort: 10,
  },
  {
    name: '法式美甲',
    category: '基础款',
    durationMinutes: 75,
    bufferMinutes: 15,
    price: 12800,
    description: '经典白边法式，边线颜色可换',
    sort: 20,
  },
  {
    name: '跳色美甲',
    category: '基础款',
    durationMinutes: 75,
    bufferMinutes: 15,
    price: 10800,
    description: '两到三色跳色搭配',
    sort: 30,
  },
  // 款式设计
  {
    name: '猫眼美甲',
    category: '款式设计',
    durationMinutes: 90,
    bufferMinutes: 15,
    price: 16800,
    description: '磁吸猫眼，多色可选',
    sort: 40,
  },
  {
    name: '渐变美甲',
    category: '款式设计',
    durationMinutes: 90,
    bufferMinutes: 15,
    price: 15800,
    description: '海绵晕染渐变，可做双色',
    sort: 50,
  },
  {
    name: '贴钻美甲',
    category: '款式设计',
    durationMinutes: 90,
    bufferMinutes: 15,
    price: 18800,
    description: '水钻造型，含基础底色',
    sort: 60,
  },
  {
    name: '手绘图案',
    category: '款式设计',
    durationMinutes: 120,
    bufferMinutes: 15,
    price: 19800,
    description: '手绘花朵 / 几何 / 卡通，按复杂度加价',
    sort: 70,
  },
  // 延长甲
  {
    name: '甲片延长',
    category: '延长甲',
    durationMinutes: 150,
    bufferMinutes: 15,
    price: 25800,
    description: '全贴甲片延长，含基础款',
    sort: 80,
  },
  {
    name: '光疗延长',
    category: '延长甲',
    durationMinutes: 180,
    bufferMinutes: 15,
    price: 29800,
    description: '光疗胶延长，更自然耐用',
    sort: 90,
  },
  // 护理
  {
    name: '手部护理',
    category: '护理',
    durationMinutes: 45,
    bufferMinutes: 15,
    price: 6800,
    description: '去角质 + 按摩 + 手膜',
    sort: 100,
  },
  {
    name: '卸甲',
    category: '护理',
    durationMinutes: 30,
    bufferMinutes: 15,
    price: 3800,
    description: '甲油胶 / 光疗胶卸除',
    sort: 110,
  },
];

/* ------------------------------------------------------------------ *
 * 2) 美甲师（§5.4：档案未必有后台账号，user_id 留空）
 * ------------------------------------------------------------------ */

type StaffSeed = {
  nickname: string;
  phone: string;
  bio: string;
  sort: number;
};

export const STAFF_SEEDS: StaffSeed[] = [
  {
    nickname: '小美',
    phone: '13800000001',
    bio: '从业 6 年，擅长法式与延长甲',
    sort: 10,
  },
  {
    nickname: '小雅',
    phone: '13800000002',
    bio: '从业 4 年，擅长猫眼与渐变',
    sort: 20,
  },
  {
    nickname: '阿琳',
    phone: '13800000003',
    bio: '店长，从业 8 年，全项目可做',
    sort: 30,
  },
  {
    nickname: '婷婷',
    phone: '13800000004',
    bio: '从业 2 年，基础款与护理',
    sort: 40,
  },
];

/** 美甲师可做项目（`biz_staff_service_item`，限制后「可约时段」随之收窄） */
export const STAFF_SKILL_SEEDS: { staff: string; items: string[] }[] = [
  {
    staff: '小美',
    items: ['纯色美甲', '法式美甲', '跳色美甲', '甲片延长', '光疗延长', '卸甲'],
  },
  {
    staff: '小雅',
    items: ['纯色美甲', '法式美甲', '猫眼美甲', '渐变美甲', '贴钻美甲', '卸甲'],
  },
  {
    staff: '阿琳',
    items: SERVICE_ITEM_SEEDS.map((item) => item.name),
  },
  {
    staff: '婷婷',
    items: ['纯色美甲', '跳色美甲', '手部护理', '卸甲'],
  },
];

/**
 * 周模板班次（§5.2）。
 *
 * `weekday` 取值 1=周一 … 7=周日（与 `shopWeekday` 一致）。
 * 门店周一轮休，其余 10:00–19:00；时间落在 15 分钟网格上。
 */
export const WEEKLY_SHIFT_SEEDS: {
  staff: string;
  weekdays: number[];
  startTime: string;
  endTime: string;
}[] = [
  {
    staff: '小美',
    weekdays: [2, 3, 4, 5, 6, 7],
    startTime: '10:00:00',
    endTime: '19:00:00',
  },
  {
    staff: '小雅',
    weekdays: [2, 3, 4, 5, 6, 7],
    startTime: '11:00:00',
    endTime: '20:00:00',
  },
  {
    staff: '阿琳',
    weekdays: [2, 3, 4, 5, 6],
    startTime: '10:00:00',
    endTime: '18:00:00',
  },
  {
    staff: '婷婷',
    weekdays: [3, 4, 5, 6, 7],
    startTime: '12:00:00',
    endTime: '21:00:00',
  },
];

/* ------------------------------------------------------------------ *
 * 3) 次卡卡种（§15.5）
 * ------------------------------------------------------------------ */

type CardTypeSeed = {
  name: string;
  price: number;
  totalTimes: number;
  /** 0 = 永久有效 */
  validDays: number;
  remark: string;
  sort: number;
  /** 适用项目名，按 `biz_member_card_type_item` 落库 */
  items: string[];
};

export const CARD_TYPE_SEEDS: CardTypeSeed[] = [
  {
    name: '基础款 10 次卡',
    price: 80000,
    totalTimes: 10,
    validDays: 365,
    remark: '基础款项目任选，单次约 ¥80（原价 ¥88~128）',
    sort: 10,
    items: ['纯色美甲', '法式美甲', '跳色美甲'],
  },
  {
    name: '款式 5 次卡',
    price: 70000,
    totalTimes: 5,
    validDays: 180,
    remark: '款式设计项目任选，单次约 ¥140',
    sort: 20,
    items: ['猫眼美甲', '渐变美甲', '贴钻美甲'],
  },
  {
    name: '全项目 10 次卡',
    price: 200000,
    totalTimes: 10,
    validDays: 365,
    remark: '含延长甲在内的全项目任选，单次约 ¥200',
    sort: 30,
    items: SERVICE_ITEM_SEEDS.map((item) => item.name).filter(
      (name) => name !== '卸甲',
    ),
  },
  // 单次卡：给积分兑换当「兑换品」用（兑换品指向卡种，换项目 = 发一张 1 次卡）
  {
    name: '纯色美甲单次卡',
    price: 8800,
    totalTimes: 1,
    validDays: 90,
    remark: '积分兑换专用，等价于一次纯色美甲',
    sort: 40,
    items: ['纯色美甲'],
  },
  {
    name: '手部护理单次卡',
    price: 6800,
    totalTimes: 1,
    validDays: 90,
    remark: '积分兑换专用，等价于一次手部护理',
    sort: 50,
    items: ['手部护理'],
  },
];

/* ------------------------------------------------------------------ *
 * 4) 充值方案（§15.4）
 *
 * 赠送比例 = bonusAmount / payAmount，必须 ≤ `biz.member.maxBonusPermille`（默认 20%），
 * 且 payAmount ≥ `biz.member.minRechargeAmount`（默认 10000 分 = ¥100）。
 * ------------------------------------------------------------------ */

type RechargePlanSeed = {
  name: string;
  payAmount: number;
  bonusAmount: number;
  remark: string;
  sort: number;
};

export const RECHARGE_PLAN_SEEDS: RechargePlanSeed[] = [
  {
    name: '充 ¥500 送 ¥50',
    payAmount: 50000,
    bonusAmount: 5000,
    remark: '赠送 10%，入门档',
    sort: 10,
  },
  {
    name: '充 ¥1000 送 ¥150',
    payAmount: 100000,
    bonusAmount: 15000,
    remark: '赠送 15%，最受欢迎',
    sort: 20,
  },
  {
    name: '充 ¥2000 送 ¥400',
    payAmount: 200000,
    bonusAmount: 40000,
    remark: '赠送 20%，已顶到赠送比例上限',
    sort: 30,
  },
];

/* ------------------------------------------------------------------ *
 * 5) 积分兑换品（§15.3：指向卡种，不引入券体系）
 *
 * `points` 按 `biz.member.pointsDiscountPerYuan`（默认 100 分抵 1 元）折算，
 * 与卡种售价等价。
 * ------------------------------------------------------------------ */

type PointsGoodsSeed = {
  name: string;
  cardType: string;
  points: number;
  /** -1 = 不限库存 */
  stock: number;
  /** 0 = 不限每人兑换次数 */
  perLimit: number;
  /**
   * 分类：C 端筛选胶囊按它出。
   *
   * 自由文本而非枚举 —— 分类是门店自己的运营语言，加一个分类不该改表结构。
   * 现有两条兑换品都会发一张次卡，所以都归「美甲项目」；门店将来上架实物周边时
   * 自己填新分类，C 端胶囊会跟着变（**胶囊选项来自数据，不是前端硬编码**）。
   */
  category: string;
  remark: string;
  sort: number;
};

export const POINTS_GOODS_SEEDS: PointsGoodsSeed[] = [
  {
    name: '纯色美甲体验卡',
    cardType: '纯色美甲单次卡',
    points: 8800,
    stock: -1,
    perLimit: 1,
    category: '美甲项目',
    remark: '8800 积分兑换一次纯色美甲（等价 ¥88）',
    sort: 10,
  },
  {
    name: '手部护理体验卡',
    cardType: '手部护理单次卡',
    points: 6800,
    stock: -1,
    perLimit: 2,
    category: '美甲项目',
    remark: '6800 积分兑换一次手部护理（等价 ¥68）',
    sort: 20,
  },
];

/* ------------------------------------------------------------------ *
 * 6) 挂账主体（§18）
 *
 * 额度单位「分」；`settleDay = 0` 表示不定期（`due_date` 落 NULL）。
 * ------------------------------------------------------------------ */

type CreditAccountSeed = {
  name: string;
  type: 'customer' | 'company' | 'staff';
  contact: string;
  phone: string;
  creditLimit: number;
  settleDay: number;
  remark: string;
};

export const CREDIT_ACCOUNT_SEEDS: CreditAccountSeed[] = [
  {
    name: '某美妆公司（月结）',
    type: 'company',
    contact: '王经理',
    phone: '13900000001',
    creditLimit: 500000,
    settleDay: 5,
    remark: '员工福利月结，额度 ¥5000，每月 5 日结算',
  },
  {
    name: '员工内部挂账',
    type: 'staff',
    contact: '店长',
    phone: '13900000002',
    creditLimit: 100000,
    settleDay: 0,
    remark: '员工内部账，额度 ¥1000，不定期结算',
  },
];

/* ------------------------------------------------------------------ *
 * 7) 提成规则（§20.3）
 * ------------------------------------------------------------------ */

type CommissionRuleSeed = {
  name: string;
  scope: 'staff' | 'category' | 'service_item';
  category?: string;
  permille: number;
  base: 'payable' | 'paid' | 'original';
  effectiveFrom: string;
  remark: string;
  sort: number;
};

export const COMMISSION_RULE_SEEDS: CommissionRuleSeed[] = [
  {
    name: '美甲师通用提成 10%',
    scope: 'staff',
    permille: 100,
    base: 'paid',
    effectiveFrom: '2026-01-01',
    remark: '所有美甲师的兜底提成，按实收计提',
    sort: 10,
  },
  {
    name: '延长甲项目提成 15%',
    scope: 'category',
    category: '延长甲',
    permille: 150,
    base: 'paid',
    effectiveFrom: '2026-01-01',
    remark: '延长甲耗时长、技术门槛高，单独提高提成比例',
    sort: 20,
  },
];

/* ------------------------------------------------------------------ *
 * 写入实现
 * ------------------------------------------------------------------ */

type Db = ReturnType<typeof drizzle>;
type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];
type DbLike = Db | DbTx;

type SeedStat = { table: string; inserted: number; skipped: number };

const stat = (table: string, inserted: number, skipped: number): SeedStat => ({
  table,
  inserted,
  skipped,
});

/** 服务项目：无唯一索引，按 name 判断 */
async function seedServiceItems(db: DbLike): Promise<SeedStat> {
  const existing = await db
    .select({ name: bizServiceItems.name })
    .from(bizServiceItems);
  const known = new Set(existing.map((row) => row.name));

  const pending = SERVICE_ITEM_SEEDS.filter((row) => !known.has(row.name));
  if (pending.length > 0) {
    await db.insert(bizServiceItems).values(
      pending.map((row) => ({
        name: row.name,
        category: row.category,
        durationMinutes: row.durationMinutes,
        bufferMinutes: row.bufferMinutes,
        price: row.price,
        description: row.description,
        status: 'active' as const,
        sort: row.sort,
      })),
    );
  }
  return stat('biz_service_item', pending.length, known.size);
}

/** 美甲师：无唯一索引，按 nickname 判断 */
async function seedStaffs(db: DbLike): Promise<SeedStat> {
  const existing = await db
    .select({ nickname: bizStaffs.nickname })
    .from(bizStaffs);
  const known = new Set(existing.map((row) => row.nickname));

  const pending = STAFF_SEEDS.filter((row) => !known.has(row.nickname));
  if (pending.length > 0) {
    await db.insert(bizStaffs).values(
      pending.map((row) => ({
        nickname: row.nickname,
        phone: row.phone,
        bio: row.bio,
        status: 'active' as const,
        sort: row.sort,
      })),
    );
  }
  return stat('biz_staff', pending.length, known.size);
}

/** 名称 → 主键，供关联表使用（主键回填后的真实 id） */
async function loadNameIds(
  db: DbLike,
  table: 'service_item' | 'staff' | 'card_type',
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (table === 'service_item') {
    const rows = await db
      .select({ id: bizServiceItems.id, name: bizServiceItems.name })
      .from(bizServiceItems);
    for (const row of rows) result.set(row.name, row.id);
  } else if (table === 'staff') {
    const rows = await db
      .select({ id: bizStaffs.id, name: bizStaffs.nickname })
      .from(bizStaffs);
    for (const row of rows) result.set(row.name, row.id);
  } else {
    const rows = await db
      .select({ id: bizMemberCardTypes.id, name: bizMemberCardTypes.name })
      .from(bizMemberCardTypes);
    for (const row of rows) result.set(row.name, row.id);
  }
  return result;
}

/** 美甲师技能：按 (staff_id, service_item_id) 唯一 */
async function seedStaffSkills(db: DbLike): Promise<SeedStat> {
  const staffIds = await loadNameIds(db, 'staff');
  const itemIds = await loadNameIds(db, 'service_item');
  const existing = await db
    .select({
      staffId: bizStaffServiceItems.staffId,
      serviceItemId: bizStaffServiceItems.serviceItemId,
    })
    .from(bizStaffServiceItems);
  const known = new Set(
    existing.map((row) => `${row.staffId}:${row.serviceItemId}`),
  );

  const pending: {
    staffId: number;
    serviceItemId: number;
    sort: number;
  }[] = [];
  let skipped = 0;
  for (const group of STAFF_SKILL_SEEDS) {
    const staffId = staffIds.get(group.staff);
    if (staffId === undefined) continue;
    group.items.forEach((itemName, index) => {
      const serviceItemId = itemIds.get(itemName);
      if (serviceItemId === undefined) return;
      if (known.has(`${staffId}:${serviceItemId}`)) {
        skipped += 1;
        return;
      }
      pending.push({ staffId, serviceItemId, sort: (index + 1) * 10 });
    });
  }

  if (pending.length > 0) await db.insert(bizStaffServiceItems).values(pending);
  return stat('biz_staff_service_item', pending.length, skipped);
}

/** 周模板班次：按 (staff_id, weekday, start_time) 判断 */
async function seedWeeklyShifts(db: DbLike): Promise<SeedStat> {
  const staffIds = await loadNameIds(db, 'staff');
  const existing = await db
    .select({
      staffId: bizStaffWeeklyShifts.staffId,
      weekday: bizStaffWeeklyShifts.weekday,
      startTime: bizStaffWeeklyShifts.startTime,
    })
    .from(bizStaffWeeklyShifts);
  const known = new Set(
    existing.map((row) => `${row.staffId}:${row.weekday}:${row.startTime}`),
  );

  const pending: {
    staffId: number;
    weekday: number;
    startTime: string;
    endTime: string;
  }[] = [];
  let skipped = 0;
  for (const group of WEEKLY_SHIFT_SEEDS) {
    const staffId = staffIds.get(group.staff);
    if (staffId === undefined) continue;
    for (const weekday of group.weekdays) {
      if (known.has(`${staffId}:${weekday}:${group.startTime}`)) {
        skipped += 1;
        continue;
      }
      pending.push({
        staffId,
        weekday,
        startTime: group.startTime,
        endTime: group.endTime,
      });
    }
  }

  if (pending.length > 0) await db.insert(bizStaffWeeklyShifts).values(pending);
  return stat('biz_staff_weekly_shift', pending.length, skipped);
}

/** 次卡卡种：按 name 唯一 */
async function seedCardTypes(db: DbLike): Promise<SeedStat> {
  const existing = await db
    .select({ name: bizMemberCardTypes.name })
    .from(bizMemberCardTypes);
  const known = new Set(existing.map((row) => row.name));

  const pending = CARD_TYPE_SEEDS.filter((row) => !known.has(row.name));
  if (pending.length > 0) {
    await db.insert(bizMemberCardTypes).values(
      pending.map((row) => ({
        name: row.name,
        price: row.price,
        totalTimes: row.totalTimes,
        validDays: row.validDays,
        status: 'active' as const,
        sort: row.sort,
        remark: row.remark,
      })),
    );
  }
  return stat('biz_member_card_type', pending.length, known.size);
}

/** 卡种适用项目：按 (card_type_id, service_item_id) 唯一 */
async function seedCardTypeItems(db: DbLike): Promise<SeedStat> {
  const cardTypeIds = await loadNameIds(db, 'card_type');
  const itemIds = await loadNameIds(db, 'service_item');
  const existing = await db
    .select({
      cardTypeId: bizMemberCardTypeItems.cardTypeId,
      serviceItemId: bizMemberCardTypeItems.serviceItemId,
    })
    .from(bizMemberCardTypeItems);
  const known = new Set(
    existing.map((row) => `${row.cardTypeId}:${row.serviceItemId}`),
  );

  const pending: {
    cardTypeId: number;
    serviceItemId: number;
    sort: number;
  }[] = [];
  let skipped = 0;
  for (const cardType of CARD_TYPE_SEEDS) {
    const cardTypeId = cardTypeIds.get(cardType.name);
    if (cardTypeId === undefined) continue;
    cardType.items.forEach((itemName, index) => {
      const serviceItemId = itemIds.get(itemName);
      if (serviceItemId === undefined) return;
      if (known.has(`${cardTypeId}:${serviceItemId}`)) {
        skipped += 1;
        return;
      }
      pending.push({ cardTypeId, serviceItemId, sort: (index + 1) * 10 });
    });
  }

  if (pending.length > 0)
    await db.insert(bizMemberCardTypeItems).values(pending);
  return stat('biz_member_card_type_item', pending.length, skipped);
}

/** 充值方案：按 name 唯一 */
async function seedRechargePlans(db: DbLike): Promise<SeedStat> {
  const existing = await db
    .select({ name: bizRechargePlans.name })
    .from(bizRechargePlans);
  const known = new Set(existing.map((row) => row.name));

  const pending = RECHARGE_PLAN_SEEDS.filter((row) => !known.has(row.name));
  if (pending.length > 0) {
    await db.insert(bizRechargePlans).values(
      pending.map((row) => ({
        name: row.name,
        payAmount: row.payAmount,
        bonusAmount: row.bonusAmount,
        status: 'active' as const,
        sort: row.sort,
        remark: row.remark,
      })),
    );
  }
  return stat('biz_recharge_plan', pending.length, known.size);
}

/** 积分兑换品：按 name 唯一 */
async function seedPointsGoods(db: DbLike): Promise<SeedStat> {
  const cardTypeIds = await loadNameIds(db, 'card_type');
  const existing = await db
    .select({ name: bizPointsGoods.name })
    .from(bizPointsGoods);
  const known = new Set(existing.map((row) => row.name));

  const pending = POINTS_GOODS_SEEDS.filter((row) => !known.has(row.name));
  const rows: {
    name: string;
    cardTypeId: number;
    points: number;
    stock: number;
    perLimit: number;
    status: 'active';
    sort: number;
    /** C 端筛选胶囊按它出 */
    category: string;
    remark: string;
  }[] = [];
  for (const row of pending) {
    const cardTypeId = cardTypeIds.get(row.cardType);
    // 卡种缺失（被运营改名/停用）时跳过，避免外键报错打断整批 seed
    if (cardTypeId === undefined) continue;
    rows.push({
      name: row.name,
      cardTypeId,
      points: row.points,
      stock: row.stock,
      perLimit: row.perLimit,
      status: 'active',
      sort: row.sort,
      category: row.category,
      remark: row.remark,
    });
  }

  if (rows.length > 0) await db.insert(bizPointsGoods).values(rows);
  return stat('biz_points_goods', rows.length, known.size);
}

/** 挂账主体：按 name 唯一。`used_amount` 不 seed（由应收单驱动） */
async function seedCreditAccounts(db: DbLike): Promise<SeedStat> {
  const existing = await db
    .select({ name: bizCreditAccounts.name })
    .from(bizCreditAccounts);
  const known = new Set(existing.map((row) => row.name));

  const pending = CREDIT_ACCOUNT_SEEDS.filter((row) => !known.has(row.name));
  if (pending.length > 0) {
    await db.insert(bizCreditAccounts).values(
      pending.map((row) => ({
        name: row.name,
        type: row.type,
        contact: row.contact,
        phone: row.phone,
        creditLimit: row.creditLimit,
        // 额度占用只能由应收单条件更新驱动（§18.2），seed 一律从 0 起
        usedAmount: 0,
        settleDay: row.settleDay,
        status: 'active' as const,
        remark: row.remark,
      })),
    );
  }
  return stat('biz_credit_account', pending.length, known.size);
}

/** 提成规则：无唯一索引，按 name 判断 */
async function seedCommissionRules(db: DbLike): Promise<SeedStat> {
  const existing = await db
    .select({ name: bizCommissionRules.name })
    .from(bizCommissionRules);
  const known = new Set(existing.map((row) => row.name));

  const pending = COMMISSION_RULE_SEEDS.filter((row) => !known.has(row.name));
  if (pending.length > 0) {
    await db.insert(bizCommissionRules).values(
      pending.map((row) => ({
        name: row.name,
        scope: row.scope,
        category: row.category ?? null,
        permille: row.permille,
        fixedAmount: 0,
        base: row.base,
        effectiveFrom: row.effectiveFrom,
        status: 'active' as const,
        sort: row.sort,
        remark: row.remark,
      })),
    );
  }
  return stat('biz_commission_rule', pending.length, known.size);
}

/**
 * 写入美甲业务基础资料。
 *
 * - 默认自行建连并结束（供 `bun run db:seed:nail` / 直接 `bun src/database/seed/nail.ts`）。
 * - 传入 `pool` 时复用调用方的连接池（供 `seed/index.ts` 串联调用），不会 `end()` 掉别人的池。
 */
export async function seedNail(pool?: mysql.Pool): Promise<void> {
  const url = Bun.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const owned = !pool;
  const target = pool ?? mysql.createPool(url);
  const db = drizzle({ client: target });

  try {
    let stats: SeedStat[] = [];
    await db.transaction(async (tx) => {
      // 顺序即外键依赖顺序：项目/美甲师 → 关联表 → 卡种 → 卡种适用项目 → 兑换品
      stats = [
        await seedServiceItems(tx),
        await seedStaffs(tx),
        await seedStaffSkills(tx),
        await seedWeeklyShifts(tx),
        await seedCardTypes(tx),
        await seedCardTypeItems(tx),
        await seedRechargePlans(tx),
        await seedPointsGoods(tx),
        await seedCreditAccounts(tx),
        await seedCommissionRules(tx),
      ];
    });

    for (const item of stats) {
      console.log(
        `[seed:nail] ${item.table} inserted=${item.inserted} skipped=${item.skipped}`,
      );
    }
    console.log('[seed:nail] Done.');
  } finally {
    if (owned) await target.end();
  }
}

if (import.meta.main) {
  await seedNail();
}
