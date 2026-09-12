/**
 * 小程序端（`/api/v1/app/**`）专用 Zod schema（请求 + 响应）。
 *
 * 三条铁律（spec §8.3 / §16.3）：
 * 1. **禁止复用后台 DTO / VO**：app 域字段集合在这里独立定义，只暴露 C 端需要的字段；
 * 2. 每个 schema 都 `registerComponent`，Swagger 中以 `#/components/schemas/App*` 引用；
 * 3. 响应字段**逐个显式列举**：不含 `cost` / `remark` / `createdBy` / `status` / `sort` /
 *    `bufferMinutes` / 其他顾客信息等内部字段（验收项：字段集合断言）。
 *
 * 命名约定：`appXxxSchema` + `AppXxxVo`（响应）/ `AppXxxRequest`（请求）。
 */
import { z } from 'zod';
import { registerComponent } from '../../../common/swagger/zod-schema.helper.js';

/* ------------------------------------------------------------------ *
 * 通用
 * ------------------------------------------------------------------ */

/** 店内本地日 `YYYY-MM-DD`（绝不用 `new Date('YYYY-MM-DD')` 解析） */
const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ example: '2026-09-11', description: '店内本地日 YYYY-MM-DD' });

/** 带时区偏移的 ISO8601 时刻（UTC 存储，展示口径 +08:00） */
export const isoDateTime = z.string().openapi({
  example: '2026-09-11T10:00:00+08:00',
  description: '带偏移的 ISO8601 时刻',
});

export const appListQuerySchema = z.object({
  page: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .openapi({ example: 1, description: '页码' }),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .openapi({ example: 20, description: '每页条数' }),
});
registerComponent('AppListQuery', appListQuerySchema);
export type AppListQuery = z.infer<typeof appListQuerySchema>;

/* ------------------------------------------------------------------ *
 * 认证（auth）
 * ------------------------------------------------------------------ */

export const appLoginRequestSchema = z.object({
  code: z.string().min(1).max(200).openapi({
    example: '081Kf3Ga1abcDE0',
    description: 'wx.login 返回的 code',
  }),
  nickname: z
    .string()
    .min(1)
    .max(50)
    .optional()
    .openapi({ example: '小美', description: '微信昵称（可选，授权时快照）' }),
  avatar: z.string().min(1).max(500).optional().openapi({
    example: 'https://thirdwx.qlogo.cn/xxx',
    description: '微信头像（可选）',
  }),
});
registerComponent('AppLoginRequest', appLoginRequestSchema);
export type AppLoginRequest = z.infer<typeof appLoginRequestSchema>;

/** 登录响应：只回 token 与绑定状态，不回任何后台身份信息 */
export const appLoginVo = z.object({
  accessToken: z
    .string()
    .openapi({ description: 'app 域 access token（payload 含 scope=app）' }),
  tokenType: z.literal('Bearer'),
  expiresIn: z.string().openapi({ example: '15m', description: '有效期' }),
  customerId: z.number().int().nullable().openapi({
    example: null,
    description: '已绑定的顾客 ID；null = 仅浏览（未授权手机号）',
  }),
  staffId: z.number().int().nullable().openapi({
    example: null,
    description: '已绑定的美甲师 ID；null = 非美甲师',
  }),
  staffStatus: z
    .enum(['none', 'pending', 'active', 'rejected'])
    .openapi({ description: '美甲师工作台授权状态；只有 active 能进工作台' }),
});
registerComponent('AppLoginVo', appLoginVo);
export type AppLoginVo = z.infer<typeof appLoginVo>;

export const appBindPhoneRequestSchema = z.object({
  code: z.string().min(1).max(200).openapi({
    example: 'e31x2abc',
    description: 'getPhoneNumber 返回的 code',
  }),
});
registerComponent('AppBindPhoneRequest', appBindPhoneRequestSchema);
export type AppBindPhoneRequest = z.infer<typeof appBindPhoneRequestSchema>;

/**
 * 手机号绑定响应。
 *
 * `staffCandidate` 只表示「手机号命中了这位美甲师的档案」，**不代表已开通工作台**：
 * 按既定策略必须由店长在后台确认（仅凭手机号提权等于提权漏洞，见 `app_wx_user` 表注释）。
 */
export const appBindPhoneVo = z.object({
  customerId: z.number().int(),
  created: z.boolean().openapi({ description: '本次是否新建了顾客档案' }),
  staffId: z.number().int().nullable(),
  staffStatus: z.enum(['none', 'pending', 'active', 'rejected']),
  staffCandidate: z
    .object({ id: z.number().int(), nickname: z.string() })
    .nullable()
    .openapi({ description: '命中的美甲师档案（仅候选，需店长后台确认）' }),
});
registerComponent('AppBindPhoneVo', appBindPhoneVo);
export type AppBindPhoneVo = z.infer<typeof appBindPhoneVo>;

/** 美甲师工作台申请：不接受任何客户端身份字段，当前身份全部从 token + 数据库推导。 */
export const appStaffApplyRequestSchema = z.object({});
registerComponent('AppStaffApplyRequest', appStaffApplyRequestSchema);
export type AppStaffApplyRequest = z.infer<typeof appStaffApplyRequestSchema>;

export const appStaffApplyVo = z.object({
  staffId: z.number().int().positive(),
  staffStatus: z.enum(['pending', 'active']),
  staffRequestedAt: isoDateTime.nullable(),
});
registerComponent('AppStaffApplyVo', appStaffApplyVo);
export type AppStaffApplyVo = z.infer<typeof appStaffApplyVo>;

/* ------------------------------------------------------------------ *
 * 目录（catalog）：服务项目 / 美甲师 / 可约时段
 * ------------------------------------------------------------------ */

/** 字段集合冻结：id/name/category/durationMinutes/price/description/image —— 无成本、无备注、无状态 */
export const appServiceItemVo = z.object({
  id: z.number().int(),
  name: z.string(),
  category: z.string().nullable(),
  durationMinutes: z.number().int(),
  price: z.number().int().openapi({ description: '价格（分）' }),
  description: z.string().nullable(),
  image: z.string().nullable(),
});
registerComponent('AppServiceItemVo', appServiceItemVo);
export type AppServiceItemVo = z.infer<typeof appServiceItemVo>;

export const appServiceItemListVo = z.object({
  items: z.array(appServiceItemVo),
  page: z.number().int(),
  pageSize: z.number().int(),
});
registerComponent('AppServiceItemListVo', appServiceItemListVo);
export type AppServiceItemListVo = z.infer<typeof appServiceItemListVo>;

/** 字段集合冻结：id/nickname/avatar/bio —— 无手机号、无状态、无备注 */
export const appStaffVo = z.object({
  id: z.number().int(),
  nickname: z.string(),
  avatar: z.string().nullable(),
  bio: z.string().nullable(),
});
registerComponent('AppStaffVo', appStaffVo);
export type AppStaffVo = z.infer<typeof appStaffVo>;

export const appStaffListVo = z.object({
  items: z.array(appStaffVo),
  page: z.number().int(),
  pageSize: z.number().int(),
});
registerComponent('AppStaffListVo', appStaffListVo);
export type AppStaffListVo = z.infer<typeof appStaffListVo>;

/**
 * 可约时段查询：`serviceItemIds` 兼容两种写法（§9.7）——
 * 逗号分隔 `?serviceItemIds=1,2` 或重复 query `?serviceItemIds=1&serviceItemIds=2`。
 * 这里的 schema 是 Swagger 文档口径；实际归一化见 `normalizeServiceItemIds`。
 */
export const appAvailableSlotsQuerySchema = z.object({
  staffId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ example: 1, description: '美甲师 ID' }),
  date: localDate,
  serviceItemIds: z.union([z.string(), z.array(z.string())]).openapi({
    example: '1,2',
    description: '服务项目 ID：逗号分隔或重复 query，去重后 1~3 个',
  }),
});
registerComponent('AppAvailableSlotsQuery', appAvailableSlotsQuerySchema);

/** 归一化后的项目 ID 数组：去重、1~3 个（与后台 `requireActiveItems` 约束一致） */
export const appServiceItemIdsSchema = z
  .array(z.number().int().positive())
  .min(1)
  .max(3);

/** 把 `string | string[] | number | ...` 的 query 值归一化成去重后的正整数数组 */
export function normalizeServiceItemIds(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : [value];
  const ids = raw
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => Number(item));
  return [...new Set(ids)];
}

export const appSlotItemVo = z.object({
  startAt: isoDateTime,
  endAt: isoDateTime,
});
registerComponent('AppSlotItemVo', appSlotItemVo);

/** 与后台 `/biz/bookings/available-slots` 同源（同一个 SlotPort 实现，结果必须一致） */
export const appAvailableSlotsVo = z.object({
  slots: z.array(appSlotItemVo),
  reason: z
    .enum([
      'off',
      'no_shift',
      'staff_cannot_do',
      'fully_booked',
      'out_of_window',
    ])
    .optional()
    .openapi({ description: '无可约时段时的原因' }),
  durationMinutes: z.number().int(),
  bufferMinutes: z.number().int(),
});
registerComponent('AppAvailableSlotsVo', appAvailableSlotsVo);
export type AppAvailableSlotsVo = z.infer<typeof appAvailableSlotsVo>;

/* ------------------------------------------------------------------ *
 * 会员（member）
 * ------------------------------------------------------------------ */

/** 次卡对外字段：不含 price / payChannel / remark / createdBy 等内部字段 */
export const appMemberCardVo = z.object({
  id: z.number().int(),
  cardNo: z.string(),
  cardName: z.string(),
  totalTimes: z.number().int(),
  usedTimes: z.number().int(),
  expireAt: z
    .string()
    .nullable()
    .openapi({ example: '2027-09-11T00:00:00.000Z' }),
  status: z.enum(['active', 'used_up', 'expired', 'refunded']),
});
registerComponent('AppMemberCardVo', appMemberCardVo);
export type AppMemberCardVo = z.infer<typeof appMemberCardVo>;

/**
 * 「我的次卡」入参。
 *
 * A9 补上了分页：控制器与 `AppMemberCardListVo` **本来就声明了** `page/pageSize`
 * （响应里有、Swagger 里也写了），原 schema 只有 `status`，等于入参这一半漏了。
 * 与 `appBookingListQuerySchema` 一样扩展 `appListQuerySchema`，属于补齐而非改契约。
 */
export const appMemberCardsQuerySchema = appListQuerySchema.extend({
  status: z
    .enum(['active', 'used_up', 'expired', 'refunded'])
    .optional()
    .openapi({ description: '按状态过滤（不传 = 全部本人卡）' }),
});
registerComponent('AppMemberCardsQuery', appMemberCardsQuerySchema);

export const appMemberCardListVo = z.object({
  items: z.array(appMemberCardVo),
  page: z.number().int(),
  pageSize: z.number().int(),
});
registerComponent('AppMemberCardListVo', appMemberCardListVo);

/**
 * 积分兑换品（顾客侧目录）。
 *
 * **逐字段显式声明，且刻意不含 `remark`** —— 那是后台维护用的备注，
 * §8.3 要求不把内部字段透给顾客侧。用于兑换的字段只需这六个。
 */
export const appPointsGoodsVo = z.object({
  id: z.number().int(),
  name: z.string(),
  points: z.number().int().openapi({ description: '兑换所需积分' }),
  stock: z.number().int().openapi({ description: '-1 = 不限库存' }),
  perLimit: z.number().int().openapi({ description: '0 = 不限每人兑换次数' }),
  cardTypeName: z
    .string()
    .nullable()
    .openapi({ description: '兑换后发放的卡种名，让顾客知道换到的是什么' }),
});
registerComponent('AppPointsGoodsVo', appPointsGoodsVo);
export type AppPointsGoodsVo = z.infer<typeof appPointsGoodsVo>;

export const appPointsGoodsListVo = z.object({
  items: z.array(appPointsGoodsVo),
  page: z.number().int(),
  pageSize: z.number().int(),
});
registerComponent('AppPointsGoodsListVo', appPointsGoodsListVo);
export type AppPointsGoodsListVo = z.infer<typeof appPointsGoodsListVo>;

/** 兑换入参：**只收 goodsId** —— 顾客身份一律来自 token，不接受客户端传 customerId */
export const appPointsRedeemRequestSchema = z.object({
  goodsId: z.number().int().positive(),
});
registerComponent('AppPointsRedeemRequest', appPointsRedeemRequestSchema);
export type AppPointsRedeemRequest = z.infer<
  typeof appPointsRedeemRequestSchema
>;

/** 兑换结果：告诉顾客「扣了多少分、发到哪张卡」，不暴露内部流水 id 之外的账务细节 */
export const appPointsRedeemVo = z.object({
  redeemNo: z.string(),
  points: z.number().int().openapi({ description: '本次扣减的积分' }),
  cardNo: z.string(),
  cardId: z.number().int(),
});
registerComponent('AppPointsRedeemVo', appPointsRedeemVo);
export type AppPointsRedeemVo = z.infer<typeof appPointsRedeemVo>;

/**
 * 顾客持有的优惠券（对外字段）。
 *
 * **不含 `templateId`**（模板 id 是后台概念，顾客不需要也无法使用）、
 * **不含 `remark` 与审计字段**。`status` 取的是**现算后**的展示状态 ——
 * `usable` 但已过期的券在这里就是 `expired`，与次卡同一口径。
 */
export const appCustomerCouponVo = z.object({
  id: z.number().int(),
  couponNo: z.string(),
  /** 券名（模板名）：营销文案，顾客可见；模板 id 仍不暴露 */
  templateName: z.string().nullable(),
  /** 面额（分） */
  discountAmount: z.number().int(),
  /** 使用门槛（分）；0 = 无门槛 */
  thresholdAmount: z.number().int(),
  status: z.enum(['usable', 'used', 'expired', 'void']),
  expireAt: z
    .string()
    .nullable()
    .openapi({ example: '2027-09-11T00:00:00.000Z' }),
  usedAt: z.string().nullable(),
});
registerComponent('AppCustomerCouponVo', appCustomerCouponVo);
export type AppCustomerCouponVo = z.infer<typeof appCustomerCouponVo>;

export const appCouponsQuerySchema = appListQuerySchema.extend({
  status: z
    .enum(['usable', 'used', 'expired', 'void', 'all'])
    .optional()
    .openapi({ description: '按状态过滤（不传 = all）' }),
});
registerComponent('AppCouponsQuery', appCouponsQuerySchema);

export const appCustomerCouponListVo = z.object({
  items: z.array(appCustomerCouponVo),
  page: z.number().int(),
  pageSize: z.number().int(),
});
registerComponent('AppCustomerCouponListVo', appCustomerCouponListVo);

/** 可领取的券（顾客侧）：只给领取与展示所需字段，模板备注不外泄 */
export const appCouponOfferVo = z.object({
  id: z.number().int(),
  name: z.string(),
  thresholdAmount: z.number().int(),
  discountAmount: z.number().int(),
  validDays: z.number().int().openapi({ description: '0 = 用绝对区间' }),
  validTo: z.string().nullable(),
});
registerComponent('AppCouponOfferVo', appCouponOfferVo);
export type AppCouponOfferVo = z.infer<typeof appCouponOfferVo>;

export const appCouponOfferListVo = z.object({
  items: z.array(appCouponOfferVo),
});
registerComponent('AppCouponOfferListVo', appCouponOfferListVo);
export type AppCouponOfferListVo = z.infer<typeof appCouponOfferListVo>;

/** 领券入参：只收 templateId（顾客身份来自 token） */
export const appClaimCouponRequestSchema = z.object({
  templateId: z.number().int().positive(),
});
registerComponent('AppClaimCouponRequest', appClaimCouponRequestSchema);
export type AppCustomerCouponListVo = z.infer<
  typeof appCustomerCouponListVo
>;
export type AppMemberCardListVo = z.infer<typeof appMemberCardListVo>;

/** 会员信息：余额只有本金 + 赠送，无任何内部字段 */
export const appMemberMeVo = z.object({
  customerId: z.number().int(),
  name: z.string(),
  phone: z.string().nullable(),
  levelName: z.string().nullable(),
  discountPermille: z
    .number()
    .int()
    .openapi({ example: 950, description: '折扣率千分比；无等级 = 1000' }),
  points: z.number().int(),
  balancePrincipal: z.number().int().openapi({ description: '储值本金（分）' }),
  balanceBonus: z.number().int().openapi({ description: '储值赠送（分）' }),
  cards: z.array(appMemberCardVo),
});
registerComponent('AppMemberMeVo', appMemberMeVo);
export type AppMemberMeVo = z.infer<typeof appMemberMeVo>;

/* ------------------------------------------------------------------ *
 * 预约 / 评价 / 支付 / 订阅：本期只留契约骨架（501）
 * ------------------------------------------------------------------ */

export const appBookingStatusSchema = z.enum([
  'pending',
  'confirmed',
  'arrived',
  'completed',
  'cancelled',
  'no_show',
]);
export const appPayStatusSchema = z.enum([
  'unpaid',
  'partial',
  'paid',
  'refunded',
  'credit',
]);

export const appBookingItemVo = z.object({
  serviceItemId: z.number().int(),
  name: z.string(),
  price: z.number().int().openapi({ description: '价格（分）' }),
  durationMinutes: z.number().int(),
});
registerComponent('AppBookingItemVo', appBookingItemVo);

/** 「我的预约」单条（P2 实现；字段先定，避免 P2 改后台模型） */
export const appBookingVo = z.object({
  id: z.number().int(),
  bookingNo: z.string(),
  staffId: z.number().int(),
  staffName: z.string().nullable(),
  startAt: isoDateTime,
  endAt: isoDateTime,
  status: appBookingStatusSchema,
  payStatus: appPayStatusSchema,
  payableAmount: z.number().int(),
  paidAmount: z.number().int(),
  dueAmount: z.number().int(),
  items: z.array(appBookingItemVo),
});
registerComponent('AppBookingVo', appBookingVo);
export type AppBookingVo = z.infer<typeof appBookingVo>;

export const appBookingListVo = z.object({
  items: z.array(appBookingVo),
  page: z.number().int(),
  pageSize: z.number().int(),
});
registerComponent('AppBookingListVo', appBookingListVo);
export type AppBookingListVo = z.infer<typeof appBookingListVo>;

/** 下单响应（A10）：pending 待确认，不收款；字段与列表 VO 对齐 */
export const appCreateBookingVo = z.object({
  id: z.number().int(),
  bookingNo: z.string(),
  startAt: isoDateTime,
  endAt: isoDateTime,
  status: z.literal('pending'),
  payableAmount: z.number().int(),
  paidAmount: z.number().int(),
  dueAmount: z.number().int(),
  payStatus: appPayStatusSchema,
  items: z.array(appBookingItemVo),
});
registerComponent('AppCreateBookingVo', appCreateBookingVo);
export type AppCreateBookingVo = z.infer<typeof appCreateBookingVo>;

/** 取消响应（A10） */
export const appCancelBookingVo = z.object({
  changed: z.boolean().openapi({ description: '本次是否发生了状态变更' }),
  warning: z.string().nullable().openapi({
    description: '已有实收时提示走退款审批；null = 无',
  }),
});
registerComponent('AppCancelBookingVo', appCancelBookingVo);
export type AppCancelBookingVo = z.infer<typeof appCancelBookingVo>;

export const appBookingListQuerySchema = appListQuerySchema.extend({
  status: appBookingStatusSchema
    .optional()
    .openapi({ description: '按状态过滤' }),
});
registerComponent('AppBookingListQuery', appBookingListQuerySchema);

/** 自助下单（P2 接微信支付；本期 501） */
export const appCreateBookingRequestSchema = z.object({
  staffId: z.number().int().positive().openapi({ example: 1 }),
  startAt: isoDateTime,
  serviceItemIds: z
    .array(z.number().int().positive())
    .min(1)
    .max(3)
    .openapi({ example: [1, 2], description: '服务项目 ID（去重后 1~3 个）' }),
  memberCardId: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .openapi({ description: '使用次卡时传入' }),
  couponId: z
    .number()
    .int()
    .positive()
    .optional()
    .openapi({ description: '优惠券 ID；与积分抵扣二选一' }),
  pointsToUse: z
    .number()
    .int()
    .min(0)
    .optional()
    .openapi({ description: '积分抵扣数量' }),
  remark: z.string().max(200).nullable().optional(),
});
registerComponent('AppCreateBookingRequest', appCreateBookingRequestSchema);
export type AppCreateBookingRequest = z.infer<
  typeof appCreateBookingRequestSchema
>;

export const appCancelBookingRequestSchema = z.object({
  reason: z
    .string()
    .max(200)
    .optional()
    .openapi({ example: '临时有事', description: '取消原因' }),
});
registerComponent('AppCancelBookingRequest', appCancelBookingRequestSchema);
export type AppCancelBookingRequest = z.infer<
  typeof appCancelBookingRequestSchema
>;

export const appCreateReviewRequestSchema = z.object({
  bookingId: z.number().int().positive().openapi({ example: 1 }),
  rating: z
    .number()
    .int()
    .min(1)
    .max(5)
    .openapi({ example: 5, description: '评分 1~5' }),
  content: z.string().max(500).optional(),
  images: z.array(z.string().max(500)).max(9).optional(),
});
registerComponent('AppCreateReviewRequest', appCreateReviewRequestSchema);
export type AppCreateReviewRequest = z.infer<
  typeof appCreateReviewRequestSchema
>;

export const appReviewVo = z.object({
  id: z.number().int(),
  bookingId: z.number().int(),
  rating: z.number().int(),
  content: z.string().nullable(),
  createdAt: z.string(),
});
registerComponent('AppReviewVo', appReviewVo);
export type AppReviewVo = z.infer<typeof appReviewVo>;

/** 小程序内 JSAPI 支付（P2；本期后台在线支付走 Native 扫码） */
export const appWxpayJsapiRequestSchema = z.object({
  bookingId: z.number().int().positive().openapi({ example: 1 }),
  purpose: z
    .enum(['deposit', 'final'])
    .openapi({ example: 'deposit', description: '定金 / 尾款' }),
  amount: z
    .number()
    .int()
    .positive()
    .optional()
    .openapi({ description: '金额（分），不传则按预约应收' }),
});
registerComponent('AppWxpayJsapiRequest', appWxpayJsapiRequestSchema);
export type AppWxpayJsapiRequest = z.infer<typeof appWxpayJsapiRequestSchema>;

/** `wx.requestPayment` 所需参数（P2 填充） */
export const appWxpayJsapiVo = z.object({
  paymentNo: z.string(),
  timeStamp: z.string(),
  nonceStr: z.string(),
  package: z.string(),
  signType: z.literal('RSA'),
  paySign: z.string(),
});
registerComponent('AppWxpayJsapiVo', appWxpayJsapiVo);

/**
 * 微信支付 V3 渠道回调报文（`POST /app/payments/wxpay/notify`，§9.7 契约骨架）。
 *
 * 关键字段：`resource.ciphertext` 是 AES-256-GCM 密文，需用 `WXPAY_API_V3_KEY` 解密后
 * 才能拿到 `out_trade_no` / `transaction_id` / `amount.total`；签名与证书序号在**请求头**
 * （`Wechatpay-Signature` / `-Timestamp` / `-Nonce` / `-Serial`），不在 body 里。
 * 因此本期不做 `parse` 拦截：P2 由验签结果决定应答，而不是把报文判成 HTTP 400。
 */
export const appWxpayNotifyRequestSchema = z.object({
  id: z
    .string()
    .min(1)
    .openapi({ description: '回调通知 ID（幂等去重键之一）' }),
  create_time: z
    .string()
    .optional()
    .openapi({ example: '2026-09-11T10:00:00+08:00' }),
  event_type: z.string().optional().openapi({
    example: 'TRANSACTION.SUCCESS',
    description: '事件类型（支付成功为 TRANSACTION.SUCCESS）',
  }),
  resource_type: z.string().optional().openapi({ example: 'encrypt-resource' }),
  summary: z.string().optional().openapi({ example: '支付成功' }),
  resource: z.object({
    algorithm: z.string().openapi({ example: 'AEAD_AES_256_GCM' }),
    ciphertext: z.string().min(1).openapi({
      description: 'AES-256-GCM 密文（含 out_trade_no / amount.total）',
    }),
    associated_data: z.string().optional(),
    nonce: z.string(),
    original_type: z.string().optional().openapi({ example: 'transaction' }),
  }),
});
registerComponent('AppWxpayNotifyRequest', appWxpayNotifyRequestSchema);
export type AppWxpayNotifyRequest = z.infer<typeof appWxpayNotifyRequestSchema>;

/** 渠道应答契约：微信要求 HTTP 200 + `{code:'SUCCESS', message:'OK'}`；失败用 `{code:'FAIL', message}`（微信会重试） */
export const appWxpayNotifyVo = z.object({
  code: z.enum(['SUCCESS', 'FAIL']).openapi({ example: 'SUCCESS' }),
  message: z.string().openapi({ example: 'OK' }),
});
registerComponent('AppWxpayNotifyVo', appWxpayNotifyVo);
export type AppWxpayNotifyVo = z.infer<typeof appWxpayNotifyVo>;

/** 订阅消息授权（P2：模板落 `sys_notice_log.channel` 枚举位） */
export const appSubscribeRequestSchema = z.object({
  templateIds: z
    .array(z.string().min(1))
    .min(1)
    .max(3)
    .openapi({ example: ['TEMPLATE_ID'] }),
  bookingId: z.number().int().positive().optional(),
});
registerComponent('AppSubscribeRequest', appSubscribeRequestSchema);
export type AppSubscribeRequest = z.infer<typeof appSubscribeRequestSchema>;

export const appSubscribeVo = z.object({
  accepted: z.boolean(),
  templateIds: z.array(z.string()),
});
registerComponent('AppSubscribeVo', appSubscribeVo);
export type AppSubscribeVo = z.infer<typeof appSubscribeVo>;
