import type { PageResult } from '~/types/api';
import request, { del, get, post } from '~/request';

/**
 * 预约主链路（§9.5）。
 *
 * 创建 / 改期的 409 有两类（§6.4 / §9.5）：
 * 1. 美甲师时段被占（硬拦，重新选时段）；
 * 2. 顾客同时段已有预约（软拦，带 `force=true` 可覆盖）。
 * 两者都会丢掉响应体里的 `conflicts`（拦截器只弹 message），所以这两个接口
 * 自行放行 409，把 message + 清单交回页面判断。
 */

/** 服务状态机（§7.1） */
export type BookingStatus =
  | 'pending'
  | 'confirmed'
  | 'arrived'
  | 'completed'
  | 'cancelled'
  | 'no_show';

/** 资金状态机（§7.4） */
export type BookingPayStatus =
  | 'unpaid'
  | 'partial'
  | 'paid'
  | 'refunded'
  | 'credit';

/** 支付渠道（后端 PayChannel 全量枚举，禁止前端自造字符串） */
export type PayChannel =
  | 'wxpay_native'
  | 'alipay_qr'
  | 'cash'
  | 'wechat_offline'
  | 'alipay_offline'
  | 'balance'
  | 'card'
  | 'credit';

/** 预约单（列表行 = biz_booking + 联查的 staffName） */
export interface Booking {
  id: number;
  bookingNo: string;
  customerId: number;
  staffId: number;
  /** 联查返回的美甲师昵称 */
  staffName: string | null;
  /** UTC 时刻，展示时转东八区 */
  startAt: string;
  endAt: string;
  durationMinutes: number;
  bufferMinutes: number;
  originalPrice: number;
  levelDiscountPermille: number;
  levelDiscountAmount: number;
  pointsDiscountAmount: number;
  adjustAmount: number;
  adjustReason: string | null;
  payableAmount: number;
  depositAmount: number;
  paidAmount: number;
  dueAmount: number;
  payStatus: BookingPayStatus;
  payChannelSummary: string | null;
  settledAt: string | null;
  creditAccountId: number | null;
  recurrenceId: number | null;
  memberCardId: number | null;
  refundAmount: number;
  refundedAt: string | null;
  status: BookingStatus;
  channel: 'admin' | 'miniapp';
  customerName: string;
  customerPhone: string | null;
  remark: string | null;
  cancelReason: string | null;
  confirmedAt: string | null;
  arrivedAt: string | null;
  finishedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  createdBy: number | null;
  updatedBy: number | null;
}

/** 预约项目明细（快照） */
export interface BookingItem {
  id: number;
  bookingId: number;
  serviceItemId: number;
  name: string;
  durationMinutes: number;
  price: number;
  sort: number;
}

/** 预约关联的支付单 */
export interface BookingPayment {
  id: number;
  paymentNo: string;
  outTradeNo: string;
  bookingId: number | null;
  customerId: number;
  purpose: 'deposit' | 'final' | 'recharge' | 'card_buy' | 'credit_settle';
  channel: PayChannel;
  amount: number;
  receivedAmount: number;
  status:
    | 'pending'
    | 'success'
    | 'failed'
    | 'closed'
    | 'refunded'
    | 'partial_refunded';
  codeUrl: string | null;
  transactionId: string | null;
  paidAt: string | null;
  expireAt: string | null;
  refundedAmount: number;
  remark: string | null;
  createdAt: string;
}

/** 预约详情（含项目明细与支付单） */
export interface BookingDetail extends Booking {
  items: BookingItem[];
  payments: BookingPayment[];
}

/** 409 响应体里的受影响预约 */
export interface BookingConflictItem {
  id: number;
  bookingNo: string;
  startAt: string;
  endAt: string;
}

/** 冲突感知的结果：`ok=false` 表示 409 */
export type BookingSaveOutcome<TData> =
  | { ok: true; data: TData }
  | { ok: false; message: string; conflicts: BookingConflictItem[] };

/* ------------------------------------------------------------------ *
 * 可约时段（§5.1）
 * ------------------------------------------------------------------ */

export interface AvailableSlot {
  /** 带 `+08:00` 偏移的 ISO8601，展示只取 `HH:mm` */
  startAt: string;
  endAt: string;
}

export type SlotReason =
  | 'off'
  | 'no_shift'
  | 'staff_cannot_do'
  | 'fully_booked'
  | 'out_of_window';

export interface SlotResult {
  slots: AvailableSlot[];
  /** 空 slots 时才有值；前端必须按原因给不同提示（§5.1） */
  reason?: SlotReason;
  durationMinutes: number;
  bufferMinutes: number;
}

export interface SlotQuery {
  staffId: number;
  /** 店内本地日 `YYYY-MM-DD` */
  date: string;
  serviceItemIds: number[];
}

/** 顾客账务摘要（创建弹窗展示等级 / 折扣 / 余额） */
export interface BookingCustomerBrief {
  id: number;
  name: string;
  phone: string | null;
  levelId: number | null;
  levelName: string | null;
  /** 等级折扣率千分比，1000 = 不打折 */
  discountPermille: number | null;
  points: number;
  balancePrincipal: number;
  balanceBonus: number;
}

/* ------------------------------------------------------------------ *
 * 请求体
 * ------------------------------------------------------------------ */

export interface PaymentInput {
  channel: PayChannel;
  /** 金额（分） */
  amount: number;
  /** 实收（分），现金找零时可小于 amount */
  receivedAmount?: number;
  /** `channel=card` 时必填 */
  memberCardId?: number;
}

export interface CreateBookingBody {
  customerId: number;
  staffId: number;
  /** 期望开始时间，带偏移的 ISO8601（服务端有权拒绝） */
  startAt: string;
  serviceItemIds: number[];
  payMode: 'full' | 'deposit';
  /** 定金金额（分）；不传则按 `biz.booking.depositPermille` 计算 */
  depositAmount?: number;
  payments?: PaymentInput[];
  pointsUsed?: number;
  adjustAmount?: number;
  adjustReason?: string;
  creditAccountId?: number;
  remark?: string;
  /** 顾客同时段已有预约时是否强制创建 */
  force?: boolean;
}

export interface UpdateBookingBody {
  staffId?: number;
  startAt?: string;
  serviceItemIds?: number[];
  adjustAmount?: number;
  adjustReason?: string;
  remark?: string;
  force?: boolean;
}

export interface SettleBookingBody {
  payments?: PaymentInput[];
  /** 结算时只能增加积分抵扣（减少需走冲正） */
  pointsUsed?: number;
  creditAccountId?: number;
  remark?: string;
}

export interface BookingListQuery {
  /** 店内本地日；与 dateFrom/dateTo 互斥，优先 date */
  date?: string;
  dateFrom?: string;
  dateTo?: string;
  staffId?: number;
  status?: BookingStatus;
  payStatus?: BookingPayStatus;
  customerId?: number;
  /** 单号 / 顾客姓名 / 手机号 */
  keyword?: string;
}

/** 支付单落库结果（创建 / 结算返回） */
export interface PaymentOutcome {
  paymentId: number;
  paymentNo: string;
  outTradeNo: string;
  status: 'pending' | 'success';
  channel: PayChannel;
  amount: number;
  receivedAmount: number;
  codeUrl?: string | null;
  expireAt?: string | null;
}

/** 创建预约的返回（§9.5 响应草案） */
export interface BookingCreateResult {
  id: number;
  bookingNo: string;
  startAt: string;
  endAt: string;
  status: BookingStatus;
  durationMinutes: number;
  bufferMinutes: number;
  originalPrice: number;
  levelDiscountAmount: number;
  pointsDiscountAmount: number;
  pointsUsed: number;
  adjustAmount: number;
  payableAmount: number;
  depositAmount: number;
  paidAmount: number;
  dueAmount: number;
  payStatus: BookingPayStatus;
  payChannelSummary: string | null;
  payments: PaymentOutcome[];
}

/** 资金重算结果（`BookingSettlementService.recalc`） */
export interface SettlementResult {
  paidAmount: number;
  dueAmount: number;
  refundAmount: number;
  payStatus: BookingPayStatus;
  channelSummary: string | null;
  settledAt: string | null;
}

/** 结算返回 */
export interface BookingSettleResult extends SettlementResult {
  payableAmount: number;
  payments: PaymentOutcome[];
}

/** 改期返回 */
export interface BookingUpdateResult extends SettlementResult {
  payableAmount: number;
  /** 已收 > 新应付时的提示（差额走退款单，不做差额补收） */
  warning?: string;
}

/* ------------------------------------------------------------------ *
 * 退款（§17.4：申请与审批分离，本页只负责「申请」）
 * ------------------------------------------------------------------ */

export type RefundMode = 'original' | 'cash' | 'balance';
export type RefundLiable = 'store' | 'customer' | 'force_majeure';

export interface RefundablePayment {
  paymentId: number;
  paymentNo: string;
  channel: string;
  amount: number;
  refundedAmount: number;
  refundableAmount: number;
}

/** 退款阶段：服务开始前无理由全额退；服务中由店长手动判断 */
export type RefundStage = 'before_start' | 'in_service';

/** 退款试算（只读）：阶段决定金额怎么来 */
export interface RefundPreview {
  bookingId: number;
  bookingNo: string;
  startAt: string;
  cancelAt: string;
  /** 距预约开始的小时数（可为负 = 已过开始时间） */
  hoursToStart: number;
  /** 退款阶段 */
  stage: RefundStage;
  /** 阶段展示名（服务开始前 / 服务中） */
  stageLabel: string;
  liable: RefundLiable;
  policyId: number | null;
  policyName: string | null;
  hoursBefore: number | null;
  /** 规则参考比例（不再决定实际退款额） */
  refundPermille: number;
  paidAmount: number;
  refundedAmount: number;
  refundableAmount: number;
  /** 建议退款额：服务开始前 = 剩余可退全额；服务中 = 0（须手动填） */
  suggestAmount: number;
  /** 金额是否锁定（服务开始前 = true） */
  lockedAmount: boolean;
  /** 规则参考金额（仅供比对） */
  policySuggestAmount: number;
  deductAmount: number;
  payments: RefundablePayment[];
}

export interface ApplyRefundBody {
  /** 退款金额（分）：服务开始前忽略（强制全额）；服务中为店长手动填写的金额 */
  amount?: number;
  mode: RefundMode;
  reason: string;
  liable?: RefundLiable;
  remark?: string;
}

/** 退款单（新流程发起即执行，status 通常已是 success） */
export interface RefundApplyResult {
  id: number;
  refundNo: string;
  amount: number;
  actualAmount: number;
  deductAmount: number;
  mode: RefundMode;
  liable: RefundLiable;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'success' | 'failed';
  /** 退款阶段；历史单为 null */
  refundStage: RefundStage | null;
  /** true = 本次发起已直接执行完成 */
  executed: boolean;
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/** 放行 409，让冲突清单能被读到（其它状态码仍走统一错误处理） */
function acceptConflict(status: number): boolean {
  return (status >= 200 && status < 300) || status === 409;
}

function readMessage(data: unknown, fallback: string): string {
  if (typeof data === 'string' && data) return data;
  if (data && typeof data === 'object') {
    const message = (data as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
    if (Array.isArray(message)) {
      const joined = message
        .filter((item): item is string => typeof item === 'string')
        .join('；');
      if (joined) return joined;
    }
  }
  return fallback;
}

function readConflicts(data: unknown): BookingConflictItem[] {
  if (!data || typeof data !== 'object') return [];
  const conflicts = (data as { conflicts?: unknown }).conflicts;
  return Array.isArray(conflicts) ? (conflicts as BookingConflictItem[]) : [];
}

/* ------------------------------------------------------------------ *
 * 接口
 * ------------------------------------------------------------------ */

/** 可约时段（店内本地日 + 美甲师 + 项目集合） */
export function availableSlots(query: SlotQuery) {
  return get<SlotResult>('/biz/bookings/available-slots', {
    staffId: query.staffId,
    date: query.date,
    serviceItemIds: query.serviceItemIds.join(','),
    channel: 'admin',
  });
}

/** 预约列表（分页，响应无 total） */
export function listBookings(
  page = 1,
  pageSize = 20,
  query: BookingListQuery = {},
) {
  return get<PageResult<Booking>>('/biz/bookings', {
    page,
    pageSize,
    ...query,
  });
}

/** 顾客账务摘要（创建弹窗用） */
export function getBookingCustomerBrief(customerId: number) {
  return get<BookingCustomerBrief>(
    `/biz/bookings/customers/${customerId}/brief`,
  );
}

/** 预约详情（含项目明细与支付单） */
export function getBooking(id: number) {
  return get<BookingDetail>(`/biz/bookings/${id}`);
}

/** 创建预约（建单 + 收定/全款，同一事务）；409 时返回冲突清单 */
export async function createBooking(
  body: CreateBookingBody,
): Promise<BookingSaveOutcome<BookingCreateResult>> {
  const response = await request.post('/biz/bookings', body, {
    validateStatus: acceptConflict,
  });
  if (response.status === 409) {
    return {
      ok: false,
      message: readMessage(response.data, '创建失败：时段已被占用'),
      conflicts: readConflicts(response.data),
    };
  }
  return { ok: true, data: response.data as BookingCreateResult };
}

/** 改期 / 改美甲师 / 改项目；409 时返回冲突清单 */
export async function updateBooking(
  id: number,
  body: UpdateBookingBody,
): Promise<BookingSaveOutcome<BookingUpdateResult>> {
  const response = await request.patch(`/biz/bookings/${id}`, body, {
    validateStatus: acceptConflict,
  });
  if (response.status === 409) {
    return {
      ok: false,
      message: readMessage(response.data, '改期失败：时段已被占用'),
      conflicts: readConflicts(response.data),
    };
  }
  return { ok: true, data: response.data as BookingUpdateResult };
}

/** 确认预约（pending → confirmed） */
export function confirmBooking(id: number) {
  return post<{ changed: boolean }>(`/biz/bookings/${id}/confirm`);
}

/** 顾客到店（confirmed → arrived） */
export function arriveBooking(id: number) {
  return post<{ changed: boolean }>(`/biz/bookings/${id}/arrive`);
}

/** 服务完成（arrived → completed，累加到店统计并计提提成） */
export function completeBooking(id: number) {
  return post<{ changed: boolean }>(`/biz/bookings/${id}/complete`);
}

/** 标记爽约（confirmed → no_show，原因必填） */
export function noShowBooking(id: number, reason: string) {
  return post<{ noShow: number }>(`/biz/bookings/${id}/no-show`, { reason });
}

/** 取消预约（原因必填；有实收时后端提示走退款流程） */
export function cancelBooking(id: number, reason: string) {
  return post<{ changed: boolean }>(`/biz/bookings/${id}/cancel`, { reason });
}

/** 结算尾款 / 挂账 / 补收（支持混合支付） */
export function settleBooking(id: number, body: SettleBookingBody) {
  return post<BookingSettleResult>(`/biz/bookings/${id}/settle`, body);
}

/** 退款试算（判定服务阶段 + 建议金额） */
export function previewBookingRefund(id: number) {
  return get<RefundPreview>(`/biz/bookings/${id}/refund-preview`);
}

/** 发起退款（建单后直接执行：服务开始前无需审批，服务中仅店长可发） */
export function applyBookingRefund(id: number, body: ApplyRefundBody) {
  return post<RefundApplyResult>(`/biz/bookings/${id}/refund`, body);
}

/** 对账修复：重算时长 / 结束时间与资金字段 */
export function recountBooking(id: number) {
  return post<{ changed: boolean }>(`/biz/bookings/${id}/recount`);
}

/** 软删（仅误录清理；有实收时后端 409 要求先退款） */
export function deleteBooking(id: number) {
  return del<void>(`/biz/bookings/${id}`);
}
