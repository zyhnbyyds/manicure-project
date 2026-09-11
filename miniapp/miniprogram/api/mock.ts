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
  LoginVo,
  MemberCard,
  MemberMe,
  Paged,
  ServiceItem,
  SlotItem,
  Staff,
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
    name: '单色经典甲油胶',
    category: '单色',
    durationMinutes: 90,
    price: 16800,
    description: '显白裸色系任选，持久 3~4 周',
    image: null,
  },
  {
    id: 3,
    name: '法式优雅白边',
    category: '款式',
    durationMinutes: 90,
    price: 19800,
    description: '经典法式微笑线，通勤百搭',
    image: null,
  },
  {
    id: 4,
    name: '猫眼磁吸',
    category: '款式',
    durationMinutes: 100,
    price: 25800,
    description: '光线一转就流动，安静但很贵气',
    image: null,
  },
  {
    id: 5,
    name: '手绘卡通小图案',
    category: '设计',
    durationMinutes: 120,
    price: 32800,
    description: '小熊 / 樱桃 / 小花瓣，可指定图案',
    image: null,
  },
  {
    id: 6,
    name: '韩式渐变跳色',
    category: '款式',
    durationMinutes: 100,
    price: 23800,
    description: '晕染过渡自然，甜而不腻',
    image: null,
  },
  {
    id: 7,
    name: '猫爪立体雕花',
    category: '设计',
    durationMinutes: 130,
    price: 35800,
    description: '立体胶手工雕花，出片率最高的一款',
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
  { id: 1, nickname: '小柚', avatar: null, bio: '日系可爱风 · 手绘卡通' },
  { id: 2, nickname: '阿桃', avatar: null, bio: '法式极简 · 裸色系' },
  { id: 3, nickname: '星野', avatar: null, bio: '猫眼磁吸 · 亮片控' },
  { id: 4, nickname: 'Mika', avatar: null, bio: '延长甲 · 结构加固' },
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
  };
}
