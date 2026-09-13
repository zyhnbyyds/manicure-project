import { Injectable } from '@nestjs/common';
import { and, isNull } from 'drizzle-orm';
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

/** 门店档案（小程序「门店」页与客服/导航都用这一份） */
export type ShopProfileConfig = {
  name: string;
  nameEn: string;
  phone: string;
  address: string;
  hours: string;
  latitude: number;
  longitude: number;
  /** 公告 / 到店须知；没配是空串 */
  notice: string;
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
  'biz.shop.name': '美甲小铺',
  'biz.shop.nameEn': 'BEAUTY NAILS',
  'biz.shop.phone': '13800000000',
  'biz.shop.address': '上海市静安区南京西路 1788 号 3 楼 355 室',
  'biz.shop.hours': '10:00 - 20:00',
  'biz.shop.latitude': '31.229',
  'biz.shop.longitude': '121.455',
  /** 公告 / 到店须知；空串 = 小程序端不显示这一块 */
  'biz.shop.notice': '',
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
  /**
   * 小程序自助支付的两道闸门（A14）。**放在这里而不是环境变量**：
   * 放量比例本来就是要随时调的，塞在 env 里得重启才能改；
   * 管理端「参数配置」页可直接编辑 `sys_config`，改完最多 10 秒（缓存 TTL）生效。
   *
   * 默认值是**安全侧**：`false` / `0` —— 全新库、没跑过 seed 时也是关闭的。
   */
  'app.pay.selfPayEnabled': 'false',
  'app.pay.rolloutPercent': '0',
};

/** 配置中文名，供 seed 写入 `sys_config.name` */
export const BIZ_CONFIG_LABELS: Record<string, string> = {
  'biz.shop.name': '门店名称（通知模板 {shopName} 变量）',
  'biz.shop.nameEn': '门店英文副标题',
  'biz.shop.phone': '门店电话（客服 / 导航拨号）',
  'biz.shop.address': '门店地址',
  'biz.shop.hours': '营业时间',
  'biz.shop.latitude': '纬度（地图导航）',
  'biz.shop.longitude': '经度（地图导航）',
  'biz.shop.notice': '门店公告 / 到店须知',
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
  'app.pay.selfPayEnabled': '小程序自助支付-合规闸门',
  'app.pay.rolloutPercent': '小程序自助支付-放量比例（0~100）',
};

/**
 * 需要额外解释的配置项（会写进 `sys_config.remark`，在「参数配置」列表里可见）。
 *
 * 只给**改错了会出事**的那几项写，其余沿用默认备注 —— 备注太长反而没人看。
 */
export const BIZ_CONFIG_REMARKS: Record<string, string> = {
  'app.pay.selfPayEnabled':
    '⚠️ 合规硬闸门：虚拟支付接入（或法务确认无需接入）之前必须保持 false。' +
    'true 时小程序才可能出现余额/次卡/积分自助支付入口。',
  'app.pay.rolloutPercent':
    '0 = 小程序只做预约（不出现支付入口）；100 = 全量；1~99 按 app_wx_user.id ' +
    '稳定分桶放量（同一微信号结果恒定）。只在上一项为 true 时生效。',
};

const CACHE_TTL_MS = 10_000;

/**
 * 运行时配置读取入口。
 *
 * 所有 `sys_config` 里的配置项（`biz.*` 业务配置、`app.*` 小程序运行时开关）都在这里解析：
 * `sys_config.value` 是字符串，缺失 / 非法 / 越界一律回落默认值，
 * 不允许在各 service 里散落 `Number(...)`（§5.6）。
 *
 * **必须带 `@Injectable()`**：否则 Nest 拿不到构造函数参数的元数据，
 * 会注入 `undefined`（表现为运行时报 `this.database` 不是对象），
 * 而 `tsc` 完全看不出问题。
 */
@Injectable()
export class BizConfigService {
  private cache: { at: number; values: Map<string, string> } | null = null;
  /**
   * 进行中的加载。
   *
   * `all()` 会并发读六组配置，若只靠 `cache` 判空，六个并发调用会在首次
   * 加载时各自查一次库（缓存击穿）。共享同一个 Promise 后只查一次。
   */
  private inflight: Promise<Map<string, string>> | null = null;

  constructor(private readonly database: DatabaseService) {}

  /** 清缓存（配置页保存后调用，或等待 10 秒自然过期） */
  invalidate(): void {
    this.cache = null;
    this.inflight = null;
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

  /**
   * 小程序自助支付的两道闸门（A14），**管理端「参数配置」可直接改**。
   *
   * - `enabled`：合规硬闸门。虚拟支付接入（或法务确认无需接入）之前必须为 `false`；
   * - `rolloutPercent`：放量比例 `0~100`。`0` = 小程序只做预约；`100` = 全量；
   *   中间值按 `app_wx_user.id` 稳定分桶（见 `modules/app/pay-rollout.ts`）。
   *
   * 两者是 **AND**：`enabled=false` 时比例设多少都不生效 —— 免得有人把比例调成 100
   * 就顺手绕过了合规。
   *
   * 越界的比例（如填了 999）由 `getInt` 的 bounds **回落默认值 0**（安全侧），
   * 而不是夹到 100 —— 填错时宁可"没放量"，也不要"意外全量"。
   */
  async appSelfPay(): Promise<{ enabled: boolean; rolloutPercent: number }> {
    return {
      enabled: await this.getBoolean('app.pay.selfPayEnabled', false),
      rolloutPercent: await this.getInt('app.pay.rolloutPercent', 0, {
        min: 0,
        max: 100,
      }),
    };
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
      maxBonusPermille: await this.getInt('biz.member.maxBonusPermille', 200, {
        min: 0,
      }),
      bonusDeductMode: mode === 'proportional' ? 'proportional' : 'bonus_first',
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

  /**
   * 门店档案（小程序「门店」页）。
   *
   * 这些值以前硬编码在小程序的 `config.ts` 里，改一次要重新发版 —— 而门店电话、
   * 营业时间恰恰是最常改的信息。现在统一走 `sys_config`，管理端「参数配置」可直接改。
   *
   * 缺省值与小程序原来的常量**逐字一致**：没配过的新库渲染出来的样子不变。
   * 经纬度用 `Number` 解析，非法值回落到默认（不能因为门店手滑填了空串就导航到 0,0）。
   */
  async shopProfile(): Promise<ShopProfileConfig> {
    const latitude = Number(
      await this.getString('biz.shop.latitude', '31.229'),
    );
    const longitude = Number(
      await this.getString('biz.shop.longitude', '121.455'),
    );
    return {
      name: await this.getString('biz.shop.name', '美甲小铺'),
      nameEn: await this.getString('biz.shop.nameEn', 'BEAUTY NAILS'),
      phone: await this.getString('biz.shop.phone', '13800000000'),
      address: await this.getString(
        'biz.shop.address',
        '上海市静安区南京西路 1788 号 3 楼 355 室',
      ),
      hours: await this.getString('biz.shop.hours', '10:00 - 20:00'),
      latitude: Number.isFinite(latitude) ? latitude : 31.229,
      longitude: Number.isFinite(longitude) ? longitude : 121.455,
      notice: await this.getString('biz.shop.notice', ''),
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
      defaultSettleDay: await this.getInt('biz.credit.defaultSettleDay', 5, {
        min: 0,
        max: 28,
      }),
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
    this.inflight ??= this.fetchValues(now).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetchValues(at: number): Promise<Map<string, string>> {
    const rows = await this.database.db
      .select({ key: configs.key, value: configs.value })
      .from(configs)
      .where(and(isNull(configs.deletedAt)));
    const values = new Map<string, string>();
    for (const [key, value] of Object.entries(BIZ_CONFIG_DEFAULTS))
      values.set(key, value);
    for (const row of rows) values.set(row.key, row.value);
    this.cache = { at, values };
    return values;
  }
}

/** 供测试与 seed 使用的键清单 */
export const BIZ_CONFIG_KEYS: string[] = Object.keys(BIZ_CONFIG_DEFAULTS);

export type { ConfigKey };
