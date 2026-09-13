/**
 * 跨模块调用端口（依赖倒置）。
 *
 * 各业务模块**只依赖本文件的抽象类**，不直接 import 别人的 service：
 * 具体实现由 `BizModule`（@Global）用 `useExisting` 绑定到这些 token 上。
 * 这样并行开发的模块之间没有编译期耦合，也不会出现循环依赖。
 *
 * 方法签名是冻结契约，见 `project-design/superpowers/plans/2026-09-11-b1-b6-implementation-plan.md`。
 */
import type {
  bizBookingItems,
  bizBookingRecurrences,
  bizBookings,
  bizCreditAccounts,
  bizCustomers,
  bizMemberCards,
  bizReceivables,
  bizServiceItems,
  bizStaffs,
} from '../../../database/schema/index.js';
import type { BizDatabase, BizTx } from './tx.js';

export type ServiceItemRow = typeof bizServiceItems.$inferSelect;
export type BookingRow = typeof bizBookings.$inferSelect;
export type BookingItemRow = typeof bizBookingItems.$inferSelect;
export type StaffRow = typeof bizStaffs.$inferSelect;
export type CustomerRow = typeof bizCustomers.$inferSelect;
export type MemberCardRow = typeof bizMemberCards.$inferSelect;
export type CreditAccountRow = typeof bizCreditAccounts.$inferSelect;
export type ReceivableRow = typeof bizReceivables.$inferSelect;
export type RecurrenceRow = typeof bizBookingRecurrences.$inferSelect;

export type PageResult<T> = { items: T[]; page: number; pageSize: number };

/* ------------------------------------------------------------------ *
 * 基础数据（B1）
 * ------------------------------------------------------------------ */

export abstract class ServiceItemPort {
  abstract list(
    page: number,
    pageSize: number,
    filter: { keyword?: string; status?: 'active' | 'disabled' },
  ): Promise<PageResult<ServiceItemRow>>;
  abstract findOne(id: number): Promise<ServiceItemRow>;
  abstract create(
    input: {
      name: string;
      category?: string | null;
      durationMinutes: number;
      bufferMinutes?: number;
      price?: number;
      description?: string | null;
      /** 图集：服务端据此派生封面 `image`，调用方不能直接写 `image` */
      images?: string[] | null;
      status?: 'active' | 'disabled';
      sort?: number;
      remark?: string | null;
    },
    actorId: number,
  ): Promise<{ id: number }>;
  abstract update(id: number, input: unknown, actorId: number): Promise<void>;
  abstract remove(id: number, actorId: number): Promise<void>;
  /** 去重后 1..3 个；缺失 / 停用抛 BadRequest */
  abstract requireActiveItems(
    ids: number[],
    tx?: BizTx,
  ): Promise<ServiceItemRow[]>;
  abstract listActive(): Promise<ServiceItemRow[]>;
}

export abstract class StaffPort {
  abstract list(
    page: number,
    pageSize: number,
    filter: { keyword?: string; status?: 'active' | 'disabled' },
  ): Promise<PageResult<StaffRow>>;
  abstract findOne(id: number): Promise<StaffRow>;
  abstract create(input: unknown, actorId: number): Promise<{ id: number }>;
  abstract update(id: number, input: unknown, actorId: number): Promise<void>;
  abstract remove(id: number, actorId: number): Promise<void>;
  abstract requireActive(id: number, tx?: BizTx): Promise<StaffRow>;
  abstract listActive(): Promise<StaffRow[]>;
  abstract findByUserId(userId: number): Promise<StaffRow | null>;
  /**
   * 手机号匹配美甲师档案（小程序工作台开通用）。
   *
   * 与 `CustomerPort.findByPhone` 同一口径：**不过滤软删、也不过滤停用**——
   * 调用方要能区分「查无此人 / 已停用 / 已删除」并给出不同提示；
   * 若这里先过滤掉，调用方只能看到「找不到」，无法解释原因。
   */
  abstract findByPhone(phone: string): Promise<StaffRow | null>;
  /** null = 可做全部项目；数组 = 白名单（§22） */
  abstract allowedServiceItemIds(
    staffId: number,
    tx?: BizTx,
  ): Promise<number[] | null>;
  abstract setServiceItems(
    staffId: number,
    serviceItemIds: number[],
    actorId: number,
  ): Promise<void>;
  abstract getServiceItems(
    staffId: number,
  ): Promise<{ id: number; name: string }[]>;
}

export abstract class CustomerPort {
  abstract list(
    page: number,
    pageSize: number,
    filter: { keyword?: string; levelId?: number; hasBalance?: boolean },
  ): Promise<PageResult<CustomerRow>>;
  abstract findOne(id: number): Promise<CustomerRow>;
  abstract create(
    input: {
      name: string;
      phone?: string | null;
      gender?: 'unknown' | 'male' | 'female';
      birthday?: string | null;
      remark?: string | null;
    },
    actorId: number,
  ): Promise<{ id: number }>;
  abstract update(id: number, input: unknown, actorId: number): Promise<void>;
  abstract remove(id: number, actorId: number): Promise<void>;
  /**
   * 恢复软删档案（§4.3）。
   *
   * 软删只置 `deleted_at`，余额/积分/次卡历史都还在行上 —— 恢复会把它们一并带回来，
   * 属数据完整性动作，所以只能由门店在后台显式触发；小程序端自助绑定一律拒绝（409）。
   */
  abstract restore(id: number, actorId: number): Promise<void>;
  abstract requireById(id: number, tx?: BizTx): Promise<CustomerRow>;
  /** 不过滤软删（§4.3 坑 1） */
  abstract findByPhone(phone: string): Promise<CustomerRow | null>;
  abstract listBookings(
    customerId: number,
    page: number,
    pageSize: number,
  ): Promise<PageResult<Record<string, unknown>>>;
  abstract recount(
    customerId: number,
    actorId?: number | null,
  ): Promise<{ visitCount: number; lastVisitAt: Date | null }>;
  /** 预约完成时累加 visit_count / last_visit_at（只在 affectedRows=1 时调用） */
  abstract onBookingCompleted(tx: BizTx, customerId: number): Promise<void>;
  /** 纳为会员：生成会员号与入会时间 */
  abstract ensureMembership(
    tx: BizTx,
    customerId: number,
    actorId?: number | null,
  ): Promise<{ memberNo: string; memberSince: Date }>;
}

/* ------------------------------------------------------------------ *
 * 排班与可约时段（B1）
 * ------------------------------------------------------------------ */

export type SlotQuery = {
  staffId: number;
  /** 店内本地日 YYYY-MM-DD */
  date: string;
  serviceItemIds: number[];
  channel: 'admin' | 'miniapp';
  timeZone?: string | undefined;
};

export type SlotResult = {
  slots: { startAt: string; endAt: string }[];
  reason?:
    | 'off'
    | 'no_shift'
    | 'staff_cannot_do'
    | 'fully_booked'
    | 'out_of_window';
  durationMinutes: number;
  bufferMinutes: number;
};

export abstract class SlotPort {
  abstract availableSlots(query: SlotQuery): Promise<SlotResult>;
  /** 事务内冲突复检（查询带 FOR UPDATE，§6.2 硬约束 1） */
  abstract assertNoConflict(
    tx: BizTx,
    input: {
      staffId: number;
      startAt: Date;
      durationMinutes: number;
      bufferMinutes: number;
      excludeBookingId?: number | undefined;
    },
  ): Promise<void>;
  abstract findConflicts(
    tx: BizTx,
    input: {
      staffId: number;
      startAt: Date;
      durationMinutes: number;
      bufferMinutes: number;
      excludeBookingId?: number | undefined;
    },
  ): Promise<{ id: number; bookingNo: string; startAt: Date; endAt: Date }[]>;
}

/** 排班（B1）：供预约冲突保护与排班页使用 */
export abstract class SchedulePort {
  abstract getWeeklyShifts(
    staffId: number,
  ): Promise<
    { id: number; weekday: number; startTime: string; endTime: string }[]
  >;
  abstract replaceWeeklyShifts(
    staffId: number,
    shifts: { weekday: number; startTime: string; endTime: string }[],
    actorId: number,
  ): Promise<void>;
  abstract listOverrides(
    staffId: number,
    filter: { from?: string | undefined; to?: string | undefined },
  ): Promise<
    {
      id: number;
      date: string;
      type: 'off' | 'custom';
      startTime: string | null;
      endTime: string | null;
      reason: string | null;
    }[]
  >;
  abstract createOverride(
    staffId: number,
    input: {
      date: string;
      type: 'off' | 'custom';
      startTime?: string | undefined;
      endTime?: string | undefined;
      reason?: string | undefined;
    },
    actorId: number,
    force?: boolean,
  ): Promise<{ id: number; conflicts: BookingConflictItem[] }>;
  abstract deleteOverride(
    staffId: number,
    overrideId: number,
    actorId: number,
    force?: boolean,
  ): Promise<{ conflicts: BookingConflictItem[] }>;
  /** 求值优先级：off → 不可约；custom → 替代周模板；否则周模板 */
  abstract resolveShifts(
    staffId: number,
    date: string,
    tx?: BizTx,
  ): Promise<{
    off: boolean;
    segments: { startTime: string; endTime: string }[];
  }>;
}

export type BookingConflictItem = {
  id: number;
  bookingNo: string;
  startAt: Date;
  endAt: Date;
  customerName: string;
  staffId: number;
};

/* ------------------------------------------------------------------ *
 * 预约资金重算（B1）
 * ------------------------------------------------------------------ */

export type PayStatus = 'unpaid' | 'partial' | 'paid' | 'refunded' | 'credit';

export type RecountResult = {
  paidAmount: number;
  dueAmount: number;
  refundAmount: number;
  payStatus: PayStatus;
  channelSummary: string | null;
  settledAt: Date | null;
};

export abstract class SettlementPort {
  /** 金额事实的唯一重算入口（§15.7 不变量 4） */
  abstract recalc(tx: BizTx, bookingId: number): Promise<RecountResult>;
}

/* ------------------------------------------------------------------ *
 * 会员账务与次卡（B2）
 * ------------------------------------------------------------------ */

export type PricingContext = {
  customerId: number;
  levelId: number | null;
  levelDiscountPermille: number;
  points: number;
  balancePrincipal: number;
  balanceBonus: number;
  /**
   * 单笔积分抵扣上限（千分比，`biz.member.maxPointsPermille`，默认 300）。
   *
   * **必须由服务端给**：小程序确认页要展示「预估可抵扣多少」，
   * 而它曾经在前端硬编码这个值（500），与后端默认（300）不一致 ——
   * 结果预估比服务端允许的多，顾客按预估下单、服务端一夹取就对不上。
   */
  maxPointsPermille: number;
};

export type PayChannel =
  | 'cash'
  | 'wechat'
  | 'alipay'
  | 'balance'
  | 'card'
  | 'wechat_offline'
  | 'alipay_offline'
  | 'wxpay_native'
  | 'alipay_qr'
  /** 小程序 JSAPI：`biz_payment.channel` 已预留，落库可行但 C1 未接入（见 `toPaymentChannel`） */
  | 'wxpay_jsapi'
  | 'credit';

export abstract class MemberAccountPort {
  abstract getPricingContext(customerId: number): Promise<PricingContext>;
  /** 事务内锁会员行并返回最新快照（锁顺序第二位） */
  abstract lockAccount(tx: BizTx, customerId: number): Promise<PricingContext>;
  /** 储值余额扣减（条件更新，余额不足抛 ConflictException，绝不部分扣） */
  abstract applyBalancePayment(
    tx: BizTx,
    input: {
      customerId: number;
      amount: number;
      bookingId?: number | null;
      remark?: string | null;
      actorId?: number | null;
    },
  ): Promise<{ transactionId: number; bonus: number; principal: number }>;
  /** 积分抵扣（条件更新，积分不足抛 ConflictException） */
  abstract deductPoints(
    tx: BizTx,
    input: {
      customerId: number;
      points: number;
      bookingId?: number | null;
      type?: 'points_spend' | 'points_redeem';
      remark?: string | null;
      actorId?: number | null;
    },
  ): Promise<{ transactionId: number; amount: number }>;
  /** 消费落账：累加 total_spent + 累计积分 + 写流水 + 自动升级 */
  abstract recordConsumption(
    tx: BizTx,
    input: {
      customerId: number;
      paidAmount: number;
      bookingId?: number | null;
      payChannel?: PayChannel | null;
      remark?: string | null;
      actorId?: number | null;
    },
  ): Promise<{
    transactionId: number;
    pointsEarned: number;
    levelId: number | null;
  }>;
  /** 按金额冲减消费与积分（退款用） */
  abstract reverseConsumption(
    tx: BizTx,
    input: {
      customerId: number;
      amount: number;
      bookingId?: number | null;
      reversalOf?: number | null;
      remark?: string | null;
      actorId?: number | null;
    },
  ): Promise<{ transactionId: number; pointsReversed: number }>;
  /** 回补储值余额（退入储值 / 充正，余额只增） */
  abstract creditBalance(
    tx: BizTx,
    input: {
      customerId: number;
      principal?: number;
      bonus?: number;
      bookingId?: number | null;
      remark?: string | null;
      actorId?: number | null;
    },
  ): Promise<{ transactionId: number }>;
  /** 按流水重算余额/积分/累计消费/等级（对账修复，幂等） */
  abstract recount(customerId: number, actorId?: number | null): Promise<void>;
  /** 自动升级（幂等） */
  abstract syncLevel(tx: BizTx, customerId: number): Promise<number | null>;
  abstract recountAllLevels(): Promise<{ updated: number }>;
}

export abstract class MemberCardPort {
  abstract issueCard(
    tx: BizTx,
    input: {
      customerId: number;
      cardTypeId: number;
      payChannel: 'cash' | 'wechat' | 'alipay' | 'balance';
      price?: number;
      remark?: string | null;
      actorId?: number | null;
    },
  ): Promise<{ id: number; cardNo: string; expireAt: Date | null }>;
  abstract useCard(
    tx: BizTx,
    input: {
      cardId: number;
      serviceItemId: number;
      bookingId?: number | null;
      actorId?: number | null;
    },
  ): Promise<{
    cardId: number;
    usedTimes: number;
    totalTimes: number;
    status: string;
  }>;
  abstract revertUse(
    tx: BizTx,
    input: {
      cardId: number;
      bookingId?: number | null;
      actorId?: number | null;
    },
  ): Promise<void>;
  abstract assertUsable(
    tx: BizTx,
    cardId: number,
    serviceItemIds: number[],
  ): Promise<MemberCardRow>;
  abstract expireCards(): Promise<{ expired: number }>;
  /**
   * 某顾客名下的次卡（app 域「我的次卡」A9 用），按 id 倒序、不含软删。
   *
   * 上限 200 条：次卡是低频资产，C 端也不该无限翻页。
   * **只返回卡本身**：可用与否由调用方按 `assertUsable` 的同一套规则判定
   * （见 `app-member.service.ts` 的 `displayCardStatus`），端口不替调用方下结论。
   */
  abstract listByCustomer(customerId: number): Promise<MemberCardRow[]>;
}

/* ------------------------------------------------------------------ *
 * 收银（B3）
 * ------------------------------------------------------------------ */

/** 事务外**预先下好**的渠道订单（仅在线渠道） */
export type PreparedChannelOrder = {
  outTradeNo: string;
  codeUrl: string;
  expireAt: Date;
  /** 渠道原始应答（写进 `biz_payment_log` 留证） */
  raw: unknown;
};

export type PaymentDraft = {
  customerId: number;
  bookingId?: number | null | undefined;
  purpose: 'deposit' | 'final' | 'recharge' | 'card_buy' | 'credit_settle';
  channel: PayChannel;
  amount: number;
  receivedAmount?: number | undefined;
  memberCardId?: number | null | undefined;
  remark?: string | null | undefined;
  /**
   * **在线渠道必填**：由调用方在事务外调 `prepareChannelOrder` 得到。
   *
   * 渠道下单是网络 IO（超时 5 秒），放进数据库事务会一直持锁等它 ——
   * 而本地单号又依赖「先插单拿主键」，所以必须把渠道下单提到事务之前，
   * 用与主键无关的交易号（`buildOutTradeNoByToken`）。
   */
  channelOrder?: PreparedChannelOrder | undefined;
};

export type PaymentOutcome = {
  paymentId: number;
  paymentNo: string;
  outTradeNo: string;
  status: 'pending' | 'success';
  channel: PayChannel;
  amount: number;
  receivedAmount: number;
  codeUrl: string | null;
  expireAt: Date | null;
};

export abstract class PaymentPort {
  /**
   * **事务外**准备在线渠道订单；离线渠道返回 `null`（不需要渠道）。
   *
   * ⚠️ **渠道未配置时抛错**：调用方应在**写任何本地数据之前**调用它，
   * 这样「未配置 → 不留 pending 单」从「事务回滚」升级为「根本没开始」。
   */
  abstract prepareChannelOrder(
    draft: PaymentDraft,
  ): Promise<PreparedChannelOrder | null>;

  /** 批量准备（结果与入参下标对齐）；事务外调用，一次事务里下多笔时用这个 */
  abstract prepareChannelOrders(
    drafts: PaymentDraft[],
  ): Promise<(PreparedChannelOrder | null)[]>;

  /**
   * 同事务落支付单；在线渠道落 pending + code_url（**必须已在事务外备好**），
   * 线下/储值/次卡直接 success。
   */
  abstract createInTx(
    tx: BizTx,
    draft: PaymentDraft,
    actorId?: number | null,
  ): Promise<PaymentOutcome>;
  /** 自己开事务（充值 / 购卡 / 销账等独立收款项） */
  abstract create(
    draft: PaymentDraft,
    actorId?: number | null,
  ): Promise<PaymentOutcome>;
  /** 关掉某个预约下所有 pending 支付单（重新收款前调用） */
  abstract closePendingOfBooking(
    tx: BizTx,
    bookingId: number,
    actorId?: number | null,
  ): Promise<{ closed: number }>;
  abstract closeExpired(): Promise<{ closed: number }>;
  abstract queryPending(): Promise<{ checked: number; settled: number }>;
  abstract reconcile(billDate: string): Promise<{ diffs: number }>;

  /**
   * 渠道回调（A13）。app 域自己**不准**再写一份支付逻辑，一律走这里。
   *
   * 内部顺序（见 `money-invariants` §3 / §7 / §8）：
   * 验签 → 支付单存在 → **金额与订单一致**（不一致写 `callback_invalid` 日志并拒绝，
   * 绝不按回调金额改账）→ `WHERE out_trade_no=? AND status='pending'` 条件更新
   * （`affectedRows=0` = 已处理过，直接答成功，不重复发货）→ **同事务发货**
   * → 事务提交后才发通知 → 3 秒内应答渠道。
   *
   * 返回的 `statusCode` 恒为 200：渠道按**应答体**判断成败（`{code:'SUCCESS'}` /
   * `{code:'FAIL'}`），返回 4xx/5xx 只会触发无意义的重试。
   */
  abstract handleNotify(
    channel: 'wxpay_native' | 'alipay_qr',
    raw: {
      headers: Record<string, string | string[] | undefined>;
      body: unknown;
      /** 必须传原样报文：验签的字符串对键顺序敏感 */
      rawBody?: string | undefined;
    },
  ): Promise<{ statusCode: number; body: string }>;
}

/* ------------------------------------------------------------------ *
 * 挂账应收（B4）
 * ------------------------------------------------------------------ */

export abstract class CreditPort {
  /** 下单挂账：校验额度 → 建应收单（**不写支付单**） */
  abstract createFromBooking(
    tx: BizTx,
    input: {
      creditAccountId: number;
      bookingId: number;
      customerId: number;
      amount: number;
      actorId?: number | null;
    },
  ): Promise<{
    receivableId: number;
    receivableNo: string;
    dueDate: string | null;
  }>;
  abstract assertCreditAvailable(
    tx: BizTx,
    creditAccountId: number,
    amount: number,
  ): Promise<CreditAccountRow>;
  abstract markOverdue(): Promise<{ overdue: number }>;
}

/* ------------------------------------------------------------------ *
 * 通知（B5）
 * ------------------------------------------------------------------ */

export type NoticeSendInput = {
  templateCode: string;
  recipientType: 'customer' | 'user';
  recipientId: number;
  variables: Record<string, string | number>;
  bookingId?: number | null;
  channels?: ('sms' | 'site')[] | undefined;
};

export abstract class NoticePort {
  /** 事务后发送：内部捕获异常，失败只写 failed 日志，绝不抛出（不拖垮主流程） */
  abstract send(
    input: NoticeSendInput,
  ): Promise<{ sent: number; failed: number; logIds: number[] }>;
  /** 只落 pending 记录（事务内调用，避免事务里做网络 IO） */
  abstract enqueueInTx(tx: BizTx, input: NoticeSendInput): Promise<number[]>;
  abstract retryFailed(): Promise<{ retried: number; succeeded: number }>;
  /** 次日预约提醒（定时任务 `sendBookingReminders`，必须幂等） */
  abstract sendBookingReminders(): Promise<{ sent: number; skipped: number }>;

  /* ---------------------------------------------------------------- *
   * 小程序订阅消息授权台账（A12）
   * ---------------------------------------------------------------- */

  /**
   * 记录小程序订阅消息授权。
   *
   * 微信订阅消息的真实语义是**额度**：用户在客户端点一次「允许」，开发者就得到
   * 该模板一次下发权限，且可累积。所以按 `(app_wx_user_id, template_id)` 聚合累加，
   * 而不是记成 append-only 流水——后者查不出「还能发几次」。
   *
   * 两条硬约束：
   * 1. **未授权不报错、不阻塞业务**：客户端只上报用户点了「允许」的模板，
   *    拒绝 / 拒收根本不会走到这里，所以这个端口没有「授权失败」这种错误；
   * 2. `bookingId` 传了就必须属于该顾客（不存在 → 404，他人单 → 403），
   *    归属一律按预约事实判定，不听客户端的。
   */
  abstract recordSubscribeGrant(
    input: SubscribeGrantInput,
  ): Promise<{ accepted: string[] }>;
}

export type SubscribeGrantInput = {
  appWxUserId: number;
  customerId: number;
  /** 客户端上报的、用户已点「允许」的模板；微信限制单次最多 3 个（入参 schema 已兜） */
  templateIds: string[];
  /** 这次授权是为了哪张单（仅上下文，可空） */
  bookingId: number | null;
};

/* ------------------------------------------------------------------ *
 * 预约（B1）：app 域（小程序）消费面
 *
 * `BookingOpsPort` 只给定时任务用（自动完成 / 自动爽约）；本端口给 app 域用。
 * app 域禁止 import 业务模块，所以工作 readonly 读取与「到店 / 完成」动作
 * 都必须从这里进（§12.4-1）。
 * ------------------------------------------------------------------ */

export type BookingStatus =
  | 'pending'
  | 'confirmed'
  | 'arrived'
  | 'completed'
  | 'cancelled'
  | 'no_show';

export type BookingPayStatus =
  | 'unpaid'
  | 'partial'
  | 'paid'
  | 'refunded'
  | 'credit';

/** 预约 + 项目明细快照（明细是下单时的快照，不回查服务项目表） */
export type BookingWithItems = BookingRow & { items: BookingItemRow[] };

export type StaffBookingFilter = {
  /** 店内本地日 YYYY-MM-DD */
  date?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  status?: BookingStatus | undefined;
};

/** A10 自助下单返回：与 `BookingsService.create` 的字段子集（不含改价/渠道明细） */
export type BookingCreateResult = {
  id: number;
  bookingNo: string;
  startAt: string;
  endAt: string;
  /** 小程序自助端的订单一律待确认（与后台代录的 confirmed 区分） */
  status: 'pending';
  durationMinutes: number;
  bufferMinutes: number;
  originalPrice: number;
  levelDiscountAmount: number;
  pointsDiscountAmount: number;
  pointsUsed: number;
  payableAmount: number;
  depositAmount: number;
  paidAmount: number;
  dueAmount: number;
  payStatus: BookingPayStatus;
  payChannelSummary: string | null;
  /** 下单时的项目快照（VO 投影用，不含成本/内部字段） */
  items: {
    serviceItemId: number;
    name: string;
    price: number;
    durationMinutes: number;
  }[];
};

/**
 * 上架中的充值档位（C 端展示用）。
 *
 * 只给「充多少 / 送多少 / 叫什么」——**不给**审计字段、状态、排序等内部信息。
 */
export type ActiveRechargePlan = {
  id: number;
  name: string;
  /** 实付金额（分） */
  payAmount: number;
  /** 赠送金额（分） */
  bonusAmount: number;
};

/**
 * 充值档位（C 端只读）。
 *
 * 小程序充值页**必须**从这里取档位：它曾经把「充 2000 送 800」这类档位
 * 硬编码在页面里，门店在后台改了配置、小程序还按旧比例宣传 ——
 * 一旦充值通道接通，用户看到与实际到账不一致，直接就是资金纠纷。
 */
export abstract class RechargePlanPort {
  abstract listActive(): Promise<ActiveRechargePlan[]>;
}
export abstract class BookingPort {
  /**
   * 美甲师本人的预约（S3）。
   *
   * 硬限定 `staff_id`，**不提供任何跨美甲师查询**（含排行榜，§12.4-2）。
   * 手机号原样返回 —— 脱敏是展示层规则（D11），端口不替展示层做决定。
   */
  abstract listByStaff(
    staffId: number,
    page: number,
    pageSize: number,
    filter: StaffBookingFilter,
  ): Promise<PageResult<BookingWithItems>>;
  /** 顾客本人的预约（「我的预约」，A10） */
  abstract listByCustomer(
    customerId: number,
    page: number,
    pageSize: number,
    filter?: { status?: BookingStatus | undefined },
  ): Promise<PageResult<BookingWithItems>>;
  /**
   * 按 id 取**本人**的预约详情（app 域自助支付 / 详情页用）。
   *
   * 不是本人的单与不存在的单**一律返回 `null`**（调用方统一映射 404）——
   * 刻意不区分 403/404：那会泄露「这个 id 存在、只是不属于你」。
   */
  abstract findForCustomer(
    customerId: number,
    bookingId: number,
  ): Promise<BookingWithItems | null>;
  /**
   * 顾客自助结算（付尾款，A14）。
   *
   * **与后台 `settle` 共用同一份资金核心**（算价 / 条件更新 / 流水 / `recalc` 一行未重写），
   * 只有两处差异：
   * 1. 归属判定是「本人」：`customerId` 只来自 token，不接受客户端传顾客 id；
   * 2. 渠道白名单只含**不需要通道对接**的 `balance` / `card`：在线渠道要等渠道对接，
   *    现金与线下收款码是店员动作，挂账要占额度并由店员选定主体。
   *
   * `memberCardId` 是「到店后用次卡核销」：下单没选卡的预约可以在结算时补上，
   * 服务端会**重算 `payable`**（次卡 → `payable = 0`），而不是简单记一笔 0 元支付单。
   */
  abstract settleForCustomer(
    customerId: number,
    bookingId: number,
    input: {
      payments?:
        | {
            channel: 'balance' | 'card';
            amount: number;
            memberCardId?: number | undefined;
          }[]
        | undefined;
      pointsUsed?: number | undefined;
      memberCardId?: number | undefined;
    },
  ): Promise<RecountResult & { payableAmount: number }>;
  /**
   * 自助下单（A10）。
   *
   * **复用后台创建九步**（§9.5）：前置校验 → 算价 → 锁美甲师行 → 冲突复检 →
   * 建单 + 明细 → 收款（可选：次卡当场核销 / 积分抵扣）→ 同一事务提交；
   * app 域**绝不另写一套**算价 / 时段 / 冲突检测（施工单 §0.2 纪律 2）。
   *
   * 与后台 `create()` 的三处差异：
   * 1. 落 `channel='miniapp'` + `status='pending'`（后台是 `admin` + `confirmed`，
   *    小程序提交进入待确认，与店员代录区分，§9.7）；
   * 2. **不收款**：小程序端没有在线支付通道（JSAPI 在 P2），订单保持 `unpaid`，
   *    由确认后收银 / 到店收款；`memberCardId` 传了则整单次卡**当场核销**（payable=0）；
   * 3. 无 `adjustAmount` / `force` / 挂账：小程序端没有改价权限、
   *    不允许覆盖冲突（顾客时段冲突直接 409，与后台带 `force` 的软检查区分）。
   *
   * `pointsToUse` 映射到后台的 `pointsUsed`（等级折扣 → 积分抵扣 → 应付，§5.7）。
   */
  abstract createForCustomer(
    customerId: number,
    input: {
      staffId: number;
      startAt: string;
      serviceItemIds: number[];
      memberCardId?: number | null | undefined;
      pointsToUse?: number | undefined;
      /** 优惠券 ID。**与积分二选一**，同时传会被建单处 400 拒绝 */
      couponId?: number | undefined;
      remark?: string | undefined;
    },
  ): Promise<BookingCreateResult>;
  /**
   * 自助取消（A10）：非本人单 → 403；不存在 → 404；
   * pending / confirmed 均可取消（后台 `cancel` 已覆盖，§7.3）。
   *
   * `reason` 必填（与后台同一口径）。取消后若已有实收会提示走退款审批，
   * **系统不会自动退**（§15.6 人工判责）。
   */
  abstract cancelForCustomer(
    id: number,
    customerId: number,
    reason: string,
  ): Promise<{ changed: boolean; warning?: string | undefined }>;
  /**
   * 到店（S4）：非本人单 → 403；**已经是 arrived → `changed:false`**（幂等）。
   *
   * 「已到位」刻意不报错：小程序双击 / 自动重试很常见，报 409 会让人以为失败了。
   * 其它非法起始状态（已取消 / 已完成）仍然报 409。
   *
   * `actorId` 允许为 null：小程序端没有后台账号，`updated_by` 记为 null 即可。
   */
  abstract arriveForStaff(
    id: number,
    staffId: number,
    actorId?: number | null,
  ): Promise<{ changed: boolean }>;
  /**
   * 完成（S4）：非本人单 → 403；早于 `start_at` → 400（§12.4-3，防提前刷提成）；
   * 已经是 completed → `changed:false`（幂等）。
   *
   * 必须走既有动作 service 的完成逻辑：提成计提、顾客到店次数累加、
   * `affectedRows` 幂等闸门都在里面 —— app 域**禁止**自己 UPDATE 预约状态。
   */
  abstract completeForStaff(
    id: number,
    staffId: number,
    actorId?: number | null,
  ): Promise<{ changed: boolean; warning?: string | undefined }>;
  /**
   * 某月的业绩概览（S3）：完成单量 + 实收合计。
   *
   * `period` 是 `yyyyMM`，按**店内时区**的 `finished_at` 划月 —— 不能让小程序端
   * 自己算月份边界，手机时区一变口径就漂。
   */
  /**
   * 按需取顾客真号（D11「默认脱敏 + 拨号按钮」的另一半）。
   *
   * 列表里**永远只给脱敏值**；真号要「点一次取一次」，且只能是本人单。
   * 这样截图 / 日志 / 抓包都拿不到批量号码，只有真正要拨号的那一瞬间才取一次，
   * 也就不需要在列表 VO 里同时塞明文和脱敏两个字段（那等于没脱敏）。
   */
  abstract phoneForStaff(
    id: number,
    staffId: number,
  ): Promise<{ phone: string | null }>;
  abstract performanceByStaff(
    staffId: number,
    /** 不传 = 当月（按**店内时区**算，不能让调用方自己定月份边界） */
    period?: string | undefined,
  ): Promise<{
    period: string;
    completedCount: number;
    /** 已完成预约的实收合计（分） */
    paidAmount: number;
  }>;
}

/* ------------------------------------------------------------------ *
 * 预约状态机定时任务（B1）
 * ------------------------------------------------------------------ */

export abstract class BookingOpsPort {
  /** `status='arrived'` 且 `end_at < now` → `completed`（幂等） */
  abstract autoCompleteExpired(): Promise<{ completed: number }>;
  /** `status='confirmed'` 且超过容忍期未到店 → `no_show`（幂等） */
  abstract autoNoShowExpired(): Promise<{ noShow: number }>;
}

/* ------------------------------------------------------------------ *
 * 提成（B4）
 * ------------------------------------------------------------------ */

export abstract class CommissionPort {
  /** 预约完成时计提（幂等：同一 booking_item 已计提则跳过） */
  abstract accrueForBooking(
    tx: BizTx,
    bookingId: number,
    actorId?: number | null,
  ): Promise<{ records: number; amount: number }>;
  /** 退款 / 取消时冲销该预约的计提 */
  abstract reverseForBooking(
    tx: BizTx,
    bookingId: number,
    reason: string,
    actorId?: number | null,
  ): Promise<{ reversed: number }>;
  /**
   * 美甲师本人的提成逐单明细（S3 业绩，D9：逐单全见）。
   *
   * `period` 为 `yyyyMM`，不传 = 全部；按 id 倒序，最多 `STAFF_COMMISSION_LIMIT` 条。
   */
  abstract listByStaff(
    staffId: number,
    period?: string | undefined,
  ): Promise<StaffCommissionItem[]>;
  /** 按状态汇总（卡片上的「待发 / 已发 / 已冲销」） */
  abstract summarizeByStaff(
    staffId: number,
    period?: string | undefined,
  ): Promise<{
    accrued: number;
    settled: number;
    reversed: number;
  }>;
}

/** 上限保护：单人单月不会太多，但「不传 period」时要有个兜底 */
export const STAFF_COMMISSION_LIMIT = 500;

export type StaffCommissionItem = {
  id: number;
  bookingId: number;
  bookingNo: string | null;
  serviceItemName: string | null;
  /** 计提基数（分） */
  baseAmount: number;
  /** 提成金额（分） */
  amount: number;
  period: string;
  status: 'accrued' | 'settled' | 'reversed';
  settledAt: Date | null;
};

/* ------------------------------------------------------------------ *
 * 退款（B3）：预约详情的「发起退款」入口走这里
 * ------------------------------------------------------------------ */

export type RefundPreview = {
  policyId: number | null;
  policyName: string | null;
  hoursBefore: number | null;
  refundPermille: number;
  paidAmount: number;
  suggestAmount: number;
  deductAmount: number;
  hoursToStart: number;
};

export abstract class RefundPort {
  abstract preview(input: {
    bookingId: number;
    cancelAt?: string | undefined;
  }): Promise<RefundPreview>;
  abstract apply(
    input: {
      bookingId?: number | undefined;
      paymentId?: number | undefined;
      amount?: number | undefined;
      mode: 'original' | 'cash' | 'balance';
      reason: string;
      liable?: 'store' | 'customer' | 'force_majeure' | undefined;
      remark?: string | undefined;
    },
    actorId: number,
  ): Promise<{
    id: number;
    refundNo: string;
    amount: number;
    actualAmount: number;
    status: string;
  }>;
  abstract approve(id: number, actorId: number): Promise<{ status: string }>;
  abstract reject(id: number, reason: string, actorId: number): Promise<void>;
  abstract list(
    page: number,
    pageSize: number,
    filter: {
      status?: string | undefined;
      mode?: string | undefined;
      dateFrom?: string | undefined;
      dateTo?: string | undefined;
    },
  ): Promise<PageResult<Record<string, unknown>>>;
}

/* ------------------------------------------------------------------ *
 * 评价（B5）：app 域只消费「本人」的评价（§20.1）
 * ------------------------------------------------------------------ */

export type StaffReviewItem = {
  id: number;
  bookingId: number;
  bookingNo: string | null;
  /** 1~5 */
  score: number;
  content: string | null;
  reply: string | null;
  createdAt: Date;
};

export abstract class ReviewPort {
  /** 本人评价（只出 `published`，隐藏的不给本人看以外的口径） */
  abstract listByStaff(
    staffId: number,
    page: number,
    pageSize: number,
  ): Promise<PageResult<StaffReviewItem>>;
  /** 平均评分（没有评价时 average=null，前端显示「暂无评分」而不是 0 分） */
  abstract averageScore(
    staffId: number,
  ): Promise<{ count: number; average: number | null }>;
  /**
   * C 端提交评价（A11）：**仅本人 + 仅已完成 + 一单一评**。
   *
   * `customerId` 由调用方从 token 对应的身份解析，端口内部**再校验一次归属**：
   * 评价要落 `biz_review.customer_id`，这个值必须由服务端按预约事实决定，
   * 不能有任何「客户端说是谁就是谁」的余地。`actorId` 传 null 表示无后台操作者（小程序自建）。
   */
  abstract createForCustomer(
    customerId: number,
    input: {
      bookingId: number;
      score: number;
      content?: string | undefined;
      images?: string[] | undefined;
    },
    actorId: number | null,
  ): Promise<{ id: number; createdAt: Date }>;
}

/* ------------------------------------------------------------------ *
 * 周期预约（B5）
 * ------------------------------------------------------------------ */

export abstract class RecurrencePort {
  /** 滚动生成（幂等：generated_until 游标 + (recurrence_id, start_at) 唯一约束） */
  abstract generate(
    recurrenceId?: number,
  ): Promise<{ generated: number; skipped: number }>;
}

export { type RecurrenceRow as RecurrenceRowType };

/**
 * 积分兑换品（顾客侧只读）。
 *
 * **为什么单独开一个端口、而不是让 app 直接拿 `PointsGoodsService`**：
 * app 域只允许依赖抽象端口（见 `biz.module.ts` 的说明），这样 app 侧天然拿不到
 * 成本字段与后台维护方法，符合 §8.3「不复用后台 DTO、不返回内部字段」。
 *
 * 这里**只声明读**：兑换（扣积分 + 发次卡）属于资金/权益写入，必须复用后台
 * `PointsGoodsService.redeem()` 的**同事务**实现，不能另写一套。
 */
export type PointsGoodsView = {
  id: number;
  name: string;
  points: number;
  /** -1 = 不限库存 */
  stock: number;
  /** 0 = 不限每人兑换次数 */
  perLimit: number;
  remark: string | null;
  /** 兑换后发放的卡种名（让顾客知道换到的到底是什么） */
  cardTypeName: string | null;
  /** 商品图（文件路径；未上传为 null） */
  image: string | null;
  /** 分类（自由文本；C 端筛选胶囊按它出） */
  category: string | null;
};

export abstract class PointsGoodsPort {
  abstract list(
    page: number,
    pageSize: number,
    filter?: {
      status?: 'active' | 'disabled';
      keyword?: string;
      category?: string;
    },
  ): Promise<{ items: PointsGoodsView[]; page: number; pageSize: number }>;

  /** C 端筛选胶囊的选项：**必须来自数据**，不能在前端硬编码一份分类清单 */
  abstract listCategories(): Promise<string[]>;

  /**
   * 兑换（§15.3）：**必须在后台现成的同事务实现里做**。
   *
   * 该方法内部依次完成：库存条件更新（`affectedRows=0` → 409 已兑完/已下架）
   * → 每人限兑校验 → **扣积分条件更新**（不足 → 409）→ 发次卡 →
   * 写 `biz_points_redeem` 与 `points_redeem` 流水。
   *
   * app 域**只做身份解析与转发**，绝不在这里重算积分或另写扣减 ——
   * 两套实现必然分叉（`money-invariants`：扣减一律条件更新，禁止读-算-写）。
   */
  abstract redeem(
    customerId: number,
    goodsId: number,
    actorId: number,
  ): Promise<{
    redeemId: number;
    redeemNo: string;
    transactionId: number;
    cardId: number;
    cardNo: string;
    points: number;
  }>;
}

/**
 * 顾客持有的优惠券（顾客侧只读视图）。
 *
 * **刻意不包含 `templateId` / `remark` / 审计字段** —— 这些都是内部信息，
 * §8.3 要求不出现在 app 侧响应里。放在端口类型上是为了让「不该出去的东西」
 * 在 app 域**根本拿不到**，而不是靠投影时记得删。
 */
export type CustomerCouponView = {
  id: number;
  couponNo: string;
  /** 券名（模板名）：可给顾客看；模板 id 不给 */
  templateName: string | null;
  /** 面额快照（分） */
  discountAmount: number;
  /** 门槛快照（分） */
  thresholdAmount: number;
  /** **现算**后的展示状态：usable 但已过期 → expired */
  displayStatus: 'usable' | 'used' | 'expired' | 'void';
  expireAt: Date | null;
  usedAt: Date | null;
};

export abstract class CouponPort {
  abstract listMine(
    customerId: number,
    filter?: 'usable' | 'used' | 'expired' | 'void' | 'all',
    page?: number,
    pageSize?: number,
  ): Promise<{ items: CustomerCouponView[]; page: number; pageSize: number }>;

  /**
   * 算价阶段取券面额（**只读，不核销**）。
   *
   * 券抵扣额是算价的输入，而核销需要 bookingId —— 两者互相依赖，
   * 所以建单处先用本方法拿面额算价，建单拿到 id 后再调 `redeemForBooking`。
   */
  /**
   * 传 BizTx 或非事务句柄都可以：它在**事务外**调用 —— 建单处明确要求
   * 「事务内第一条语句必须是 staff 行锁」，所以这里不能借用建单事务。
   */
  abstract previewForBooking(
    db: BizTx | BizDatabase,
    input: { couponId: number; customerId: number; baseAmount: number },
  ): Promise<{ couponNo: string; discountAmount: number }>;

  /** 可领取的券模板（排除已持有可用券的，避免同一张券反复领） */
  abstract listClaimable(customerId: number): Promise<
    {
      id: number;
      name: string;
      thresholdAmount: number;
      discountAmount: number;
      validDays: number;
      validTo: Date | null;
      remark: string | null;
    }[]
  >;

  /** 顾客自助领券（事务内锁模板行串行化，防同一张券领两张） */
  abstract claim(input: {
    customerId: number;
    templateId: number;
    actorId: number | null;
  }): Promise<{
    id: number;
    couponNo: string;
    discountAmount: number;
    thresholdAmount: number;
    expireAt: Date | null;
  }>;

  /**
   * 核销：把券绑到某一单上（**必须传入建单事务的 tx**）。
   *
   * 闸门是**条件更新**（`status='usable' AND used_booking_id IS NULL`），
   * `affectedRows = 0` 一律 409 —— 这是防「一券多用」唯一可靠的做法。
   */
  abstract redeemForBooking(
    tx: BizTx,
    input: {
      couponId: number;
      customerId: number;
      bookingId: number | null;
      /** 等级折扣之后的金额（分） */
      baseAmount: number;
      actorId?: number | null;
    },
  ): Promise<{ couponNo: string; discountAmount: number }>;
}
