import { describe, expect, it } from 'vitest';
import { BIZ_CONFIG_DEFAULTS } from '../../modules/biz/common/biz-config.service.js';
import { CUSTOMER_SEEDS } from './demo.js';
import {
  CARD_TYPE_SEEDS,
  COMMISSION_RULE_SEEDS,
  CREDIT_ACCOUNT_SEEDS,
  POINTS_GOODS_SEEDS,
  RECHARGE_PLAN_SEEDS,
  SERVICE_ITEM_SEEDS,
  STAFF_SEEDS,
  STAFF_SKILL_SEEDS,
  WEEKLY_SHIFT_SEEDS,
} from './nail.js';

/**
 * seed 数据的**不变量**测试。
 *
 * 这些数据是硬编码的，改动时没有任何编译期约束：把充值赠送比例从 20% 调到 30%、
 * 把排班时间写成 10:07、把兑换品指向一个不存在的卡种 —— 类型检查全过，
 * 只有真正跑 `db:seed` 或用户点开页面才会发现。
 * 这里把业务约束固化成断言，让改错在 `bun test` 阶段就被拦住。
 *
 * 注意：只做**纯数据校验**，不连数据库。
 */

/** 从配置默认值里取数，保证断言与线上口径同源，而不是各自写死 */
function configInt(key: string): number {
  const raw = BIZ_CONFIG_DEFAULTS[key];
  if (raw === undefined) throw new Error(`配置 ${key} 没有默认值`);
  return Number(raw);
}

const STEP_MINUTES = configInt('biz.booking.stepMinutes');
const MAX_BONUS_PERMILLE = configInt('biz.member.maxBonusPermille');
const MIN_RECHARGE_AMOUNT = configInt('biz.member.minRechargeAmount');
const POINTS_DISCOUNT_PER_YUAN = configInt('biz.member.pointsDiscountPerYuan');

/** 'HH:MM:SS' → 当日分钟数 */
function minutesOf(time: string): number {
  const [hour, minute] = time.split(':').map(Number);
  return (hour as number) * 60 + (minute as number);
}

const SERVICE_ITEM_NAMES = new Set(SERVICE_ITEM_SEEDS.map((row) => row.name));
const STAFF_NAMES = new Set(STAFF_SEEDS.map((row) => row.nickname));
const CARD_TYPE_NAMES = new Set(CARD_TYPE_SEEDS.map((row) => row.name));

describe('seed/nail：服务项目', () => {
  it('名称不重复（该表无唯一索引，重名会灌出两条一样的项目）', () => {
    const names = SERVICE_ITEM_SEEDS.map((row) => row.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('时长与价格为正，缓冲不超过时长', () => {
    for (const row of SERVICE_ITEM_SEEDS) {
      expect(row.durationMinutes).toBeGreaterThan(0);
      expect(row.price).toBeGreaterThan(0);
      expect(row.bufferMinutes).toBeGreaterThanOrEqual(0);
      expect(row.bufferMinutes).toBeLessThanOrEqual(row.durationMinutes);
    }
  });

  it('时长与缓冲都落在 stepMinutes 网格上（否则时段会落在可约网格之外）', () => {
    for (const row of SERVICE_ITEM_SEEDS) {
      expect(row.durationMinutes % STEP_MINUTES).toBe(0);
      expect(row.bufferMinutes % STEP_MINUTES).toBe(0);
    }
  });

  it('分类与排序不为空，且排序值唯一（避免列表顺序不确定）', () => {
    const sorts = SERVICE_ITEM_SEEDS.map((row) => row.sort);
    expect(new Set(sorts).size).toBe(sorts.length);
    for (const row of SERVICE_ITEM_SEEDS) {
      expect(row.category.length).toBeGreaterThan(0);
    }
  });
});

describe('seed/nail：美甲师与排班', () => {
  it('昵称与手机号不重复', () => {
    const nicknames = STAFF_SEEDS.map((row) => row.nickname);
    const phones = STAFF_SEEDS.map((row) => row.phone);
    expect(new Set(nicknames).size).toBe(nicknames.length);
    expect(new Set(phones).size).toBe(phones.length);
  });

  it('技能里引用的美甲师与项目都必须真实存在（否则静默丢数据）', () => {
    for (const group of STAFF_SKILL_SEEDS) {
      expect(STAFF_NAMES.has(group.staff)).toBe(true);
      expect(group.items.length).toBeGreaterThan(0);
      for (const item of group.items) {
        expect(SERVICE_ITEM_NAMES.has(item)).toBe(true);
      }
    }
  });

  it('每位美甲师至少会一个项目（否则排不出任何可约时段）', () => {
    for (const staff of STAFF_SEEDS) {
      const group = STAFF_SKILL_SEEDS.find((row) => row.staff === staff.nickname);
      expect(group).toBeDefined();
      expect(group?.items.length).toBeGreaterThan(0);
    }
  });

  it('技能组内项目不重复', () => {
    for (const group of STAFF_SKILL_SEEDS) {
      expect(new Set(group.items).size).toBe(group.items.length);
    }
  });

  it('排班引用的美甲师必须存在', () => {
    for (const group of WEEKLY_SHIFT_SEEDS) {
      expect(STAFF_NAMES.has(group.staff)).toBe(true);
      expect(group.weekdays.length).toBeGreaterThan(0);
    }
  });

  it('weekday 取值在 1~7（1=周一，与 shopWeekday 一致）', () => {
    for (const group of WEEKLY_SHIFT_SEEDS) {
      for (const weekday of group.weekdays) {
        expect(Number.isInteger(weekday)).toBe(true);
        expect(weekday).toBeGreaterThanOrEqual(1);
        expect(weekday).toBeLessThanOrEqual(7);
      }
    }
  });

  it('班次起止时间在 15 分钟网格上，且开始早于结束', () => {
    for (const group of WEEKLY_SHIFT_SEEDS) {
      const start = minutesOf(group.startTime);
      const end = minutesOf(group.endTime);
      expect(start % STEP_MINUTES).toBe(0);
      expect(end % STEP_MINUTES).toBe(0);
      expect(start).toBeLessThan(end);
    }
  });

  it('同一位美甲师的同一 weekday 不出现重叠班次', () => {
    for (const group of WEEKLY_SHIFT_SEEDS) {
      expect(new Set(group.weekdays).size).toBe(group.weekdays.length);
    }
  });

  it('每位美甲师都排了班（没排班的人在后台看着像废数据）', () => {
    const scheduled = new Set(WEEKLY_SHIFT_SEEDS.map((row) => row.staff));
    for (const staff of STAFF_SEEDS) {
      expect(scheduled.has(staff.nickname)).toBe(true);
    }
  });
});

describe('seed/nail：次卡卡种', () => {
  it('名称不重复，次数为正，价格为正', () => {
    const names = CARD_TYPE_SEEDS.map((row) => row.name);
    expect(new Set(names).size).toBe(names.length);
    for (const row of CARD_TYPE_SEEDS) {
      expect(row.totalTimes).toBeGreaterThan(0);
      expect(row.price).toBeGreaterThan(0);
      expect(row.validDays).toBeGreaterThanOrEqual(0);
    }
  });

  it('适用项目引用真实存在，且至少一项', () => {
    for (const row of CARD_TYPE_SEEDS) {
      expect(row.items.length).toBeGreaterThan(0);
      expect(new Set(row.items).size).toBe(row.items.length);
      for (const item of row.items) {
        expect(SERVICE_ITEM_NAMES.has(item)).toBe(true);
      }
    }
  });

  it('单次卡的次数必须恰好是 1（积分兑换按「换一次项目」设计）', () => {
    for (const row of CARD_TYPE_SEEDS) {
      if (row.name.includes('单次卡')) expect(row.totalTimes).toBe(1);
    }
  });
});

describe('seed/nail：充值方案', () => {
  it('名称不重复', () => {
    const names = RECHARGE_PLAN_SEEDS.map((row) => row.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('实付不低于 minRechargeAmount', () => {
    for (const row of RECHARGE_PLAN_SEEDS) {
      expect(row.payAmount).toBeGreaterThanOrEqual(MIN_RECHARGE_AMOUNT);
    }
  });

  it('赠送比例不得超过 maxBonusPermille（否则保存时会被业务层拒绝）', () => {
    for (const row of RECHARGE_PLAN_SEEDS) {
      const permille = Math.round((row.bonusAmount / row.payAmount) * 1000);
      expect(permille).toBeLessThanOrEqual(MAX_BONUS_PERMILLE);
    }
  });

  it('赠送金额为非负整数（分）', () => {
    for (const row of RECHARGE_PLAN_SEEDS) {
      expect(Number.isInteger(row.bonusAmount)).toBe(true);
      expect(row.bonusAmount).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(row.payAmount)).toBe(true);
    }
  });
});

describe('seed/nail：积分兑换品', () => {
  it('名称不重复', () => {
    const names = POINTS_GOODS_SEEDS.map((row) => row.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('指向的卡种必须存在（否则 seed 会静默跳过这一条）', () => {
    for (const row of POINTS_GOODS_SEEDS) {
      expect(CARD_TYPE_NAMES.has(row.cardType)).toBe(true);
    }
  });

  it('兑换积分与卡种售价等价（按 pointsDiscountPerYuan 折算，避免贱卖）', () => {
    for (const row of POINTS_GOODS_SEEDS) {
      const cardType = CARD_TYPE_SEEDS.find((item) => item.name === row.cardType);
      expect(cardType).toBeDefined();
      // 售价是「分」，兑换汇率是「多少分抵 1 元」→ 1 分 = 100/汇率 积分
      const expectedPoints =
        ((cardType?.price ?? 0) / 100) * POINTS_DISCOUNT_PER_YUAN;
      expect(row.points).toBe(expectedPoints);
    }
  });

  it('库存为 -1（不限）或非负整数；每人限兑为非负整数', () => {
    for (const row of POINTS_GOODS_SEEDS) {
      expect(Number.isInteger(row.stock)).toBe(true);
      expect(row.stock).toBeGreaterThanOrEqual(-1);
      expect(Number.isInteger(row.perLimit)).toBe(true);
      expect(row.perLimit).toBeGreaterThanOrEqual(0);
    }
  });

  it('兑换品指向的卡种必须是单次卡（否则一次兑换换走一张 10 次卡）', () => {
    for (const row of POINTS_GOODS_SEEDS) {
      const cardType = CARD_TYPE_SEEDS.find((item) => item.name === row.cardType);
      expect(cardType?.totalTimes).toBe(1);
    }
  });
});

describe('seed/nail：挂账主体与提成规则', () => {
  it('挂账主体名称不重复，额度为非负整数', () => {
    const names = CREDIT_ACCOUNT_SEEDS.map((row) => row.name);
    expect(new Set(names).size).toBe(names.length);
    for (const row of CREDIT_ACCOUNT_SEEDS) {
      expect(Number.isInteger(row.creditLimit)).toBe(true);
      expect(row.creditLimit).toBeGreaterThanOrEqual(0);
    }
  });

  it('settleDay 在 0~28（0 = 不定期；29~31 会在 2 月无解）', () => {
    for (const row of CREDIT_ACCOUNT_SEEDS) {
      expect(Number.isInteger(row.settleDay)).toBe(true);
      expect(row.settleDay).toBeGreaterThanOrEqual(0);
      expect(row.settleDay).toBeLessThanOrEqual(28);
    }
  });

  it('company 类主体必须留联系方式（月结要有人对接）', () => {
    for (const row of CREDIT_ACCOUNT_SEEDS) {
      if (row.type !== 'company') continue;
      expect(row.contact.length).toBeGreaterThan(0);
      expect(row.phone.length).toBeGreaterThan(0);
    }
  });

  it('提成规则名称不重复，比例不超过 1000‰，生效日期是合法本地日', () => {
    const names = COMMISSION_RULE_SEEDS.map((row) => row.name);
    expect(new Set(names).size).toBe(names.length);
    for (const row of COMMISSION_RULE_SEEDS) {
      expect(row.permille).toBeGreaterThanOrEqual(0);
      expect(row.permille).toBeLessThanOrEqual(1000);
      expect(row.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (row.scope === 'category') expect(row.category).toBeTruthy();
    }
  });
});

describe('seed/demo：演示顾客', () => {
  it('手机号唯一且非空（uq_customer_phone，重复会整批失败）', () => {
    const phones = CUSTOMER_SEEDS.map((row) => row.phone);
    expect(new Set(phones).size).toBe(phones.length);
    for (const phone of phones) expect(phone).toMatch(/^\d{11}$/);
  });

  it('手机号用 137000000xx 段，便于一键清理演示数据', () => {
    for (const row of CUSTOMER_SEEDS) {
      expect(row.phone.startsWith('137000000')).toBe(true);
    }
  });

  it('姓名非空，生日是合法本地日', () => {
    for (const row of CUSTOMER_SEEDS) {
      expect(row.name.length).toBeGreaterThan(0);
      expect(row.birthday).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('性别取值在枚举内', () => {
    for (const row of CUSTOMER_SEEDS) {
      expect(['unknown', 'male', 'female']).toContain(row.gender);
    }
  });
});
