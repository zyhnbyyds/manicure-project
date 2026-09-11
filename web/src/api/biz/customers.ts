import type { PageResult } from '~/types/api';
import { del, get, patch, post } from '~/request';
import type { BookingPayStatus, BookingStatus } from './bookings';

/** 顾客档案（biz_customer，兼会员档案，§9.4） */
export interface Customer {
  id: number;
  name: string;
  phone: string | null;
  gender: 'unknown' | 'male' | 'female';
  /** `YYYY-MM-DD` */
  birthday: string | null;
  remark: string | null;
  visitCount: number;
  lastVisitAt: string | null;
  levelId: number | null;
  memberNo: string | null;
  memberSince: string | null;
  /** 累计消费（分） */
  totalSpent: number;
  points: number;
  pointsTotal: number;
  /** 储值本金（分） */
  balancePrincipal: number;
  /** 储值赠送（分） */
  balanceBonus: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  createdBy: number | null;
  updatedBy: number | null;
}

export interface CreateCustomerBody {
  name: string;
  phone?: string | null;
  gender?: 'unknown' | 'male' | 'female';
  birthday?: string | null;
  remark?: string | null;
}

export type UpdateCustomerBody = Partial<CreateCustomerBody>;

export interface CustomerListQuery {
  /** 姓名 / 手机号 */
  keyword?: string;
  levelId?: number;
  hasBalance?: boolean;
  /** 档案状态：active（默认）/ deleted（已删除） */
  status?: 'active' | 'deleted';
}

/** 历史预约里的项目明细（快照） */
export interface CustomerBookingItem {
  serviceItemId: number;
  name: string;
  durationMinutes: number;
  price: number;
  sort: number;
}

/** 顾客历史预约（biz_booking + items） */
export interface CustomerBooking {
  id: number;
  bookingNo: string;
  staffId: number;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  originalPrice: number;
  levelDiscountAmount: number;
  pointsDiscountAmount: number;
  adjustAmount: number;
  payableAmount: number;
  depositAmount: number;
  paidAmount: number;
  dueAmount: number;
  payStatus: BookingPayStatus;
  status: BookingStatus;
  customerName: string;
  remark: string | null;
  items: CustomerBookingItem[];
}

/** 顾客列表（分页，响应无 total） */
export function listCustomers(
  page = 1,
  pageSize = 20,
  query: CustomerListQuery = {},
) {
  return get<PageResult<Customer>>('/biz/customers', {
    page,
    pageSize,
    ...query,
  });
}

/** 顾客详情 */
export function getCustomer(id: number) {
  return get<Customer>(`/biz/customers/${id}`);
}

/** 新增顾客（手机号重复时 409，message 原样提示） */
export function createCustomer(body: CreateCustomerBody) {
  return post<{ id: number }>('/biz/customers', body);
}

/** 修改顾客 */
export function updateCustomer(id: number, body: UpdateCustomerBody) {
  return patch<void>(`/biz/customers/${id}`, body);
}

/** 恢复已删除顾客（幂等） */
export function restoreCustomer(id: number) {
  return post<void>(`/biz/customers/${id}/restore`);
}

/** 删除顾客（软删；存在预约记录时 409） */
export function deleteCustomer(id: number) {
  return del<void>(`/biz/customers/${id}`);
}

/** 顾客历史预约（分页） */
export function listCustomerBookings(id: number, page = 1, pageSize = 20) {
  return get<PageResult<CustomerBooking>>(`/biz/customers/${id}/bookings`, {
    page,
    pageSize,
  });
}

/** 重算到店统计（对账修复，幂等） */
export function recountCustomer(id: number) {
  return post<{ visitCount: number; lastVisitAt: string | null }>(
    `/biz/customers/${id}/recount`,
  );
}
