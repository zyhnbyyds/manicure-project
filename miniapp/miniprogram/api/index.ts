/**
 * app 域接口调用层 —— **页面只依赖这里，不直接碰 `request()`**。
 *
 * ⚠️ 导入本模块必须写**显式文件路径** `'../api/index'`／`'../../api/index'`：
 * 小程序的模块解析**不支持目录导入**，`'../../api'` 会被编译成 `require('../../api')`
 * 并在运行时抛 `module 'api.js' is not defined`（已实测）。
 * 这一点与 Node/TS 的默认解析行为不同，新增页面时最容易踩。
 *
 * 每个方法的结构都一样：
 *   mock 开 → 返回演示数据；否则 → 打真实 `/api/v1/app/**`。
 * 两边的返回类型完全相同（`api/types.ts`），所以页面代码在切换时零改动。
 *
 * 后端当前状态（spec §9.7 + 施工单 A8/A9/A11/A12/A13/A10）：
 * - 真实现：login、auth/phone、service-items、staffs、available-slots、member/me、
 *   member/cards、reviews、subscribe、bookings(GET/POST)、bookings/:id/cancel、
 *   payments/wxpay/notify（渠道回调，靠验签、不带 token）
 * - 501 骨架：payments/wxpay/jsapi（JSAPI 支付契约位，JSAPI 下单在 P2 接通道）
 * 骨架接口在真接口模式下会抛「这个功能马上就来啦～」（`utils/request.ts` 里把 501 收敛了）。
 */
import { request } from '../utils/request';
import type {
  AvailableSlots,
  BindPhoneVo,
  Booking,
  BookingStatus,
  CreateBookingRequest,
  CreateReviewRequest,
  JsapiPayment,
  LoginRequest,
  LoginVo,
  MemberCard,
  MemberMe,
  Paged,
  ServiceItem,
  SettleBookingRequest,
  SettleBookingResult,
  Staff,
  StaffAction,
  StaffApplyVo,
  StaffBooking,
  StaffMe,
  StaffPerformance,
  StaffPhone,
  StaffReview,
  StaffSchedule,
  RechargePlan,
} from './types';

/** 演示数据只提示一次，避免每个请求都刷日志 */

/* ── 认证 ──────────────────────────────────────────────────── */

export const authApi = {
  login(payload: LoginRequest): Promise<LoginVo> {
    return request<LoginVo>({
      path: '/app/auth/login',
      method: 'POST',
      data: payload as unknown as Record<string, unknown>,
      auth: false,
    });
  },

  /** 手机号绑定。返回里带工作台候选与授权状态（候选 ≠ 已开通，要店长后台确认） */
  bindPhone(code: string): Promise<BindPhoneVo> {
    return request<BindPhoneVo>({
      path: '/app/auth/phone',
      method: 'POST',
      data: { code },
    });
  },
};

/* ── 目录 ──────────────────────────────────────────────────── */

export const catalogApi = {
  listServiceItems(page = 1, pageSize = 50): Promise<Paged<ServiceItem>> {
    return request<Paged<ServiceItem>>({
      path: '/app/service-items',
      data: { page, pageSize },
    });
  },

  listStaffs(): Promise<Paged<Staff>> {
    return request<Paged<Staff>>({ path: '/app/staffs' });
  },

  getAvailableSlots(input: {
    staffId: number;
    date: string;
    serviceItemIds: number[];
  }): Promise<AvailableSlots> {
    return request<AvailableSlots>({
      path: '/app/available-slots',
      data: {
        staffId: input.staffId,
        date: input.date,
        serviceItemIds: input.serviceItemIds,
      },
    });
  },
};

/* ── 会员 ──────────────────────────────────────────────────── */

export const memberApi = {
  getMe(): Promise<MemberMe> {
    return request<MemberMe>({ path: '/app/member/me' });
  },

  /**
   * 上架中的充值档位。
   *
   * 充值页必须用它：档位是**门店配置**，硬编码在前端必然与实际到账对不上。
   */
  rechargePlans(): Promise<{ items: RechargePlan[] }> {
    return request<{ items: RechargePlan[] }>({ path: '/app/recharge-plans' });
  },
  listCards(status?: MemberCard['status']): Promise<Paged<MemberCard>> {
    return request<Paged<MemberCard>>({
      path: '/app/member/cards',
      data: status ? { status } : undefined,
    });
  },
};

/* ── 预约 ──────────────────────────────────────────────────── */

export const bookingApi = {
  list(
    input: { status?: BookingStatus; page?: number; pageSize?: number } = {},
  ): Promise<Paged<Booking>> {
    return request<Paged<Booking>>({
      path: '/app/bookings',
      data: {
        status: input.status,
        page: input.page ?? 1,
        pageSize: input.pageSize ?? 20,
      },
    });
  },

  /**
   * 单笔预约详情（本人）。
   *
   * 支付页用它：① 按 id 直取（不再从列表前 50 条里 find，老单会查不到）；
   * ② **支付后轮询它确认** —— `payStatus`/`paidAmount` 是服务端事实。
   */
  detail(id: number): Promise<Booking> {
    return request<Booking>({ path: `/app/bookings/${id}` });
  },

  create(payload: CreateBookingRequest): Promise<Booking> {
    return request<Booking>({
      path: '/app/bookings',
      method: 'POST',
      data: payload as unknown as Record<string, unknown>,
    });
  },

  cancel(bookingId: number, reason?: string): Promise<Booking | null> {
    return request<Booking | null>({
      path: `/app/bookings/${bookingId}/cancel`,
      method: 'POST',
      data: { reason },
    });
  },

  /**
   * 自助结算（付尾款）。
   *
   * 只支持**不依赖任何支付通道**的渠道：`balance` 储值余额、`card` 次卡核销；
   * `pointsUsed` 是积分抵扣（不是通道 —— 有 `maxPointsPermille` 上限，盖不住全款）。
   *
   * ⚠️ 服务端有**合规闸门**（`APP_SELF_PAY_ENABLED`）：虚拟支付接入之前一律返回 501。
   * 所以页面必须先看 `/app/member/me` 的 `selfPayEnabled`，不要盲目放开按钮。
   */
  settle(
    bookingId: number,
    payload: SettleBookingRequest,
  ): Promise<SettleBookingResult> {
    return request<SettleBookingResult>({
      path: `/app/bookings/${bookingId}/settle`,
      method: 'POST',
      data: payload as unknown as Record<string, unknown>,
    });
  },

  createReview(payload: CreateReviewRequest): Promise<{ id: number }> {
    return request<{ id: number }>({
      path: '/app/reviews',
      method: 'POST',
      data: payload as unknown as Record<string, unknown>,
    });
  },

  /** 小程序内 JSAPI 支付：后端 501（P2 接通道），前端先把调用位留好 */
  createJsapiPayment(input: {
    bookingId: number;
    purpose: 'deposit' | 'final';
  }): Promise<JsapiPayment> {
    return request<JsapiPayment>({
      path: '/app/payments/wxpay/jsapi',
      method: 'POST',
      data: input as unknown as Record<string, unknown>,
    });
  },
};

/* ── 美甲师工作台（S3 只读 / S4 写）────────────────────────
 * 全部走 `/app/staff/**`：后端按 `AppStaffScopeGuard` 硬限定本人，
 * 前端**不传 staffId**（传了也没用，服务端不认），只传分页与过滤条件。
 * -------------------------------------------------------- */

export const staffApi = {
  apply(): Promise<StaffApplyVo> {
    return request<StaffApplyVo>({ path: '/app/staff/apply', method: 'POST' });
  },

  me(): Promise<StaffMe> {
    return request<StaffMe>({ path: '/app/staff/me' });
  },

  listBookings(
    input: {
      date?: string;
      status?: BookingStatus;
      page?: number;
      pageSize?: number;
    } = {},
  ): Promise<Paged<StaffBooking>> {
    return request<Paged<StaffBooking>>({
      path: '/app/staff/bookings',
      data: {
        date: input.date,
        status: input.status,
        page: input.page ?? 1,
        pageSize: input.pageSize ?? 20,
      },
    });
  },

  getSchedule(date: string): Promise<StaffSchedule> {
    return request<StaffSchedule>({
      path: '/app/staff/schedule',
      data: { date },
    });
  },

  getPerformance(period?: string): Promise<StaffPerformance> {
    return request<StaffPerformance>({
      path: '/app/staff/performance',
      data: period ? { period } : undefined,
    });
  },

  listReviews(page = 1, pageSize = 20): Promise<Paged<StaffReview>> {
    return request<Paged<StaffReview>>({
      path: '/app/staff/reviews',
      data: { page, pageSize },
    });
  },

  /** 按需取顾客真号（D11）：列表只给脱敏值，真号点拨号才取，且限本人单 */
  getBookingPhone(bookingId: number): Promise<StaffPhone> {
    return request<StaffPhone>({
      path: `/app/staff/bookings/${bookingId}/phone`,
    });
  },

  /** 标记顾客已到店；已在到店态返回 `changed:false`（幂等，不是失败） */
  markArrived(bookingId: number): Promise<StaffAction> {
    return request<StaffAction>({
      path: `/app/staff/bookings/${bookingId}/arrived`,
      method: 'POST',
    });
  },

  /** 标记服务完成（走后端既有完成动作：提成计提 + 到店次数 + 幂等闸门） */
  markCompleted(bookingId: number): Promise<StaffAction> {
    return request<StaffAction>({
      path: `/app/staff/bookings/${bookingId}/complete`,
      method: 'POST',
    });
  },
};

/* ── 积分兑换 ──────────────────────────────────────────────── */

/** 兑换品目录条目（与后端 `AppPointsGoodsVo` 一致：无后台备注、无成本） */
export interface PointsGoods {
  id: number;
  name: string;
  points: number;
  /** -1 = 不限库存 */
  stock: number;
  /** 0 = 不限每人兑换次数 */
  perLimit: number;
  /** 兑换后发放的卡种名 */
  cardTypeName: string | null;
}

/**
 * 积分兑换品目录。
 *
 * 后端 `GET /app/points-goods` **只要求 app token、不要求绑定手机号** ——
 * 这是非个人的目录信息，未绑定用户也能先看到「能换什么」，兑换那一步才需要身份。
 */
export const pointsApi = {
  listGoods(page = 1, pageSize = 50): Promise<Paged<PointsGoods>> {
    return request<Paged<PointsGoods>>({
      path: '/app/points-goods',
      data: { page, pageSize },
    });
  },

  /**
   * 兑换（**需要绑定手机号**）。
   *
   * 后端在**同一条事务**里完成「扣积分 → 发次卡 → 写兑换记录与流水」，
   * 所以这里只负责发一次请求；**不做任何本地扣分**（否则与服务端账实不符）。
   * 积分不足 / 已兑完 / 超限兑 → 409。
   */
  redeem(goodsId: number): Promise<PointsRedeemResult> {
    return request<PointsRedeemResult>({
      path: '/app/points/redeem',
      method: 'POST',
      data: { goodsId },
    });
  },
};

/** 兑换结果（与后端 `AppPointsRedeemVo` 一致） */
export interface PointsRedeemResult {
  redeemNo: string;
  /** 本次扣减的积分 */
  points: number;
  cardNo: string;
  cardId: number;
}
/* ── 我的优惠券 ────────────────────────────────────────────── */

/** 持有的券（与后端 `AppCustomerCouponVo` 一致：不含模板 id、不含后台备注） */
export interface CustomerCoupon {
  id: number;
  couponNo: string;
  /** 券名（模板名）；旧数据可能为 null */
  templateName: string | null;
  /** 面额（分） */
  discountAmount: number;
  /** 使用门槛（分）；0 = 无门槛 */
  thresholdAmount: number;
  /** **现算**后的状态：usable 但已过期这里就是 expired */
  status: 'usable' | 'used' | 'expired' | 'void';
  expireAt: string | null;
  usedAt: string | null;
}

/** 券状态筛选（不传 = all） */
export type CouponStatusFilter = CustomerCoupon['status'] | 'all';

/**
 * 我的优惠券。
 *
 * **需要绑定手机号**（券是个人权益）—— 未绑定时后端返回 401 + `needBind`，
 * 页面应先走 `requireSession` 引导，而不是把这个 401 显示成加载失败。
 */
/** 可领取的券（模板）：与后端 `AppCouponOfferVo` 一致 */
export interface CouponOffer {
  id: number;
  name: string;
  thresholdAmount: number;
  discountAmount: number;
  /** 0 = 用 validTo 的绝对区间 */
  validDays: number;
  validTo: string | null;
}

export const couponApi = {
  /** 可领取的券（**需要绑定手机号**）。已持有可用券的模板不会出现。 */
  listOffers(): Promise<{ items: CouponOffer[] }> {
    return request<{ items: CouponOffer[] }>({ path: '/app/coupon-offers' });
  },

  /**
   * 领券。
   *
   * 重复领会 409（服务端事务内锁模板行，并发也只会成功一次），
   * 所以这里**直接把后端的 message 转述**，不要自己编文案。
   */
  claim(templateId: number): Promise<CustomerCoupon> {
    return request<CustomerCoupon>({
      path: '/app/coupons/claim',
      method: 'POST',
      data: { templateId },
    });
  },

  listMine(
    status: CouponStatusFilter = 'all',
    page = 1,
    pageSize = 20,
  ): Promise<Paged<CustomerCoupon>> {
    return request<Paged<CustomerCoupon>>({
      path: '/app/coupons',
      data: { status, page, pageSize },
    });
  },
};
