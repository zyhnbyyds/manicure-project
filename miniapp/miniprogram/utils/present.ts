/**
 * 视图模型（VM）映射层。
 *
 * 为什么必须有这一层：**WXML 里不能调用 TS 函数**，也不能做 `price / 100` 这类运算后
 * 再格式化。所有「分→元」「ISO→店内钟点」「状态→文案」「补 emoji」都必须在 TS 侧算好，
 * 页面只负责渲染，这样所有页面的金额与时间口径天然一致（也是主题之外最容易分裂的地方）。
 */
import type {
  AvailableSlots,
  Booking,
  MemberCard,
  MemberMe,
  ServiceItem,
  SlotItem,
  Staff,
  StaffBooking,
} from '../api/types';
import {
  fenToYuan,
  formatBookingStatus,
  formatDateTimeLabel,
  formatDiscount,
  formatDuration,
  formatPayStatus,
  formatTimeRange,
  isoClockTime,
} from '../utils/format';

/* ── emoji 点缀 ────────────────────────────────────────────── */

const CATEGORY_EMOJI: Record<string, string> = {
  基础护理: '🧴',
  单色: '🎨',
  款式: '✨',
  设计: '🎀',
  延长: '💅',
};

const SERVICE_EMOJI = ['💅', '✨', '🌸', '🎀', '🐱', '🍒', '🌙', '🧸'];
const STAFF_EMOJI = ['🍊', '🍑', '⭐', '🌙', '🐰', '🌷'];

/* ── 图片素材兜底 ──────────────────────────────────────────── */

/**
 * 设计稿是**照片驱动**的（美甲作品 + 美甲师头像），而演示数据里
 * `biz_service_item.image` / `biz_staff.avatar` 都是空的。
 *
 * 策略：**优先用接口给的图**；没有图时才用 `assets/` 里从设计稿裁出的占位图。
 * 接真数据后自动显示门店真实作品照，演示态也能保持与设计稿一致的观感。
 *
 * ⚠️ `assets/*.png` 是从设计稿裁出的**占位素材**（分辨率有限），
 * 上线前应替换为门店自己的作品照（走后台 `biz_service_item.images` 上传）。
 */
const SERVICE_IMAGE_FALLBACK = [
  '/assets/svc-a.png',
  '/assets/svc-b.png',
  '/assets/svc-c.png',
];

const STAFF_AVATAR_FALLBACK = [
  '/assets/staff-1.png',
  '/assets/staff-2.png',
  '/assets/staff-3.png',
  '/assets/staff-4.png',
];

/** 首页头图（设计稿里的大幅作品照） */
export const HERO_IMAGE = '/assets/hero.png';

export function resolveServiceImage(
  item: Pick<ServiceItem, 'id' | 'image'>,
): string {
  if (item.image && item.image.length > 0) return item.image;
  return SERVICE_IMAGE_FALLBACK[item.id % SERVICE_IMAGE_FALLBACK.length];
}

export function resolveStaffAvatar(staff: Pick<Staff, 'id' | 'avatar'>): string {
  if (staff.avatar && staff.avatar.length > 0) return staff.avatar;
  return STAFF_AVATAR_FALLBACK[
    (staff.id - 1 + STAFF_AVATAR_FALLBACK.length) % STAFF_AVATAR_FALLBACK.length
  ];
}

/** 没有展示图时用「分类 emoji + 主题渐变底」代替，不引入位图素材依赖 */
export function serviceEmoji(item: Pick<ServiceItem, 'id' | 'category'>): string {
  const byCategory = item.category ? CATEGORY_EMOJI[item.category] : undefined;
  if (byCategory) return byCategory;
  return SERVICE_EMOJI[item.id % SERVICE_EMOJI.length];
}

export function staffEmoji(staffId: number): string {
  return STAFF_EMOJI[(staffId - 1 + STAFF_EMOJI.length) % STAFF_EMOJI.length];
}

/* ── 服务项目 ──────────────────────────────────────────────── */

export interface ServiceItemVM {
  id: number;
  name: string;
  category: string;
  emoji: string;
  image: string | null;
  /** 可直接绑定到 `<image src>`：接口图或本地占位图 */
  imageResolved: string;
  description: string;
  durationText: string;
  /** 展示用整元部分，如 "128" */
  priceYuan: string;
  /** 展示用小数部分，如 "00" */
  priceCent: string;
  /** 完整价格文本，如 "128.00"，列表里用于排序/无障碍 */
  priceText: string;
  durationMinutes: number;
  price: number;
}

export function toServiceItemVM(item: ServiceItem): ServiceItemVM {
  const [yuan, cent] = fenToYuan(item.price).split('.');
  return {
    id: item.id,
    name: item.name,
    category: item.category ?? '其它',
    emoji: serviceEmoji(item),
    image: item.image,
    imageResolved: resolveServiceImage(item),
    description: item.description ?? '',
    durationText: formatDuration(item.durationMinutes),
    priceYuan: yuan,
    priceCent: cent ?? '00',
    priceText: fenToYuan(item.price),
    durationMinutes: item.durationMinutes,
    price: item.price,
  };
}

/* ── 美甲师 ────────────────────────────────────────────────── */

export interface StaffVM {
  id: number;
  nickname: string;
  bio: string;
  emoji: string;
  avatar: string | null;
  /** 可直接绑定到 `<image src>`：接口头像或本地占位头像 */
  avatarResolved: string;
  /** 昵称首字，没有头像时作为兜底标识 */
  initial: string;
}

export function toStaffVM(staff: Staff): StaffVM {
  return {
    id: staff.id,
    nickname: staff.nickname,
    bio: staff.bio ?? '擅长各种可爱款式',
    emoji: staffEmoji(staff.id),
    avatar: staff.avatar,
    avatarResolved: resolveStaffAvatar(staff),
    initial: staff.nickname.slice(0, 1),
  };
}

/* ── 可约时段 ──────────────────────────────────────────────── */

export interface SlotVM {
  startAt: string;
  endAt: string;
  /** 展示用钟点，如 "14:00" */
  timeText: string;
}

export function toSlotVM(slot: SlotItem): SlotVM {
  return {
    startAt: slot.startAt,
    endAt: slot.endAt,
    timeText: isoClockTime(slot.startAt),
  };
}

export interface AvailableSlotsVM {
  slots: SlotVM[];
  reason: string;
  durationText: string;
}

export function toAvailableSlotsVM(input: AvailableSlots, reasonText: string): AvailableSlotsVM {
  return {
    slots: input.slots.map(toSlotVM),
    reason: reasonText,
    durationText: formatDuration(input.durationMinutes),
  };
}

/* ── 会员 ──────────────────────────────────────────────────── */

export interface MemberCardVM {
  id: number;
  cardNo: string;
  cardName: string;
  /** 剩余可用次数 */
  remainTimes: number;
  totalTimes: number;
  usedTimes: number;
  statusText: string;
  statusKey: MemberCard['status'];
  /** 进度百分比（0~100），用于卡片进度条 */
  percent: number;
  expireText: string;
}

const CARD_STATUS_TEXT: Record<MemberCard['status'], string> = {
  active: '使用中',
  used_up: '已用完',
  expired: '已过期',
  refunded: '已退卡',
};

export function toMemberCardVM(card: MemberCard): MemberCardVM {
  const remain = Math.max(0, card.totalTimes - card.usedTimes);
  const percent =
    card.totalTimes > 0 ? Math.min(100, Math.round((card.usedTimes / card.totalTimes) * 100)) : 0;
  return {
    id: card.id,
    cardNo: card.cardNo,
    cardName: card.cardName,
    remainTimes: remain,
    totalTimes: card.totalTimes,
    usedTimes: card.usedTimes,
    statusText: CARD_STATUS_TEXT[card.status],
    statusKey: card.status,
    percent,
    expireText: card.expireAt
      ? `${card.expireAt.slice(0, 10).replace(/-/g, '.')} 到期`
      : '长期有效',
  };
}

export interface MemberMeVM {
  customerId: number;
  name: string;
  phoneText: string;
  levelName: string;
  discountText: string;
  points: number;
  balanceYuan: string;
  /** 本金与赠送分开显示（spec：赠送不可退，必须可区分） */
  balancePrincipalYuan: string;
  balanceBonusYuan: string;
  cards: MemberCardVM[];
  activeCardCount: number;
}

export function toMemberMeVM(me: MemberMe): MemberMeVM {
  const cards = me.cards.map(toMemberCardVM);
  return {
    customerId: me.customerId,
    name: me.name,
    phoneText: me.phone ?? '未绑定手机号',
    levelName: me.levelName ?? '普通顾客',
    discountText: formatDiscount(me.discountPermille),
    points: me.points,
    balanceYuan: fenToYuan(me.balancePrincipal + me.balanceBonus),
    balancePrincipalYuan: fenToYuan(me.balancePrincipal),
    balanceBonusYuan: fenToYuan(me.balanceBonus),
    cards,
    activeCardCount: cards.filter((card) => card.statusKey === 'active').length,
  };
}

/* ── 预约 ──────────────────────────────────────────────────── */

export type BookingTone = 'waiting' | 'active' | 'done' | 'cancelled';

export interface BookingVM {
  id: number;
  bookingNo: string;
  staffName: string;
  staffEmoji: string;
  /** 原始状态与资金状态：筛选/按钮显隐要用，不能只留展示文案 */
  status: Booking['status'];
  payStatus: Booking['payStatus'];
  /** 原始开始时刻：列表排序要用 */
  startAt: string;
  dateText: string;
  timeText: string;
  statusText: string;
  payStatusText: string;
  tone: BookingTone;
  /** 是否还能取消（待确认 / 已确认） */
  cancellable: boolean;
  /** 是否还能评价（已完成且未评价——评价与否由后端约束，这里只做入口显隐） */
  reviewable: boolean;
  payableText: string;
  dueText: string;
  /** 项目名拼接，如「法式优雅白边 · 单色经典甲油胶」 */
  itemNames: string;
  itemCount: number;
  durationText: string;
}

const TONE_BY_STATUS: Record<Booking['status'], BookingTone> = {
  pending: 'waiting',
  confirmed: 'active',
  arrived: 'active',
  completed: 'done',
  cancelled: 'cancelled',
  no_show: 'cancelled',
};

export function toBookingVM(booking: Booking): BookingVM {
  const tone = TONE_BY_STATUS[booking.status];
  const durationMinutes = booking.items.reduce((sum, item) => sum + item.durationMinutes, 0);
  return {
    id: booking.id,
    bookingNo: booking.bookingNo,
    staffName: booking.staffName ?? '到店安排',
    staffEmoji: staffEmoji(booking.staffId),
    status: booking.status,
    payStatus: booking.payStatus,
    startAt: booking.startAt,
    dateText: formatDateTimeLabel(booking.startAt).replace(/\s\d{2}:\d{2}$/, ''),
    timeText: formatTimeRange(booking.startAt, booking.endAt),
    statusText: formatBookingStatus(booking.status),
    payStatusText: formatPayStatus(booking.payStatus),
    tone,
    cancellable: booking.status === 'pending' || booking.status === 'confirmed',
    reviewable: booking.status === 'completed',
    payableText: fenToYuan(booking.payableAmount),
    dueText: fenToYuan(booking.dueAmount),
    itemNames: booking.items.map((item) => item.name).join(' · '),
    itemCount: booking.items.length,
    durationText: formatDuration(durationMinutes),
  };
}

/* ── 美甲师工作台 ──────────────────────────────────────────
 * 与顾客端 `toBookingRow` 分开：美甲师视角要「拨号 + 到店/完成」，
 * 且能看到服务备注；但同样**不出现任何成本字段**。
 * -------------------------------------------------------- */

/** 状态 → 主题色语义（与顾客端同一套 tone，颜色仍由主题令牌派生） */
function staffToneOf(status: string): string {
  if (status === 'pending' || status === 'confirmed') return 'waiting';
  if (status === 'completed') return 'done';
  if (status === 'cancelled' || status === 'no_show') return 'cancelled';
  return '';
}

export interface StaffBookingRow {
  id: number;
  bookingNo: string;
  customerName: string;
  /** 已脱敏；`null` = 顾客没留电话，不显示拨号入口 */
  customerPhoneMasked: string | null;
  dateText: string;
  timeText: string;
  durationText: string;
  itemNames: string;
  statusText: string;
  payStatusText: string;
  tone: string;
  payableText: string;
  dueText: string;
  remark: string | null;
  /** 与后端状态机一致：只有「已确认」能到店，只有「已到店」能完成 */
  canArrive: boolean;
  canComplete: boolean;
}

export function toStaffBookingRow(booking: StaffBooking): StaffBookingRow {
  const durationMinutes =
    booking.items.reduce((sum, item) => sum + item.durationMinutes, 0) || 60;
  return {
    id: booking.id,
    bookingNo: booking.bookingNo,
    customerName: booking.customerName,
    customerPhoneMasked: booking.customerPhoneMasked,
    dateText: formatDateTimeLabel(booking.startAt).replace(/\s\d{2}:\d{2}$/, ''),
    timeText: formatTimeRange(booking.startAt, booking.endAt),
    durationText: formatDuration(durationMinutes),
    itemNames: booking.items.map((item) => item.name).join(' + '),
    statusText: formatBookingStatus(booking.status),
    payStatusText: formatPayStatus(booking.payStatus),
    tone: staffToneOf(booking.status),
    payableText: fenToYuan(booking.payableAmount),
    dueText: fenToYuan(booking.dueAmount),
    remark: booking.remark,
    canArrive: booking.status === 'confirmed',
    canComplete: booking.status === 'arrived',
  };
}

/** 提成状态 → 文案 */
const COMMISSION_STATUS_TEXT: Record<string, string> = {
  accrued: '待发',
  settled: '已发',
  reversed: '已冲销',
};

export function formatCommissionStatus(status: string): string {
  return COMMISSION_STATUS_TEXT[status] ?? status;
}

/** `202609` → `2026年9月` */
export function formatPeriod(period: string): string {
  if (!/^\d{6}$/.test(period)) return period;
  return `${period.slice(0, 4)}年${Number(period.slice(4))}月`;
}
