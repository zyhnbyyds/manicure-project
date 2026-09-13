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
 * 次卡详情（batch4 第 2 屏「次卡详情」）。
 *
 * 比列表项多两样顾客真正要看的东西：
 * - `remainingTimes`：**服务端算**的剩余次数。不要让前端做 `total - used` ——
 *   撤销核销会把 `used_times` 退回去，两边的口径必须只有一份；
 * - `usable` + `unusableReason`：现在到店到底能不能用，不能用时说明是过期还是用完了。
 */
export const appMemberCardDetailVo = appMemberCardVo.extend({
  remainingTimes: z
    .number()
    .int()
    .openapi({ description: '剩余次数（服务端算）' }),
  usable: z.boolean().openapi({ description: '现在到店是否可用' }),
  unusableReason: z.string().nullable().openapi({
    example: '次卡已过期',
    description: '不可用原因；可用时为 null',
  }),
});
registerComponent('AppMemberCardDetailVo', appMemberCardDetailVo);
export type AppMemberCardDetailVo = z.infer<typeof appMemberCardDetailVo>;

/**
 * 次卡使用记录一条（核销 / 撤销）。
 *
 * `serviceItemName` / `staffName` 都可能为 null：撤销记录不带项目，
 * 美甲师档案被删后名字也取不到 —— 前端显示「—」，**不要编一个名字**。
 */
export const appMemberCardLogVo = z.object({
  id: z.number().int(),
  /** `use` = 核销，`revert` = 撤销（退款/改单把次数退回） */
  type: z.enum(['use', 'revert']),
  times: z.number().int(),
  serviceItemName: z.string().nullable(),
  staffName: z.string().nullable(),
  remark: z.string().nullable(),
  createdAt: z.string().openapi({ example: '2026-09-13T10:00:00.000Z' }),
});
registerComponent('AppMemberCardLogVo', appMemberCardLogVo);
export type AppMemberCardLogVo = z.infer<typeof appMemberCardLogVo>;

export const appMemberCardLogListVo = z.object({
  items: z.array(appMemberCardLogVo),
  page: z.number().int(),
  pageSize: z.number().int(),
});
registerComponent('AppMemberCardLogListVo', appMemberCardLogListVo);
export type AppMemberCardLogListVo = z.infer<typeof appMemberCardLogListVo>;

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
  category: z.string().nullable().openapi({ example: '美甲项目' }),
  image: z
    .string()
    .nullable()
    .openapi({ description: '商品图（未上传为 null，前端走本地占位图）' }),
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
  /**
   * 筛选胶囊的选项（与 `items` 同一次响应回来）。
   *
   * 为什么放在列表响应里而不是单独一个接口：C 端进页面就要「胶囊 + 首屏列表」两样东西，
   * 合成一次往返少一次闪烁；而且分类是**跟着数据变**的 —— 单独接口会让
   * 「胶囊里有这个分类、列表却空了」这种不一致有出现的可能。
   */
  categories: z
    .array(z.string())
    .openapi({ example: ['美甲项目', '周边好物'] }),
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
export type AppCustomerCouponListVo = z.infer<typeof appCustomerCouponListVo>;
export type AppMemberCardListVo = z.infer<typeof appMemberCardListVo>;

/** 性别：与 `biz_customer.gender` 同枚举（app 域自己声明，不复用后台 DTO） */
export const appGenderSchema = z
  .enum(['unknown', 'male', 'female'])
  .openapi({ example: 'female', description: '性别' });

/** 会员信息：余额只有本金 + 赠送，无任何内部字段 */
export const appMemberMeVo = z.object({
  customerId: z.number().int(),
  name: z.string(),
  phone: z.string().nullable(),
  /**
   * 会员号（`biz_customer.member_no`；首次储值/消费时生成 → 未入会是 `null`）。
   *
   * 早先没暴露，小程序只能用顾客 id 补零假装一个卡号（见 `pages/member` 的注释），
   * 顾客看到的号跟门店系统里的对不上。这里直接给真值，前端不做任何拼装。
   */
  memberNo: z.string().nullable().openapi({ example: 'M2026000001' }),
  /** 性别（顾客可在小程序自助修改） */
  gender: appGenderSchema,
  birthday: z
    .string()
    .nullable()
    .openapi({ example: '1996-08-12', description: '生日 YYYY-MM-DD' }),
  /**
   * 累计充值（分）：`biz_member_transaction` 里 `type='recharge'` 的金额合计。
   *
   * 口径是**毛额**（充过多少就是多少，退款走 `type='refund'` 单独记），
   * 与充值页设计稿「累计充值 ¥1200」一致 —— 顾客想看到的是「我在你家充过多少」，
   * 而不是一道需要解释的净额算式。
   */
  totalRecharged: z
    .number()
    .int()
    .openapi({ example: 120000, description: '累计充值（分，毛额）' }),
  levelName: z.string().nullable(),
  /**
   * 等级序号：**0 = 最低等级**（按 `sort` / `upgradeAmount` 升序排出来的名次）。
   *
   * 为什么由服务端给：小程序要「按等级换卡面皮肤」，而等级名是门店自己起的
   * （`biz_member_level.name` 可以叫「黑金卡」「VVIP」随便什么），前端不可能靠名字判断。
   * 给一个**与命名无关的名次**，皮肤就能随等级单调升级；等级数量由门店决定，
   * 前端只负责「名次 → 调色板」，超出预设档位时循环到最高一档。
   */
  levelRank: z.number().int().min(0).openapi({
    example: 1,
    description: '等级序号（0 = 最低等级），用于分等级卡面皮肤',
  }),
  discountPermille: z
    .number()
    .int()
    .openapi({ example: 950, description: '折扣率千分比；无等级 = 1000' }),
  points: z.number().int(),
  /**
   * 单笔积分抵扣上限（千分比，`biz.member.maxPointsPermille`，后端默认 300）。
   *
   * 给小程序**算预估**用；真正的抵扣金额仍由服务端算并夹取。
   * 前端不得再硬编码这个值 —— 曾经小程序写 500、后端默认 300，
   * 预估比服务端允许的多，顾客按预估下单后必然对不上。
   */
  maxPointsPermille: z.number().int().openapi({
    example: 300,
    description: '单笔积分抵扣上限（‰），服务端配置',
  }),
  balancePrincipal: z.number().int().openapi({ description: '储值本金（分）' }),
  balanceBonus: z.number().int().openapi({ description: '储值赠送（分）' }),
  cards: z.array(appMemberCardVo),
  /**
   * 小程序内自助支付渠道（余额 / 次卡 / 积分）是否可用。
   *
   * **合规闸门，默认 false**：在虚拟支付接入（或法务确认无需接入）之前，
   * 小程序不得提供这些支付渠道。前端据此**如实地**把入口置灰并说明原因，
   * 而不是显示成「可用但点了报错」。真正的闸门在服务端（`APP_SELF_PAY_ENABLED`）。
   */
  selfPayEnabled: z.boolean().openapi({
    description:
      'true=可用余额/次卡/积分自助支付；false=合规未就绪，请到店支付',
  }),
});
registerComponent('AppMemberMeVo', appMemberMeVo);
export type AppMemberMeVo = z.infer<typeof appMemberMeVo>;

/**
 * 顾客自助改资料（`POST /app/member/profile`）。
 *
 * 用 POST 而不是 PATCH：**`wx.request` 的 method 里没有 PATCH**（见
 * `miniapp/miniprogram/utils/request.ts` 的 `HttpMethod`），app 域的动作一律开成 POST。
 *
 * 白名单只有这三项，且**至少给一项**：
 * - **不含 `phone`** —— 手机号是绑定锚点，换号等于换绑，必须走
 *   `POST /app/auth/phone` 那条「同事务写 `app_wx_user_bind_log` 留痕」的链路；
 * - 不含等级 / 积分 / 余额 —— 那些只能由门店的账务链路改。
 *
 * `.strict()` 是刻意的：传白名单外的字段直接 400，而不是静默忽略 ——
 * 静默忽略会让顾客以为「我改过了」，回头发现没生效，变成查不出原因的悬案。
 */
export const appUpdateProfileRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(30)
      .optional()
      .openapi({ example: '张女士', description: '姓名（1~30 字）' }),
    gender: appGenderSchema.optional(),
    birthday: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional()
      .openapi({
        example: '1996-08-12',
        description: '生日 YYYY-MM-DD；传 null 表示清空',
      }),
  })
  .strict()
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: '至少提交一个要修改的字段',
  });
registerComponent('AppUpdateProfileRequest', appUpdateProfileRequestSchema);

/* ------------------------------------------------------------------ *
 * 收货地址（batch4 设计稿「收货地址」页）
 * ------------------------------------------------------------------ */

export const appAddressVo = z.object({
  id: z.number().int(),
  contactName: z.string().openapi({ example: '王女士' }),
  contactPhone: z.string().openapi({ example: '13800008888' }),
  province: z.string().nullable(),
  city: z.string().nullable(),
  district: z.string().nullable(),
  detail: z.string().openapi({ example: '南京西路1788号3楼355室' }),
  /** 同一顾客最多一个默认地址（由 service 在同一事务里保证） */
  isDefault: z.boolean(),
});
registerComponent('AppAddressVo', appAddressVo);
export type AppAddressVo = z.infer<typeof appAddressVo>;

export const appAddressListVo = z.object({
  items: z.array(appAddressVo),
});
registerComponent('AppAddressListVo', appAddressListVo);
export type AppAddressListVo = z.infer<typeof appAddressListVo>;

/**
 * 新增 / 编辑收货地址（`POST /app/member/addresses`、`.../:id/update`）。
 *
 * 手机号这里**只做宽松校验**（6~20 位数字，允许 + - 空格）而不是只收 11 位手机号：
 * 收货人可以是家人、也可以是公司前台座机 —— 用顾客档案那套手机号规则卡地址簿，
 * 只会让顾客填不进去。真正的顾客身份仍然由 token 决定，跟这串号码无关。
 */
export const appAddressUpsertRequestSchema = z
  .object({
    contactName: z
      .string()
      .trim()
      .min(1)
      .max(30)
      .openapi({ example: '王女士' }),
    contactPhone: z
      .string()
      .trim()
      .regex(/^[\d+\-() ]{6,20}$/)
      .openapi({ example: '13800008888', description: '收货人电话' }),
    province: z
      .string()
      .trim()
      .max(30)
      .nullish()
      .openapi({ example: '上海市' }),
    city: z.string().trim().max(30).nullish().openapi({ example: '上海市' }),
    district: z
      .string()
      .trim()
      .max(30)
      .nullish()
      .openapi({ example: '静安区' }),
    detail: z
      .string()
      .trim()
      .min(2)
      .max(200)
      .openapi({ example: '南京西路1788号3楼355室' }),
    isDefault: z
      .boolean()
      .optional()
      .openapi({ description: '是否设为默认地址' }),
  })
  .strict();
registerComponent('AppAddressUpsertRequest', appAddressUpsertRequestSchema);
export type AppAddressUpsertRequest = z.infer<
  typeof appAddressUpsertRequestSchema
>;

/* ------------------------------------------------------------------ *
 * 意见反馈（batch5 第 4 屏）
 * ------------------------------------------------------------------ */

/**
 * 提交意见反馈（`POST /app/feedback`）。
 *
 * **匿名时不写 `customer_id`**（不是写进去再标注匿名）—— 小程序上的「匿名」开关
 * 必须真的匿名，否则门店一查就知道是谁写的，而这个承诺是当着顾客的面做出的。
 * 因此 `isAnonymous: true` 时后端一律落 `customer_id = null`。
 */
export const appCreateFeedbackRequestSchema = z
  .object({
    type: z.string().trim().min(1).max(30).openapi({ example: '体验建议' }),
    content: z
      .string()
      .trim()
      .min(5)
      .max(1000)
      .openapi({ example: '希望可以按美甲师筛选档期' }),
    contact: z
      .string()
      .trim()
      .max(100)
      .optional()
      .openapi({ example: '13800000000', description: '联系方式（可空）' }),
    /** 截图（`POST /app/upload` 返回的 url），最多 3 张 */
    images: z.array(z.string().max(500)).max(3).optional(),
    /** 匿名开关：true 时后端**不记录**顾客身份 */
    anonymous: z.boolean().optional(),
  })
  .strict();
registerComponent('AppCreateFeedbackRequest', appCreateFeedbackRequestSchema);
export type AppCreateFeedbackRequest = z.infer<
  typeof appCreateFeedbackRequestSchema
>;

export const appCreateFeedbackVo = z.object({
  id: z.number().int(),
  /** 是否按匿名提交（前端据实提示「已匿名提交」） */
  anonymous: z.boolean(),
});
registerComponent('AppCreateFeedbackVo', appCreateFeedbackVo);
export type AppCreateFeedbackVo = z.infer<typeof appCreateFeedbackVo>;

/**
 * 上传图片的返回（`POST /app/upload`）。
 *
 * `url` 是可以直接塞进小程序 `<image src>` 的路径（相对路径，
 * 由小程序的 `absoluteAssetUrl` 拼上接口域名）。
 */
export const appUploadVo = z.object({
  id: z.number().int(),
  url: z.string().openapi({ example: '/api/v1/files/12/download' }),
  mime: z.string().openapi({ example: 'image/jpeg' }),
  size: z.number().int().openapi({ description: '字节数' }),
});
registerComponent('AppUploadVo', appUploadVo);
export type AppUploadVo = z.infer<typeof appUploadVo>;

/* ------------------------------------------------------------------ *
 * 取消/退款预览（batch4「取消预约」页要显示真实可退金额）
 * ------------------------------------------------------------------ */

/**
 * 取消预约的**费用预览**：由服务端按门店判责规则算，页面只负责展示。
 *
 * 为什么必须有这个接口：以前取消页只能写「可能扣除部分定金」这种原则性表述 ——
 * 因为 app 域读不到判责规则（在 `RefundPort.preview`）。写死比例会给出**错误的金额预期**，
 * 比不写更糟；而金额一律只在服务端算（money-invariants 红线）。
 */
export const appRefundPreviewVo = z.object({
  /** 已付金额（分） */
  paidAmount: z.number().int(),
  /** 按规则建议退款（分） */
  suggestAmount: z.number().int(),
  /** 按规则扣除（分） */
  deductAmount: z.number().int(),
  /** 命中的规则名（如「2-24 小时退一半」）；没有规则命中时为 null */
  policyName: z.string().nullable(),
  /** 退款比例（千分比；1000 = 全退） */
  refundPermille: z.number().int(),
  /** 距开始还有多少小时（负数 = 已过时间） */
  hoursToStart: z.number(),
});
registerComponent('AppRefundPreviewVo', appRefundPreviewVo);
export type AppRefundPreviewVo = z.infer<typeof appRefundPreviewVo>;

/* ------------------------------------------------------------------ *
 * 站内消息（batch5 第 2 屏「消息中心」）
 * ------------------------------------------------------------------ */

/**
 * 收件箱一条。
 *
 * `category` 来自**模板的分类**（模板被删/改名时为 null，消息仍然在「全部」里）——
 * 前端不要自己拿 `templateCode` 猜分类。
 */
export const appNoticeVo = z.object({
  id: z.number().int(),
  title: z.string().openapi({ example: '预约成功' }),
  content: z.string(),
  category: z.string().nullable().openapi({ example: '预约提醒' }),
  /** 已读时间；null = 未读 */
  readAt: z.string().nullable(),
  createdAt: z.string().openapi({ example: '2026-09-13T10:00:00.000Z' }),
  /** 关联预约（有的话前端可跳到订单详情） */
  bookingId: z.number().int().nullable(),
});
registerComponent('AppNoticeVo', appNoticeVo);
export type AppNoticeVo = z.infer<typeof appNoticeVo>;

export const appNoticeListVo = z.object({
  items: z.array(appNoticeVo),
  page: z.number().int(),
  pageSize: z.number().int(),
  /** 未读数（tabBar 红点与「全部已读」都用它） */
  unread: z.number().int(),
  /**
   * 分类页签选项：**该顾客收件箱里真实出现过的分类**。
   * 跟着列表一起回 —— 前端硬编码一份清单的话，门店改分类名后那个页签就永远是空的。
   */
  categories: z.array(z.string()),
});
registerComponent('AppNoticeListVo', appNoticeListVo);
export type AppNoticeListVo = z.infer<typeof appNoticeListVo>;

/** 已读动作的返回：**剩余未读数**，前端据此更新红点，不用再拉一次列表 */
export const appNoticeReadVo = z.object({
  updated: z.number().int().openapi({ description: '本次标记为已读的条数' }),
  unread: z.number().int().openapi({ description: '剩余未读数' }),
});
registerComponent('AppNoticeReadVo', appNoticeReadVo);
export type AppNoticeReadVo = z.infer<typeof appNoticeReadVo>;

/* ------------------------------------------------------------------ *
 * 门店档案（小程序「门店」页）
 * ------------------------------------------------------------------ */

/**
 * 门店档案：**来自 `sys_config`（门店可在后台改），缺省回落内置默认值**。
 *
 * 这些值早先硬编码在小程序 `config.ts` 里，改一次要重新发版 —— 而门店电话、
 * 营业时间恰恰是最常改的信息。字段一律给非空字符串，C 端直接渲染不用到处判 null。
 */
export const appShopVo = z.object({
  name: z.string().openapi({ example: '美甲小铺' }),
  nameEn: z.string().openapi({ example: 'BEAUTY NAILS' }),
  phone: z.string().openapi({ example: '13800000000' }),
  address: z.string(),
  hours: z.string().openapi({ example: '10:00 - 20:00' }),
  /** 经纬度（地图导航用；门店没配则为 null） */
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  /** 公告 / 到店须知（门店可在后台改） */
  notice: z.string().nullable(),
});
registerComponent('AppShopVo', appShopVo);
export type AppShopVo = z.infer<typeof appShopVo>;

/* ------------------------------------------------------------------ *
 * 款式收藏（batch4 设计稿「我的收藏」页）
 * ------------------------------------------------------------------ */

/**
 * 收藏项 = 「款式卡面字段 + 收藏时间」。
 *
 * 卡面字段与 `AppServiceItemVo` **同名同义**（顾客在收藏页与款式库看到的是同一种卡片），
 * 但**刻意不复用同一个 schema**：收藏项多一个 `favoritedAt`，而且将来款式库加字段时
 * 不该被迫同时改收藏接口（app 域不复用后台 DTO，这条同理）。
 */
export const appFavoriteVo = z.object({
  id: z.number().int().openapi({ description: '款式 ID（= serviceItemId）' }),
  name: z.string(),
  category: z.string().nullable(),
  durationMinutes: z.number().int(),
  price: z.number().int().openapi({ description: '价格（分）' }),
  description: z.string().nullable(),
  image: z.string().nullable(),
  /** 收藏时间（ISO）；收藏页按它倒序 */
  favoritedAt: z.string().openapi({ example: '2026-09-13T10:00:00.000Z' }),
});
registerComponent('AppFavoriteVo', appFavoriteVo);
export type AppFavoriteVo = z.infer<typeof appFavoriteVo>;

export const appFavoriteListVo = z.object({
  items: z.array(appFavoriteVo),
});
registerComponent('AppFavoriteListVo', appFavoriteListVo);
export type AppFavoriteListVo = z.infer<typeof appFavoriteListVo>;

/**
 * 收藏动作的返回：**目标状态**，而不是「成功」两个字。
 *
 * 前端拿它直接改心形图标 —— 双击、慢网、并发点两次时，不会出现
 * 「图标显示的收藏状态与真实状态不一致」这种只能靠重启小程序恢复的怪象。
 */
export const appFavoriteToggleVo = z.object({
  serviceItemId: z.number().int(),
  favorited: z.boolean(),
});
registerComponent('AppFavoriteToggleVo', appFavoriteToggleVo);
export type AppFavoriteToggleVo = z.infer<typeof appFavoriteToggleVo>;

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
/** 上架中的充值档位（C 端展示用；只给名称与两个金额） */
export const appRechargePlanVo = z.object({
  id: z.number().int(),
  name: z.string(),
  payAmount: z.number().int().openapi({ description: '实付金额（分）' }),
  bonusAmount: z.number().int().openapi({ description: '赠送金额（分）' }),
});
registerComponent('AppRechargePlanVo', appRechargePlanVo);
export type AppRechargePlanVo = z.infer<typeof appRechargePlanVo>;

export const appRechargePlanListVo = z.object({
  items: z.array(appRechargePlanVo),
});
registerComponent('AppRechargePlanListVo', appRechargePlanListVo);
export type AppRechargePlanListVo = z.infer<typeof appRechargePlanListVo>;
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

/**
 * 自助结算请求（A14，顾客付尾款）。
 *
 * 渠道只允许**不需要任何通道对接**的两个：
 * - `balance` 储值余额（纯内部账务，走会员流水的条件更新扣减）；
 * - `card` 次卡核销（不产生金额，`amount` 恒为 0）。
 *
 * 排除项：微信 / 支付宝要等渠道对接（本期只有契约位）；现金与线下收款码是**店员动作**
 * （顾客能自己记账 = 谁都能把单标成已付）；挂账要占额度并由店员选定主体。
 */
export const appSettleBookingRequestSchema = z.object({
  payments: z
    .array(
      z.object({
        channel: z
          .enum(['balance', 'card'])
          .openapi({ description: 'balance=储值余额；card=次卡核销' }),
        amount: z
          .number()
          .int()
          .min(0)
          .openapi({ example: 10000, description: '金额（分）；次卡恒为 0' }),
        memberCardId: z.number().int().positive().optional().openapi({
          description: '次卡行可省略，省略时用下面的 memberCardId',
        }),
      }),
    )
    .max(2)
    .optional()
    .openapi({ description: '最多 2 笔（如 余额 4000 + 次卡核销）' }),
  pointsUsed: z.number().int().min(0).optional().openapi({
    description:
      '积分抵扣数。服务端按 `maxPointsPermille` 复算上限（默认 30%），所以积分**盖不住全款**',
  }),
  memberCardId: z.number().int().positive().optional().openapi({
    description: '到店后用次卡核销：下单没选卡时在结算补上，服务端会重算应付',
  }),
});
registerComponent('AppSettleBookingRequest', appSettleBookingRequestSchema);
export type AppSettleBookingRequest = z.infer<
  typeof appSettleBookingRequestSchema
>;

/** 自助结算响应（A14）：结算后的金额事实，前端据此刷新单据 */
export const appSettleBookingVo = z.object({
  payableAmount: z
    .number()
    .int()
    .openapi({ description: '重算后的应付（分）' }),
  paidAmount: z.number().int().openapi({ description: '累计实收（分）' }),
  dueAmount: z.number().int().openapi({ description: '剩余待收（分）' }),
  payStatus: appPayStatusSchema,
  channelSummary: z.string().nullable(),
  settledAt: isoDateTime.nullable(),
});
registerComponent('AppSettleBookingVo', appSettleBookingVo);
export type AppSettleBookingVo = z.infer<typeof appSettleBookingVo>;

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
