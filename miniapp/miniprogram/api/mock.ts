/**
 * 开发期演示数据（**仅当 `config.isMockEnabled()` 为 true 时被调用**）。
 *
 * 存在的理由（不是「跳过实现」）：
 * app token 必须经 `POST /app/auth/login` 获取，而该接口在未配置
 * `WX_MINIAPP_APPID` / `WX_MINIAPP_SECRET` 时按 spec §16.1 返回 503。
 * 凭据到位前 UI 拿不到真数据，所以这里提供**结构与真接口完全一致**的数据，
 * 让页面、主题、交互可以先做完并自证；切真接口只需改 `config.ts` 一个默认值。
 *
 * 刻意做到的两件事：
 * 1. 字段集合严格等于 `api/types.ts`（即后端冻结契约），不额外造字段；
 * 2. 可约时段按 **step 30 分钟、营业 10:00–19:00、提前期 60 分钟** 生成，
 *    并会给出 `off` / `fully_booked` 等真实 `reason`，好让空态文案也被真实覆盖。
 */
import { DEMO_CUSTOMER_ID } from '../config';
import { addDays, toLocalDateString } from '../utils/format';
import type {
  AvailableSlots,
  Booking,
  BookingStatus,
  CreateBookingRequest,
  CreateReviewRequest,
  BindPhoneVo,
  LoginVo,
  MemberCard,
  MemberMe,
  Paged,
  ServiceItem,
  SlotItem,
  Staff,
  StaffApplyVo,
  StaffBooking,
  StaffMe,
  StaffPerformance,
  StaffReview,
  StaffSchedule,
} from './types';

/* ── 基础数据 ──────────────────────────────────────────────── */

export const MOCK_SERVICE_ITEMS: ServiceItem[] = [
  {
    id: 1,
    name: '基础养护美甲',
    category: '基础护理',
    durationMinutes: 60,
    price: 12800,
    description: '修形 + 去死皮 + 营养油护理，不涂色也精致',
    image: null,
  },
  {
    id: 2,
    name: '温柔裸粉',
    category: '单色',
    durationMinutes: 60,
    price: 12800,
    description: '显白裸粉色，日常通勤最百搭',
    image: null,
  },
  {
    id: 3,
    name: '高级奶咖',
    category: '设计',
    durationMinutes: 90,
    price: 16800,
    description: '奶咖渐变，气质温柔不挑手',
    image: null,
  },
  {
    id: 4,
    name: '单色经典甲油胶',
    category: '单色',
    durationMinutes: 90,
    price: 16800,
    description: '经典的单色美甲，简约而不简单。选用高品质甲油胶，色泽饱满，持久亮泽。',
    image: null,
  },
  {
    id: 5,
    name: '法式浪漫',
    category: '款式',
    durationMinutes: 90,
    price: 18800,
    description: '经典法式微笑线，通勤百搭',
    image: null,
  },
  {
    id: 6,
    name: '星光闪粉',
    category: '设计',
    durationMinutes: 90,
    price: 20800,
    description: '细闪叠加，灯光下会流动',
    image: null,
  },
  {
    id: 7,
    name: '韩式渐变跳色',
    category: '款式',
    durationMinutes: 100,
    price: 23800,
    description: '晕染过渡自然，甜而不腻',
    image: null,
  },
  {
    id: 8,
    name: '全贴延长甲',
    category: '延长',
    durationMinutes: 150,
    price: 39800,
    description: '甲片延长 + 结构加固，适合断甲修复',
    image: null,
  },
];

export const MOCK_STAFFS: Staff[] = [
  { id: 1, nickname: '小柚', avatar: null, bio: '擅长日系' },
  { id: 2, nickname: '阿桃', avatar: null, bio: '擅长精致' },
  { id: 3, nickname: '星野', avatar: null, bio: '擅长简约' },
  { id: 4, nickname: 'Mika', avatar: null, bio: '擅长创意' },
];

export const MOCK_MEMBER: MemberMe = {
  customerId: DEMO_CUSTOMER_ID,
  name: '小仙女',
  phone: '138****8888',
  levelName: '蜜桃会员',
  discountPermille: 950,
  points: 1280,
  balancePrincipal: 26800,
  balanceBonus: 5000,
  cards: [],
};

export const MOCK_CARDS: MemberCard[] = [
  {
    id: 11,
    cardNo: 'C20260901001',
    cardName: '单色甲油胶 10 次卡',
    totalTimes: 10,
    usedTimes: 3,
    expireAt: '2027-09-01T00:00:00+08:00',
    status: 'active',
  },
  {
    id: 12,
    cardNo: 'C20260612007',
    cardName: '基础养护 6 次卡',
    totalTimes: 6,
    usedTimes: 6,
    expireAt: '2026-12-12T00:00:00+08:00',
    status: 'used_up',
  },
];

MOCK_MEMBER.cards = MOCK_CARDS;

/* ── 可约时段 ──────────────────────────────────────────────── */

const OPEN_HOUR = 10;
const CLOSE_HOUR = 19;
/** 与 spec §5.6 的 `biz.booking.stepMinutes` 默认值一致 */
const STEP_MINUTES = 30;
/** 与 spec §5.6 的 `biz.booking.minLeadMinutes`（小程序端）一致 */
const MIN_LEAD_MINUTES = 60;
/** 与 spec §4.3 的默认缓冲一致 */
const BUFFER_MINUTES = 15;

/** 稳定哈希：同样的入参永远得到同样的「已有预约」，刷新页面不会乱跳 */
function stableSeed(text: string): number {
  let hash = 7;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 100003;
  }
  return hash;
}

/** 本地日 → 星期（**手动解析，不走 `new Date('YYYY-MM-DD')`**，避免 UTC 偏移） */
function weekdayOf(date: string): number {
  const [year, month, day] = date.split('-').map((part) => Number(part));
  return new Date(year, month - 1, day).getDay();
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 店内本地日 + 当日分钟数 → 与后端同格式的本地时刻（含 +08:00 偏移） */
function toLocalIso(date: string, minutesFromMidnight: number): string {
  const hour = Math.floor(minutesFromMidnight / 60);
  const minute = minutesFromMidnight % 60;
  return `${date}T${pad(hour)}:${pad(minute)}:00+08:00`;
}

function durationOf(serviceItemIds: number[]): number {
  const total = MOCK_SERVICE_ITEMS.filter((item) => serviceItemIds.includes(item.id)).reduce(
    (sum, item) => sum + item.durationMinutes,
    0,
  );
  return total > 0 ? total : 60;
}

export function mockAvailableSlots(input: {
  staffId: number;
  date: string;
  serviceItemIds: number[];
}): AvailableSlots {
  const durationMinutes = durationOf(input.serviceItemIds);
  const base: AvailableSlots = {
    slots: [],
    durationMinutes,
    bufferMinutes: BUFFER_MINUTES,
  };

  const weekday = weekdayOf(input.date);
  const seed = stableSeed(`${input.staffId}:${input.date}`);

  // 每周固定休息：每家店都会遇到的真实情况，顺便覆盖 `off` 空态
  if (weekday === 1 && input.staffId % 2 === 1) {
    return { ...base, reason: 'off' };
  }
  // 周末客流大，偶尔整天排满，覆盖 `fully_booked`
  if (weekday === 6 && seed % 5 === 0) {
    return { ...base, reason: 'fully_booked' };
  }

  const lastStartMinutes = CLOSE_HOUR * 60 - durationMinutes;
  const slots: SlotItem[] = [];

  for (
    let minutes = OPEN_HOUR * 60;
    minutes <= lastStartMinutes;
    minutes += STEP_MINUTES
  ) {
    // 用稳定哈希模拟「已被别人约走」的时段
    if ((seed + minutes) % 7 === 0) continue;
    slots.push({
      startAt: toLocalIso(input.date, minutes),
      endAt: toLocalIso(input.date, minutes + durationMinutes),
    });
  }

  // 提前期：小程序端至少提前 60 分钟（后台代录才是 0 分钟，见 spec §5.6）
  const now = new Date();
  const today = toLocalDateString(now);
  let visible = slots;
  if (input.date === today) {
    const nowMinutes = now.getHours() * 60 + now.getMinutes() + MIN_LEAD_MINUTES;
    visible = slots.filter(
      (slot) => Number(slot.startAt.slice(11, 13)) * 60 + Number(slot.startAt.slice(14, 16)) >= nowMinutes,
    );
  }

  if (visible.length === 0) {
    return {
      ...base,
      reason: input.date === today ? 'out_of_window' : 'fully_booked',
    };
  }
  return { ...base, slots: visible };
}

/* ── 我的预约（内存态，供演示完整链路）────────────────────── */

let bookingSeq = 9001;

const DEMO_BOOKINGS: Booking[] = [
  {
    id: 8801,
    bookingNo: 'B20260910001',
    staffId: 1,
    staffName: '小柚',
    startAt: toLocalIso(toLocalDateString(addDays(new Date(), 2)), 14 * 60),
    endAt: toLocalIso(toLocalDateString(addDays(new Date(), 2)), 15 * 60 + 30),
    status: 'confirmed',
    payStatus: 'partial',
    payableAmount: 29600,
    paidAmount: 10000,
    dueAmount: 19600,
    items: [
      { serviceItemId: 3, name: '法式优雅白边', price: 19800, durationMinutes: 90 },
      { serviceItemId: 2, name: '单色经典甲油胶', price: 16800, durationMinutes: 90 },
    ],
  },
  {
    id: 8802,
    bookingNo: 'B20260906007',
    staffId: 3,
    staffName: '星野',
    startAt: toLocalIso(toLocalDateString(addDays(new Date(), -5)), 11 * 60),
    endAt: toLocalIso(toLocalDateString(addDays(new Date(), -5)), 12 * 60 + 40),
    status: 'completed',
    payStatus: 'paid',
    payableAmount: 25800,
    paidAmount: 25800,
    dueAmount: 0,
    items: [{ serviceItemId: 4, name: '猫眼磁吸', price: 25800, durationMinutes: 100 }],
  },
  {
    id: 8803,
    bookingNo: 'B20260912003',
    staffId: 2,
    staffName: '阿桃',
    startAt: toLocalIso(toLocalDateString(addDays(new Date(), 1)), 16 * 60),
    endAt: toLocalIso(toLocalDateString(addDays(new Date(), 1)), 17 * 60 + 30),
    status: 'pending',
    payStatus: 'unpaid',
    payableAmount: 12800,
    paidAmount: 0,
    dueAmount: 12800,
    items: [{ serviceItemId: 1, name: '基础养护美甲', price: 12800, durationMinutes: 60 }],
  },
];

let bookingStore: Booking[] = [...DEMO_BOOKINGS];

export function mockListBookings(input: {
  status?: BookingStatus;
  page?: number;
  pageSize?: number;
}): Paged<Booking> {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 20;
  const filtered = input.status
    ? bookingStore.filter((booking) => booking.status === input.status)
    : bookingStore;
  const sorted = [...filtered].sort((a, b) => (a.startAt < b.startAt ? 1 : -1));
  return { items: sorted, page, pageSize };
}

export function mockCreateBooking(payload: CreateBookingRequest): Booking {
  const items = MOCK_SERVICE_ITEMS.filter((item) => payload.serviceItemIds.includes(item.id));
  const staff = MOCK_STAFFS.find((candidate) => candidate.id === payload.staffId);
  const durationMinutes = items.reduce((sum, item) => sum + item.durationMinutes, 0);
  const originalAmount = items.reduce((sum, item) => sum + item.price, 0);
  const startAt = payload.startAt;
  const [hour, minute] = startAt.slice(11, 16).split(':').map((part) => Number(part));

  bookingSeq += 1;
  const booking: Booking = {
    id: bookingSeq,
    bookingNo: `B${startAt.slice(0, 10).replace(/-/g, '')}${String(bookingSeq).slice(-3)}`,
    staffId: payload.staffId,
    staffName: staff?.nickname ?? null,
    startAt,
    endAt: toLocalIso(startAt.slice(0, 10), hour * 60 + minute + durationMinutes),
    // 小程序自助下单进入「待确认」，与店员代录（直接 confirmed）区分（spec §4.3）
    status: 'pending',
    payStatus: 'unpaid',
    payableAmount: originalAmount,
    paidAmount: 0,
    dueAmount: originalAmount,
    items: items.map((item) => ({
      serviceItemId: item.id,
      name: item.name,
      price: item.price,
      durationMinutes: item.durationMinutes,
    })),
  };
  bookingStore = [booking, ...bookingStore];
  return booking;
}

export function mockCancelBooking(bookingId: number): Booking | null {
  const target = bookingStore.find((booking) => booking.id === bookingId);
  if (!target) return null;
  target.status = 'cancelled';
  return target;
}

export function mockCreateReview(payload: CreateReviewRequest): { id: number } {
  bookingSeq += 1;
  const target = bookingStore.find((booking) => booking.id === payload.bookingId);
  if (target) target.status = 'completed';
  return { id: bookingSeq };
}

export function mockLogin(): LoginVo {
  return {
    accessToken: 'mock-app-token',
    tokenType: 'Bearer',
    expiresIn: '15m',
    customerId: MOCK_MEMBER.customerId,
    staffId: MOCK_STAFF_ME.staffId,
    staffStatus: 'active',
  };
}

export function mockBindPhone(): BindPhoneVo {
  return {
    customerId: MOCK_MEMBER.customerId,
    created: false,
    staffId: MOCK_STAFF_ME.staffId,
    // 演示模式直接给 active，才能把工作台链路走完；真接口以服务端为准
    staffStatus: 'active',
    staffCandidate: { id: MOCK_STAFF_ME.staffId, nickname: MOCK_STAFF_ME.nickname },
  };
}

/* ── 美甲师工作台（S3/S4）───────────────────────────────── */

export const MOCK_STAFF_ME: StaffMe = {
  staffId: 201,
  nickname: '小柚',
  avatar: null,
  // 后端返回的就是脱敏后的号码，演示数据同样遵守（D11）
  phone: '138****0021',
  bio: '八年美甲师，擅长法式与晕染',
  staffStatus: 'active',
  allowedServiceItemIds: null,
};

let staffBookingStore: StaffBooking[] = [];

/** 今日日程：按传入日期造 3 单，覆盖「待到店 / 已到店 / 已完成」三种状态 */
function seedStaffBookings(date: string): StaffBooking[] {
  if (staffBookingStore.length > 0) return staffBookingStore;
  const base = [
    {
      hour: 10,
      name: '王女士',
      phone: '138****0001',
      status: 'confirmed' as BookingStatus,
      item: '基础养护美甲',
      price: 12800,
      minutes: 60,
      remark: null,
    },
    {
      hour: 13,
      name: '李女士',
      phone: '138****0002',
      status: 'arrived' as BookingStatus,
      item: '法式美甲',
      price: 19900,
      minutes: 60,
      remark: '指甲薄，轻一点',
    },
    {
      hour: 15,
      name: '张女士',
      phone: '138****0003',
      status: 'completed' as BookingStatus,
      item: '猫眼延长',
      price: 26800,
      minutes: 90,
      remark: null,
    },
  ];
  staffBookingStore = base.map((row, index) => ({
    id: 900 + index,
    bookingNo: `B${date.replace(/-/g, '')}${String(index + 1).padStart(3, '0')}`,
    customerName: row.name,
    customerPhoneMasked: row.phone,
    startAt: toLocalIso(date, row.hour * 60),
    endAt: toLocalIso(date, row.hour * 60 + row.minutes),
    status: row.status,
    payStatus: row.status === 'completed' ? 'paid' : 'unpaid',
    payableAmount: row.price,
    paidAmount: row.status === 'completed' ? row.price : 0,
    dueAmount: row.status === 'completed' ? 0 : row.price,
    remark: row.remark,
    items: [
      {
        serviceItemId: index + 1,
        name: row.item,
        price: row.price,
        durationMinutes: row.minutes,
      },
    ],
  }));
  return staffBookingStore;
}

export function mockStaffApply(): StaffApplyVo {
  return {
    staffId: MOCK_STAFF_ME.staffId,
    staffStatus: 'pending',
    staffRequestedAt: new Date().toISOString(),
  };
}

export function mockStaffBookings(input: {
  date?: string;
  status?: BookingStatus;
  page?: number;
  pageSize?: number;
}): Paged<StaffBooking> {
  const date = input.date ?? toLocalDateString(new Date());
  const all = seedStaffBookings(date);
  const filtered = input.status
    ? all.filter((booking) => booking.status === input.status)
    : all;
  return { items: filtered, page: input.page ?? 1, pageSize: input.pageSize ?? 20 };
}

export function mockStaffSchedule(date: string): StaffSchedule {
  return {
    date,
    off: false,
    segments: [{ startTime: '10:00', endTime: '19:00' }],
    overrides: [],
  };
}

export function mockStaffPerformance(period?: string): StaffPerformance {
  const effective =
    period ?? toLocalDateString(new Date()).slice(0, 7).replace('-', '');
  const item: StaffPerformance['items'][number] = {
    id: 5001,
    bookingId: 902,
    bookingNo: 'B20260911003',
    serviceItemName: '猫眼延长',
    baseAmount: 26800,
    amount: 2680,
    period: effective,
    status: 'accrued',
    settledAt: null,
  };
  return {
    period: effective,
    completedCount: 18,
    paidAmount: 386400,
    commission: { accrued: 2680, settled: 15200, reversed: 0 },
    rating: { count: 12, average: 4.8 },
    items: [item],
  };
}

export function mockStaffReviews(page = 1, pageSize = 20): Paged<StaffReview> {
  const items: StaffReview[] = [
    {
      id: 7001,
      bookingId: 902,
      bookingNo: 'B20260911003',
      score: 5,
      content: '小柚手很轻，法式画得很细腻～',
      reply: '谢谢喜欢，下次早点来可以挑新色板～',
      createdAt: '2026-09-10T18:20:00+08:00',
    },
    {
      id: 7002,
      bookingId: 901,
      bookingNo: 'B20260911002',
      score: 4,
      content: '整体不错，等的时间稍长了一点',
      reply: null,
      createdAt: '2026-09-09T16:05:00+08:00',
    },
  ];
  return { items, page, pageSize };
}
