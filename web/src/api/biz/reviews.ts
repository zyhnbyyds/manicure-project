import type { PageResult } from '~/types/api';
import { del, get, patch, post } from '~/request';

export type ReviewStatus = 'published' | 'hidden';

/** 服务评价（`biz_review`，一单一评） */
export interface Review {
  id: number;
  bookingId: number;
  /** 预约单号（关联查询返回，可选） */
  bookingNo?: string | null;
  customerId: number;
  customerName?: string | null;
  staffId: number;
  staffName?: string | null;
  /** 1..5 */
  score: number;
  content: string | null;
  images: string[] | null;
  isPublic: boolean;
  reply: string | null;
  repliedAt: string | null;
  status: ReviewStatus;
  createdAt: string;
  updatedAt: string;
}

/** 列表查询（用 type 而非 interface：对象字面量类型才能满足 request 的 Record 约束） */
export type ReviewListQuery = {
  staffId?: number | string;
  score?: number | string;
  status?: ReviewStatus | '';
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
};

/** 后台代录（仍受「一单一评」约束，重复提交后端返回 409） */
export interface CreateReviewBody {
  bookingId: number;
  /** 1..5 */
  score: number;
  content?: string;
  images?: string[];
}

/** 评价列表（分页） */
export function listReviews(params: ReviewListQuery = {}) {
  return get<PageResult<Review>>('/biz/reviews', params);
}

/** 后台代录评价 */
export function createReview(body: CreateReviewBody) {
  return post<{ id: number }>('/biz/reviews', body);
}

/** 店家回复 */
export function replyReview(id: number, reply: string) {
  return post<void>(`/biz/reviews/${id}/reply`, { reply });
}

/** 隐藏 / 公开切换（权限点 biz:review:hide） */
export function updateReview(
  id: number,
  body: { status?: ReviewStatus; isPublic?: boolean },
) {
  return patch<void>(`/biz/reviews/${id}`, body);
}

/** 软删 */
export function deleteReview(id: number) {
  return del<void>(`/biz/reviews/${id}`);
}

/** 已完成预约选项（代录时选择，取前 200 条） */
export interface CompletedBookingOption {
  id: number;
  bookingNo: string;
  customerName: string;
  startAt: string;
}

export function listCompletedBookings(keyword?: string) {
  return get<PageResult<CompletedBookingOption>>('/biz/bookings', {
    page: 1,
    pageSize: 200,
    status: 'completed',
    keyword,
  });
}

/** 美甲师下拉选项 */
export interface StaffOption {
  id: number;
  nickname: string;
  status: string;
}

export function listStaffOptions() {
  return get<PageResult<StaffOption>>('/biz/staffs', {
    page: 1,
    pageSize: 200,
    status: 'active',
  });
}
