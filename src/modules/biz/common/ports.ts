/**
 * 跨模块调用端口（依赖倒置）。
 *
 * 各业务模块**只依赖本文件的抽象类**，不直接 import 别人的 service：
 * 具体实现由 `BizModule`（@Global）用 `useExisting` 绑定到这些 token 上。
 * 这样并行开发的模块之间没有编译期耦合，也不会出现循环依赖。
 *
 * 方法签名是冻结契约，见 `docs/superpowers/plans/2026-09-11-b1-b6-implementation-plan.md`。
 */
import type {
  bizBookingRecurrences,
  bizCreditAccounts,
  bizCustomers,
  bizMemberCards,
  bizReceivables,
  bizServiceItems,
  bizStaffs,
} from '../../../database/schema/index.js';
import type { BizTx } from './tx.js';

export type ServiceItemRow = typeof bizServiceItems.$inferSelect;
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
      image?: string | null;
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
}

/* ------------------------------------------------------------------ *
 * 收银（B3）
 * ------------------------------------------------------------------ */

export type PaymentDraft = {
  customerId: number;
  bookingId?: number | null | undefined;
  purpose: 'deposit' | 'final' | 'recharge' | 'card_buy' | 'credit_settle';
  channel: PayChannel;
  amount: number;
  receivedAmount?: number | undefined;
  memberCardId?: number | null | undefined;
  remark?: string | null | undefined;
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
  /** 同事务落支付单；在线渠道落 pending + code_url，线下/储值/次卡直接 success */
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
}

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
 * 周期预约（B5）
 * ------------------------------------------------------------------ */

export abstract class RecurrencePort {
  /** 滚动生成（幂等：generated_until 游标 + (recurrence_id, start_at) 唯一约束） */
  abstract generate(
    recurrenceId?: number,
  ): Promise<{ generated: number; skipped: number }>;
}

export { type RecurrenceRow as RecurrenceRowType };
