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
  /** 已绑定的美甲师 ID；`null` = 不是美甲师 */
  staffId: number | null;
  /** 工作台授权状态；只有 `active` 能进工作台 */
  staffStatus: StaffGrantStatus;
}

/**
 * 手机号绑定响应。
 *
 * `staffCandidate` 只表示「手机号命中了这位美甲师的档案」，**不代表已开通工作台**：
 * 按既定策略必须由店长在后台确认（仅凭手机号提权等于提权漏洞）。
 */
export interface BindPhoneVo {
  customerId: number;
  created: boolean;
  staffId: number | null;
  staffStatus: StaffGrantStatus;
  staffCandidate: { id: number; nickname: string } | null;
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

/** 收货地址（`/app/member/addresses`） */
export interface Address {
  id: number;
  contactName: string;
  contactPhone: string;
  province: string | null;
  city: string | null;
  district: string | null;
  /** 详细地址（门牌号 / 楼层 / 房间） */
  detail: string;
  /** 同一顾客最多一个默认地址（服务端保证） */
  isDefault: boolean;
}

/** 新增 / 编辑收货地址的入参 */
export interface AddressUpsertRequest {
  contactName: string;
  contactPhone: string;
  province?: string | null;
  city?: string | null;
  district?: string | null;
  detail: string;
  /** 不传 = 保持原样（编辑时忘了勾默认，不该把默认取消） */
  isDefault?: boolean;
}

/**
 * 收藏项：款式卡面字段 + 收藏时间。
 *
 * 字段与 `ServiceItem` 同名同义（收藏页与款式库看到的是同一种卡片），
 * 但**不是同一个类型**：这里多一个 `favoritedAt`。
 */
export interface Favorite {
  /** 款式 ID */
  id: number;
  name: string;
  category: string | null;
  durationMinutes: number;
  price: number;
  description: string | null;
  image: string | null;
  favoritedAt: string;
}

/**
 * 性别：与后端 `biz_customer.gender` **逐字一致**（`unknown` / `male` / `female`）。
 * 前端不要自己映射成中文以外的第三套值。
 */
export type Gender = 'unknown' | 'male' | 'female';

/**
 * 顾客自助改资料的入参（`PATCH /app/member/me`）。
 *
 * 只有这三项：**手机号不在这里** —— 换号等于换绑，必须走 `bindPhone()` 那条
 * 「授权 → 换手机号 → 留痕」的链路；等级 / 积分 / 余额只能由门店改。
 */
export interface UpdateProfileRequest {
  name?: string;
  gender?: Gender;
  /** 传 `null` 表示清空 */
  birthday?: string | null;
}

export interface MemberCard {
  id: number;
  cardNo: string;
  cardName: string;
  totalTimes: number;
  usedTimes: number;
  expireAt: string | null;
  status: MemberCardStatus;
}

/**
 * 次卡详情：列表项 + 服务端算的剩余次数与可用性。
 *
 * `remainingTimes` **不要在页面里自己算** `totalTimes - usedTimes`：
 * 撤销核销会把 `usedTimes` 退回去，只有服务端那一份口径与门店一致。
 */
export interface MemberCardDetail extends MemberCard {
  remainingTimes: number;
  usable: boolean;
  /** 不可用原因（可用时为 null），如「次卡已过期」「次数已用完」 */
  unusableReason: string | null;
}

/** 次卡使用记录（核销 / 撤销） */
export interface MemberCardLog {
  id: number;
  type: 'use' | 'revert';
  times: number;
  /** 撤销记录没有项目 → null（显示「—」，不要编名字） */
  serviceItemName: string | null;
  staffName: string | null;
  remark: string | null;
  createdAt: string;
}

/** 站内消息一条（`/app/notices`） */
export interface Notice {
  id: number;
  title: string;
  content: string;
  /** 分类来自**模板**；模板没分类时为 null（消息仍在「全部」里） */
  category: string | null;
  /** 已读时间；null = 未读 */
  readAt: string | null;
  createdAt: string;
  /** 关联预约（有的话点开跳订单详情） */
  bookingId: number | null;
}

/** 门店档案（`/app/shop`，来自 `sys_config`，门店可改） */
export interface ShopProfile {
  name: string;
  nameEn: string;
  phone: string;
  address: string;
  hours: string;
  latitude: number | null;
  longitude: number | null;
  notice: string | null;
}

/**
 * 上架中的充值档位（服务端配置）。
 *
 * 小程序**不得**再硬编码档位：门店在后台改「充多少送多少」，小程序还按旧比例
 * 宣传的话，充值通道一接通就是资金纠纷。
 */
export interface RechargePlan {
  id: number;
  name: string;
  /** 实付金额（分） */
  payAmount: number;
  /** 赠送金额（分） */
  bonusAmount: number;
}
export interface MemberMe {
  customerId: number;
  name: string;
  phone: string | null;
  /**
   * 会员号（`biz_customer.member_no`）。首次储值 / 消费时才生成，未入会是 `null`。
   *
   * **不要再拿 customerId 补零编一个卡号**：那个号跟门店系统里的对不上，
   * 顾客报给店员时谁也查不到。
   */
  memberNo: string | null;
  /** 性别（可在「个人资料」页自助修改） */
  gender: Gender;
  /** 生日 `YYYY-MM-DD`（可在「个人资料」页自助修改） */
  birthday: string | null;
  levelName: string | null;
  /**
   * 等级序号：**0 = 最低等级**（服务端按 `sort`/`upgradeAmount` 排出来的名次）。
   *
   * 卡面皮肤按它切换，**不要靠 `levelName` 判断高低** —— 等级名是门店自己起的
   * （可以叫「黑金卡」「VVIP」），前端不可能猜。散客（无等级）也是 0。
   */
  levelRank: number;
  /** 折扣率千分比；无等级 = 1000 */
  discountPermille: number;
  points: number;
  /** 单笔积分抵扣上限（千分比）：**服务端配置**，前端不得硬编码 */
  maxPointsPermille: number;
  /** 储值本金（分） */
  balancePrincipal: number;
  /** 储值赠送（分） */
  balanceBonus: number;
  /**
   * 累计充值（分，**毛额**）：充过多少就是多少，退款不减这一项。
   *
   * 充值页设计稿的「累计充值 ¥1200」用它 —— 顾客想看的是「我在你家充过多少」，
   * 不是一道需要解释的净额算式。
   */
  totalRecharged: number;
  cards: MemberCard[];
  /**
   * 小程序内自助支付（余额 / 次卡 / 积分）是否可用 —— **合规闸门**。
   *
   * 在虚拟支付接入（或法务确认无需接入）之前，服务端一律返回 `false`；
   * 页面据此**如实地**把入口置灰并说明原因，不要显示成「可用但点了报错」。
   */
  selfPayEnabled: boolean;
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
  /** 优惠券 ID：**与 pointsToUse 二选一**（服务端会 400） */
  couponId?: number | null;
  remark?: string | null;
}

/** 自助结算请求（`POST /app/bookings/:id/settle`） */
export interface SettleBookingRequest {
  /** 只允许不依赖通道对接的两个渠道；次卡行金额恒为 0 */
  payments?: {
    channel: 'balance' | 'card';
    amount: number;
    memberCardId?: number;
  }[];
  /** 积分抵扣数（服务端按 maxPointsPermille 复算上限，盖不住全款） */
  pointsUsed?: number;
  /** 到店后用次卡核销：下单没选卡时在结算补上，服务端会重算应付 */
  memberCardId?: number;
}

/** 自助结算响应：结算后的金额事实 */
export interface SettleBookingResult {
  payableAmount: number;
  paidAmount: number;
  dueAmount: number;
  payStatus: PayStatus;
  channelSummary: string | null;
  settledAt: string | null;
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

/* ── 美甲师工作台（S3 只读 / S4 写）─────────────────────
 * 逐字段对齐后端 `src/modules/app/dto/app-staff-workbench.vo.ts`。
 * 与顾客端一样：**后端没给的字段这里也不许有**（成本、内部备注一律不进来），
 * 顾客手机号后端已脱敏（`138****0000`），这里只负责展示与拨号。
 * -------------------------------------------------------- */

/** 工作台开通状态：`none` 未申请 / `pending` 待店长确认 / `active` 已开通 / `rejected` 已驳回 */
export type StaffGrantStatus = 'none' | 'pending' | 'active' | 'rejected';

export interface StaffMe {
  staffId: number;
  nickname: string;
  avatar: string | null;
  /** 脱敏手机号（`138****0000`）；`null` = 未留电话 */
  phone: string | null;
  bio: string | null;
  staffStatus: 'active';
  /** `null` = 全部项目可做；数组 = 可做的项目白名单 */
  allowedServiceItemIds: number[] | null;
}

export interface StaffBookingItem {
  serviceItemId: number;
  name: string;
  price: number;
  durationMinutes: number;
}

/** 美甲师视角的预约：比顾客端多了 `remark`（服务备注），**没有**任何成本字段 */
export interface StaffBooking {
  id: number;
  bookingNo: string;
  customerName: string;
  /** 已脱敏，可直接展示与拨号 */
  customerPhoneMasked: string | null;
  startAt: string;
  endAt: string;
  status: BookingStatus;
  payStatus: PayStatus;
  payableAmount: number;
  paidAmount: number;
  dueAmount: number;
  remark: string | null;
  items: StaffBookingItem[];
}

export interface StaffScheduleOverride {
  id: number;
  date: string;
  type: 'off' | 'custom';
  startTime: string | null;
  endTime: string | null;
  reason: string | null;
}

export interface StaffSchedule {
  date: string;
  /** `true` = 当天休息 */
  off: boolean;
  segments: { startTime: string; endTime: string }[];
  overrides: StaffScheduleOverride[];
}

export interface StaffCommissionItem {
  id: number;
  bookingId: number;
  bookingNo: string | null;
  serviceItemName: string | null;
  /** 计提基数（分） */
  baseAmount: number;
  /** 提成金额（分） */
  amount: number;
  period: string;
  status: 'accrued' | 'settled' | 'reversed';
  settledAt: string | null;
}

export interface StaffPerformance {
  /** `yyyyMM` */
  period: string;
  completedCount: number;
  /** 已完成预约的实收合计（分） */
  paidAmount: number;
  commission: { accrued: number; settled: number; reversed: number };
  /** `average` 为 `null` = 暂无评分（不是 0 分） */
  rating: { count: number; average: number | null };
  /** 逐单明细全见（D9），按 id 倒序，最多 500 条 */
  items: StaffCommissionItem[];
}

export interface StaffReview {
  id: number;
  bookingId: number;
  bookingNo: string | null;
  /** 1~5 */
  score: number;
  content: string | null;
  reply: string | null;
  createdAt: string;
}

/** `GET /app/staff/bookings/:id/phone`：按需取回的顾客真号 */
export interface StaffPhone {
  /** `null` = 顾客没留电话 */
  phone: string | null;
}

/** 到店 / 完成的响应：`changed=false` = 已是目标状态（幂等，不是失败） */
export interface StaffAction {
  changed: boolean;
  warning?: string | null;
}

export interface StaffApplyVo {
  staffId: number;
  staffStatus: 'pending' | 'active';
  staffRequestedAt: string | null;
}
