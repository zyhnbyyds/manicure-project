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
 * 本期后端的状态（spec §9.7）：
 * - 真实现：login、service-items、staffs、available-slots、member/me
 * - 501 骨架：auth/phone、bookings(GET/POST)、bookings/:id/cancel、member/cards、
 *   reviews、payments/wxpay/jsapi、subscribe
 * 骨架接口在真接口模式下会抛「这个功能马上就来啦～」（`utils/request.ts` 里把 501 收敛了）。
 */
import { isMockEnabled } from '../config';
import { request } from '../utils/request';
import {
  MOCK_CARDS,
  MOCK_MEMBER,
  MOCK_SERVICE_ITEMS,
  MOCK_STAFFS,
  MOCK_STAFF_ME,
  mockAvailableSlots,
  mockBindPhone,
  mockCancelBooking,
  mockCreateBooking,
  mockCreateReview,
  mockListBookings,
  mockLogin,
  mockStaffApply,
  mockStaffBookings,
  mockStaffPerformance,
  mockStaffReviews,
  mockStaffSchedule,
} from './mock';
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
  Staff,
  StaffAction,
  StaffApplyVo,
  StaffBooking,
  StaffMe,
  StaffPerformance,
  StaffPhone,
  StaffReview,
  StaffSchedule,
} from './types';

let mockWarned = false;

/** 演示数据只提示一次，避免每个请求都刷日志 */
function useMock(): boolean {
  const enabled = isMockEnabled();
  if (enabled && !mockWarned) {
    mockWarned = true;
    console.warn(
      '[manicure] 当前使用演示数据（config.isMockEnabled()=true）。' +
        '配置 WX_MINIAPP_APPID/SECRET 后把 config.ts 的默认值改为 false 即切真接口。',
    );
  }
  return enabled;
}

/* ── 认证 ──────────────────────────────────────────────────── */

export const authApi = {
  login(payload: LoginRequest): Promise<LoginVo> {
    if (useMock()) return Promise.resolve(mockLogin());
    return request<LoginVo>({
      path: '/app/auth/login',
      method: 'POST',
      data: payload as unknown as Record<string, unknown>,
      auth: false,
    });
  },

  /** 手机号绑定。返回里带工作台候选与授权状态（候选 ≠ 已开通，要店长后台确认） */
  bindPhone(code: string): Promise<BindPhoneVo> {
    if (useMock()) return Promise.resolve(mockBindPhone());
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
    if (useMock()) {
      return Promise.resolve({ items: MOCK_SERVICE_ITEMS, page, pageSize });
    }
    return request<Paged<ServiceItem>>({
      path: '/app/service-items',
      data: { page, pageSize },
    });
  },

  listStaffs(): Promise<Paged<Staff>> {
    if (useMock()) return Promise.resolve({ items: MOCK_STAFFS, page: 1, pageSize: 50 });
    return request<Paged<Staff>>({ path: '/app/staffs' });
  },

  getAvailableSlots(input: {
    staffId: number;
    date: string;
    serviceItemIds: number[];
  }): Promise<AvailableSlots> {
    if (useMock()) return Promise.resolve(mockAvailableSlots(input));
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
    if (useMock()) return Promise.resolve(MOCK_MEMBER);
    return request<MemberMe>({ path: '/app/member/me' });
  },

  listCards(status?: MemberCard['status']): Promise<Paged<MemberCard>> {
    if (useMock()) {
      const items = status ? MOCK_CARDS.filter((card) => card.status === status) : MOCK_CARDS;
      return Promise.resolve({ items, page: 1, pageSize: 50 });
    }
    return request<Paged<MemberCard>>({
      path: '/app/member/cards',
      data: status ? { status } : undefined,
    });
  },
};

/* ── 预约 ──────────────────────────────────────────────────── */

export const bookingApi = {
  list(input: { status?: BookingStatus; page?: number; pageSize?: number } = {}): Promise<
    Paged<Booking>
  > {
    if (useMock()) return Promise.resolve(mockListBookings(input));
    return request<Paged<Booking>>({
      path: '/app/bookings',
      data: {
        status: input.status,
        page: input.page ?? 1,
        pageSize: input.pageSize ?? 20,
      },
    });
  },

  create(payload: CreateBookingRequest): Promise<Booking> {
    if (useMock()) return Promise.resolve(mockCreateBooking(payload));
    return request<Booking>({
      path: '/app/bookings',
      method: 'POST',
      data: payload as unknown as Record<string, unknown>,
    });
  },

  cancel(bookingId: number, reason?: string): Promise<Booking | null> {
    if (useMock()) return Promise.resolve(mockCancelBooking(bookingId));
    return request<Booking | null>({
      path: `/app/bookings/${bookingId}/cancel`,
      method: 'POST',
      data: { reason },
    });
  },

  createReview(payload: CreateReviewRequest): Promise<{ id: number }> {
    if (useMock()) return Promise.resolve(mockCreateReview(payload));
    return request<{ id: number }>({
      path: '/app/reviews',
      method: 'POST',
      data: payload as unknown as Record<string, unknown>,
    });
  },

  /** 小程序内 JSAPI 支付：后端 501（P2 接通道），前端先把调用位留好 */
  createJsapiPayment(input: { bookingId: number; purpose: 'deposit' | 'final' }): Promise<JsapiPayment> {
    if (useMock()) {
      return Promise.reject(new Error('演示模式下不发起真实支付'));
    }
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
    if (useMock()) return Promise.resolve(mockStaffApply());
    return request<StaffApplyVo>({ path: '/app/staff/apply', method: 'POST' });
  },

  me(): Promise<StaffMe> {
    if (useMock()) return Promise.resolve(MOCK_STAFF_ME);
    return request<StaffMe>({ path: '/app/staff/me' });
  },

  listBookings(input: {
    date?: string;
    status?: BookingStatus;
    page?: number;
    pageSize?: number;
  } = {}): Promise<Paged<StaffBooking>> {
    if (useMock()) return Promise.resolve(mockStaffBookings(input));
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
    if (useMock()) return Promise.resolve(mockStaffSchedule(date));
    return request<StaffSchedule>({ path: '/app/staff/schedule', data: { date } });
  },

  getPerformance(period?: string): Promise<StaffPerformance> {
    if (useMock()) return Promise.resolve(mockStaffPerformance(period));
    return request<StaffPerformance>({
      path: '/app/staff/performance',
      data: period ? { period } : undefined,
    });
  },

  listReviews(page = 1, pageSize = 20): Promise<Paged<StaffReview>> {
    if (useMock()) return Promise.resolve(mockStaffReviews(page, pageSize));
    return request<Paged<StaffReview>>({
      path: '/app/staff/reviews',
      data: { page, pageSize },
    });
  },

  /** 按需取顾客真号（D11）：列表只给脱敏值，真号点拨号才取，且限本人单 */
  getBookingPhone(bookingId: number): Promise<StaffPhone> {
    if (useMock()) return Promise.resolve({ phone: '13800000002' });
    return request<StaffPhone>({
      path: `/app/staff/bookings/${bookingId}/phone`,
    });
  },

  /** 标记顾客已到店；已在到店态返回 `changed:false`（幂等，不是失败） */
  markArrived(bookingId: number): Promise<StaffAction> {
    if (useMock()) return Promise.resolve({ changed: true });
    return request<StaffAction>({
      path: `/app/staff/bookings/${bookingId}/arrived`,
      method: 'POST',
    });
  },

  /** 标记服务完成（走后端既有完成动作：提成计提 + 到店次数 + 幂等闸门） */
  markCompleted(bookingId: number): Promise<StaffAction> {
    if (useMock()) return Promise.resolve({ changed: true });
    return request<StaffAction>({
      path: `/app/staff/bookings/${bookingId}/complete`,
      method: 'POST',
    });
  },
};
