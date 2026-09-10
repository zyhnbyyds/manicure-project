import { and, eq, isNull } from 'drizzle-orm';
import { DatabaseService } from '../../../database/database.service';
import { configs } from '../../../database/schema/index';
import { DEFAULT_SHOP_TIMEZONE } from './shop-time.js';

/** 预约链路可调参数（§5.6） */
export type BookingConfig = {
  timezone: string;
  stepMinutes: number;
  minLeadMinutes: number;
  adminMinLeadMinutes: number;
  maxAdvanceDays: number;
  noShowGraceMinutes: number;
  depositPermille: number;
};

/** 会员体系可调参数（§15.8） */
export type MemberConfig = {
  pointsPerYuan: number;
  pointsDiscountPerYuan: number;
  maxPointsPermille: number;
  maxBonusPermille: number;
  bonusDeductMode: 'bonus_first' | 'proportional';
  minRechargeAmount: number;
  refundNeedReason: boolean;
};

/** 支付与对账参数（§15.8 / §17.5） */
export type PaymentConfig = {
  qrExpireMinutes: number;
  reconcileHour: number;
};

/** 通知参数（§19） */
export type NoticeConfig = {
  smsEnabled: boolean;
  smsTemplates: string[];
  retryLimit: number;
};

/** 挂账参数（§18.1） */
export type CreditConfig = {
  defaultLimit: number;
  defaultSettleDay: number;
};

/** 提成参数（§20.3） */
export type CommissionConfig = {
  periodCloseDay: number;
};

export type BizConfig = {
  booking: BookingConfig;
  member: MemberConfig;
  payment: PaymentConfig;
  notice: NoticeConfig;
  credit: CreditConfig;
  commission: CommissionConfig;
};

type ConfigKey = keyof BizConfig;

/** 默认值：缺失 / 非法 / 越界一律回落到这里，绝不因为配置问题让核心链路不可用 */
export const BIZ_CONFIG_DEFAULTS: Record<string, string> = {
  'biz.booking.timezone': DEFAULT_SHOP_TIMEZONE,
  'biz.booking.stepMinutes': '15',
  'biz.booking.minLeadMinutes': '60',
  'biz.booking.adminMinLeadMinutes': '0',
  'biz.booking.maxAdvanceDays': '30',
  'biz.booking.noShowGraceMinutes': '15',
  'biz.booking.depositPermille': '300',
  'biz.member.pointsPerYuan': '1',
  'biz.member.pointsDiscountPerYuan': '100',
  'biz.member.maxPointsPermille': '300',
  'biz.member.maxBonusPermille': '200',
  'biz.member.bonusDeductMode': 'bonus_first',
  'biz.member.minRechargeAmount': '10000',
  'biz.member.refundNeedReason': 'true',
  'biz.payment.qrExpireMinutes': '5',
  'biz.payment.reconcileHour': '6',
  'biz.notice.smsEnabled': 'false',
  'biz.notice.smsTemplates': '',
  'biz.notice.retryLimit': '3',
  'biz.credit.defaultLimit': '0',
  'biz.credit.defaultSettleDay': '5',
  'biz.commission.periodCloseDay': '5',
};

/** 配置中文名，供 seed 写入 `sys_config.name` */
export const BIZ_CONFIG_LABELS: Record<string, string> = {
  'biz.booking.timezone': '店内时区',
  'biz.booking.stepMinutes': '可约时段粒度（分钟）',
  'biz.booking.minLeadMinutes': '小程序端最少提前预约（分钟）',
  'biz.booking.adminMinLeadMinutes': '后台代录最少提前预约（分钟）',
  'biz.booking.maxAdvanceDays': '最多提前预约天数',
  'biz.booking.noShowGraceMinutes': '爽约判定容忍期（分钟）',
  'biz.booking.depositPermille': '默认定金比例（‰）',
  'biz.member.pointsPerYuan': '每元累计积分',
  'biz.member.pointsDiscountPerYuan': '多少积分抵 1 元',
  'biz.member.maxPointsPermille': '单笔积分抵扣上限（‰）',
  'biz.member.maxBonusPermille': '充值赠送比例上限（‰）',
  'biz.member.bonusDeductMode': '余额扣减顺序',
  'biz.member.minRechargeAmount': '单次充值下限（分）',
  'biz.member.refundNeedReason': '退款/冲正是否必填原因',
  'biz.payment.qrExpireMinutes': '在线支付二维码有效期（分钟）',
  'biz.payment.reconcileHour': '每日对账触发小时',
  'biz.notice.smsEnabled': '短信总开关',
  'biz.notice.smsTemplates': '允许走短信的模板白名单',
  'biz.notice.retryLimit': '通知失败重试上限',
  'biz.credit.defaultLimit': '新挂账主体默认额度（分）',
  'biz.credit.defaultSettleDay': '默认月结日',
  'biz.commission.periodCloseDay': '提成结算日',
};

const CACHE_TTL_MS = 10_000;

/**
 * 业务配置读取入口。
 *
 * 所有 `biz.*` 配置项都在这里解析：`sys_config.value` 是字符串，缺失 / 非法 /
 * 越界一律回落默认值，不允许在各 service 里散落 `Number(...)`（§5.6）。
 */
export class BizConfigService {
  private cache: { at: number; values: Map<string, string> } | null = null;

  constructor(private readonly database: DatabaseService) {}

  /** 清缓存（配置页保存后调用，或等待 10 秒自然过期） */
  invalidate(): void {
    this.cache = null;
  }

  async getString(key: string, fallback: string): Promise<string> {
    const values = await this.load();
    const raw = values.get(key);
    return raw === undefined || raw === '' ? fallback : raw;
  }

  async getInt(
    key: string,
    fallback: number,
    bounds?: { min?: number; max?: number },
  ): Promise<number> {
    const raw = await this.getString(key, String(fallback));
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    const value = Math.trunc(parsed);
    if (bounds?.min !== undefined && value < bounds.min) return fallback;
    if (bounds?.max !== undefined && value > bounds.max) return fallback;
    return value;
  }

  async getBoolean(key: string, fallback: boolean): Promise<boolean> {
    const raw = (await this.getString(key, String(fallback)))
      .trim()
      .toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(raw)) return true;
    if (['false', '0', 'no', 'off'].includes(raw)) return false;
    return fallback;
  }

  async getList(key: string): Promise<string[]> {
    const raw = await this.getString(key, '');
    return raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  async booking(): Promise<BookingConfig> {
    return {
      timezone: await this.getString(
        'biz.booking.timezone',
        DEFAULT_SHOP_TIMEZONE,
      ),
      stepMinutes: await this.getInt('biz.booking.stepMinutes', 15, {
        min: 5,
        max: 120,
      }),
      minLeadMinutes: await this.getInt('biz.booking.minLeadMinutes', 60, {
        min: 0,
      }),
      adminMinLeadMinutes: await this.getInt(
        'biz.booking.adminMinLeadMinutes',
        0,
        { min: 0 },
      ),
      maxAdvanceDays: await this.getInt('biz.booking.maxAdvanceDays', 30, {
        min: 1,
        max: 365,
      }),
      noShowGraceMinutes: await this.getInt(
        'biz.booking.noShowGraceMinutes',
        15,
        { min: 0 },
      ),
      depositPermille: await this.getInt('biz.booking.depositPermille', 300, {
        min: 0,
        max: 1000,
      }),
    };
  }

  async member(): Promise<MemberConfig> {
    const mode = await this.getString(
      'biz.member.bonusDeductMode',
      'bonus_first',
    );
    return {
      pointsPerYuan: await this.getInt('biz.member.pointsPerYuan', 1, {
        min: 0,
      }),
      pointsDiscountPerYuan: await this.getInt(
        'biz.member.pointsDiscountPerYuan',
        100,
        { min: 1 },
      ),
      maxPointsPermille: await this.getInt(
        'biz.member.maxPointsPermille',
        300,
        { min: 0, max: 1000 },
      ),
      maxBonusPermille: await this.getInt(
        'biz.member.maxBonusPermille',
        200,
        { min: 0 },
      ),
      bonusDeductMode:
        mode === 'proportional' ? 'proportional' : 'bonus_first',
      minRechargeAmount: await this.getInt(
        'biz.member.minRechargeAmount',
        10000,
        { min: 0 },
      ),
      refundNeedReason: await this.getBoolean(
        'biz.member.refundNeedReason',
        true,
      ),
    };
  }

  async payment(): Promise<PaymentConfig> {
    return {
      qrExpireMinutes: await this.getInt('biz.payment.qrExpireMinutes', 5, {
        min: 1,
        max: 60,
      }),
      reconcileHour: await this.getInt('biz.payment.reconcileHour', 6, {
        min: 0,
        max: 23,
      }),
    };
  }

  async notice(): Promise<NoticeConfig> {
    return {
      smsEnabled: await this.getBoolean('biz.notice.smsEnabled', false),
      smsTemplates: await this.getList('biz.notice.smsTemplates'),
      retryLimit: await this.getInt('biz.notice.retryLimit', 3, {
        min: 0,
        max: 10,
      }),
    };
  }

  async credit(): Promise<CreditConfig> {
    return {
      defaultLimit: await this.getInt('biz.credit.defaultLimit', 0, { min: 0 }),
      defaultSettleDay: await this.getInt(
        'biz.credit.defaultSettleDay',
        5,
        { min: 0, max: 28 },
      ),
    };
  }

  async commission(): Promise<CommissionConfig> {
    return {
      periodCloseDay: await this.getInt('biz.commission.periodCloseDay', 5, {
        min: 1,
        max: 28,
      }),
    };
  }

  /** 一次性取全部（内部会命中同一份缓存，不会多次查库） */
  async all(): Promise<BizConfig> {
    const [booking, member, payment, notice, credit, commission] =
      await Promise.all([
        this.booking(),
        this.member(),
        this.payment(),
        this.notice(),
        this.credit(),
        this.commission(),
      ]);
    return { booking, member, payment, notice, credit, commission };
  }

  private async load(): Promise<Map<string, string>> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < CACHE_TTL_MS)
      return this.cache.values;
    const rows = await this.database.db
      .select({ key: configs.key, value: configs.value })
      .from(configs)
      .where(and(isNull(configs.deletedAt)));
    const values = new Map<string, string>();
    for (const [key, value] of Object.entries(BIZ_CONFIG_DEFAULTS))
      values.set(key, value);
    for (const row of rows) values.set(row.key, row.value);
    this.cache = { at: now, values };
    return values;
  }
}

/** 供测试与 seed 使用的键清单 */
export const BIZ_CONFIG_KEYS: string[] = Object.keys(BIZ_CONFIG_DEFAULTS);

export type { ConfigKey };
