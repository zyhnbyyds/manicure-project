/**
 * app 域接口的数据类型 —— **逐字段对齐后端 `src/modules/app/dto/app-vo.ts`**。
 *
 * 为什么手写而不是从后端生成：
 * 后端那套是 Zod + `.openapi()`，字段集合已冻结（验收项要求「字段集合断言」）。
 * 这里保持同名同义，是为了将来真要生成代码时能一一对应；
 * **不要在这里加后端没给的字段**（成本、内部备注等一律不进来）。
 */

export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
}

/* ── 认证 ──────────────────────────────────────────────────── */

export interface LoginRequest {
  code: string;
  nickname?: string;
  avatar?: string;
}

export interface LoginVo {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: string;
  /** `null` = 仅浏览（未授权手机号） */
  customerId: number | null;
}

/* ── 目录：项目 / 美甲师 / 可约时段 ────────────────────────── */

export interface ServiceItem {
  id: number;
  name: string;
  category: string | null;
  durationMinutes: number;
  /** 价格（分） */
  price: number;
  description: string | null;
  image: string | null;
}

export interface Staff {
  id: number;
  nickname: string;
  avatar: string | null;
  bio: string | null;
}

export interface SlotItem {
  startAt: string;
  endAt: string;
}

export type SlotReason =
  | 'off'
  | 'no_shift'
  | 'staff_cannot_do'
  | 'fully_booked'
  | 'out_of_window';

export interface AvailableSlots {
  slots: SlotItem[];
  reason?: SlotReason;
  durationMinutes: number;
  bufferMinutes: number;
}

/* ── 会员 ──────────────────────────────────────────────────── */

export type MemberCardStatus = 'active' | 'used_up' | 'expired' | 'refunded';

export interface MemberCard {
  id: number;
  cardNo: string;
  cardName: string;
  totalTimes: number;
  usedTimes: number;
  expireAt: string | null;
  status: MemberCardStatus;
}

export interface MemberMe {
  customerId: number;
  name: string;
  phone: string | null;
  levelName: string | null;
  /** 折扣率千分比；无等级 = 1000 */
  discountPermille: number;
  points: number;
  /** 储值本金（分） */
  balancePrincipal: number;
  /** 储值赠送（分） */
  balanceBonus: number;
  cards: MemberCard[];
}

/* ── 预约 / 评价 / 支付 ────────────────────────────────────── */

export type BookingStatus =
  | 'pending'
  | 'confirmed'
  | 'arrived'
  | 'completed'
  | 'cancelled'
  | 'no_show';

export type PayStatus = 'unpaid' | 'partial' | 'paid' | 'refunded' | 'credit';

export interface BookingItem {
  serviceItemId: number;
  name: string;
  price: number;
  durationMinutes: number;
}

export interface Booking {
  id: number;
  bookingNo: string;
  staffId: number;
  staffName: string | null;
  startAt: string;
  endAt: string;
  status: BookingStatus;
  payStatus: PayStatus;
  payableAmount: number;
  paidAmount: number;
  dueAmount: number;
  items: BookingItem[];
}

export interface CreateBookingRequest {
  staffId: number;
  startAt: string;
  serviceItemIds: number[];
  memberCardId?: number | null;
  pointsToUse?: number;
  remark?: string | null;
}

export interface CreateReviewRequest {
  bookingId: number;
  rating: number;
  content?: string;
  images?: string[];
}

export interface JsapiPayment {
  paymentNo: string;
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: 'RSA';
  paySign: string;
}

/* ── 下单前的本地草稿（跨页面传递，不落库）────────────────── */

export interface BookingDraft {
  items: ServiceItem[];
  /** 逗号分隔的项目 ID，直接作为接口参数 */
  serviceItemIds: number[];
  durationMinutes: number;
  originalAmount: number;
  staffId: number | null;
  staffName: string;
  staffAvatar: string | null;
  /** 店内本地日 `YYYY-MM-DD` */
  date: string;
  startAt: string;
  endAt: string;
}
