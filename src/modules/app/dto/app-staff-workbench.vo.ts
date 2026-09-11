/**
 * 美甲师工作台（S3/S4，施工单 §12.5）专用 Zod schema。
 *
 * 字段集合的铁律（§12.6）：**不含成本、不含其他美甲师数据**。
 * 顾客手机号一律脱敏（`138****0000`）——小程序端只负责拨号，不展示明文（D11）。
 */
import { z } from 'zod';
import { registerComponent } from '../../../common/swagger/zod-schema.helper.js';
import {
  appBookingItemVo,
  appBookingStatusSchema,
  appPayStatusSchema,
  isoDateTime,
} from './app-vo.js';

/** 店内本地日 `YYYY-MM-DD` */
const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ example: '2026-09-11', description: '店内本地日 YYYY-MM-DD' });

/** 脱敏手机号：`138****0000`；空值原样为 null */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  if (phone.length <= 7) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

const maskedPhone = z
  .string()
  .nullable()
  .openapi({ example: '138****0000', description: '脱敏手机号（可拨号）' });

export const appStaffMeVo = z.object({
  staffId: z.number().int().positive(),
  nickname: z.string(),
  avatar: z.string().nullable(),
  phone: maskedPhone,
  bio: z.string().nullable(),
  staffStatus: z.enum(['active']),
  /** 我可做的项目；null = 全部可做 */
  allowedServiceItemIds: z.array(z.number().int()).nullable(),
});
registerComponent('AppStaffMeVo', appStaffMeVo);
export type AppStaffMeVo = z.infer<typeof appStaffMeVo>;

export const appStaffBookingVo = z.object({
  id: z.number().int(),
  bookingNo: z.string(),
  customerName: z.string(),
  customerPhoneMasked: maskedPhone,
  startAt: isoDateTime,
  endAt: isoDateTime,
  status: appBookingStatusSchema,
  payStatus: appPayStatusSchema,
  payableAmount: z.number().int(),
  paidAmount: z.number().int(),
  dueAmount: z.number().int(),
  remark: z.string().nullable(),
  items: z.array(appBookingItemVo),
});
registerComponent('AppStaffBookingVo', appStaffBookingVo);
export type AppStaffBookingVo = z.infer<typeof appStaffBookingVo>;

export const appStaffBookingListVo = z.object({
  items: z.array(appStaffBookingVo),
  page: z.number().int(),
  pageSize: z.number().int(),
});
registerComponent('AppStaffBookingListVo', appStaffBookingListVo);

export const appStaffScheduleVo = z.object({
  date: localDate,
  off: z.boolean().openapi({ description: 'true = 当天休息，不排班' }),
  segments: z
    .array(z.object({ startTime: z.string(), endTime: z.string() }))
    .openapi({ description: '生效班次（HH:mm）' }),
  overrides: z.array(
    z.object({
      id: z.number().int(),
      date: localDate,
      type: z.enum(['off', 'custom']),
      startTime: z.string().nullable(),
      endTime: z.string().nullable(),
      reason: z.string().nullable(),
    }),
  ),
});
registerComponent('AppStaffScheduleVo', appStaffScheduleVo);
export type AppStaffScheduleVo = z.infer<typeof appStaffScheduleVo>;

export const appStaffCommissionItemVo = z.object({
  id: z.number().int(),
  bookingId: z.number().int(),
  bookingNo: z.string().nullable(),
  serviceItemName: z.string().nullable(),
  baseAmount: z.number().int().openapi({ description: '计提基数（分）' }),
  amount: z.number().int().openapi({ description: '提成金额（分）' }),
  period: z.string().openapi({ example: '202609' }),
  status: z.enum(['accrued', 'settled', 'reversed']),
  settledAt: isoDateTime.nullable(),
});
registerComponent('AppStaffCommissionItemVo', appStaffCommissionItemVo);

export const appStaffPerformanceVo = z.object({
  period: z.string().openapi({ example: '202609' }),
  completedCount: z.number().int().openapi({ description: '完成单量' }),
  /** 已完成预约的实收合计（分） */
  paidAmount: z.number().int(),
  commission: z.object({
    accrued: z.number().int().openapi({ description: '待结算（分）' }),
    settled: z.number().int().openapi({ description: '已结算（分）' }),
    reversed: z.number().int().openapi({ description: '已冲销（分）' }),
  }),
  rating: z.object({
    count: z.number().int(),
    average: z
      .number()
      .nullable()
      .openapi({ description: '平均评分；无评价时为 null（不是 0）' }),
  }),
  /** 逐单明细全见（D9）；按 id 倒序，最多 500 条 */
  items: z.array(appStaffCommissionItemVo),
});
registerComponent('AppStaffPerformanceVo', appStaffPerformanceVo);
export type AppStaffPerformanceVo = z.infer<typeof appStaffPerformanceVo>;

export const appStaffReviewVo = z.object({
  id: z.number().int(),
  bookingId: z.number().int(),
  bookingNo: z.string().nullable(),
  score: z.number().int().min(1).max(5),
  content: z.string().nullable(),
  reply: z.string().nullable(),
  createdAt: isoDateTime,
});
registerComponent('AppStaffReviewVo', appStaffReviewVo);

export const appStaffReviewListVo = z.object({
  items: z.array(appStaffReviewVo),
  page: z.number().int(),
  pageSize: z.number().int(),
});
registerComponent('AppStaffReviewListVo', appStaffReviewListVo);

/** `POST /app/staff/bookings/:id/arrived|complete` 的响应 */
export const appStaffActionVo = z.object({
  changed: z.boolean().openapi({ description: 'false = 已是目标状态（幂等）' }),
  warning: z.string().nullable().optional(),
});
registerComponent('AppStaffActionVo', appStaffActionVo);
