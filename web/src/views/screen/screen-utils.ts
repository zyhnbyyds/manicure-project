import dayjs from 'dayjs';
// 副作用导入：把 dayjs 默认时区设为东八区（与全站展示口径一致）
import '~/composables/useFormat';
import type { BookingCalendarBlock } from '~/api/biz/bookings';
import type { ScheduleCalendarCell } from '~/api/biz/schedules';

/**
 * 大屏展示的纯函数与类型。
 *
 * 大屏的口径与后台列表**故意不同**：列表看的是「单据状态机」，大屏看的是
 * 「这块屏挂在店里，员工抬头一眼要看懂谁在忙、谁快开始了、谁该结束了」。
 * 所以这里按**当前时间**重新推导一个展示态（{@link BlockTone}），
 * 而不是直接把 `status` 搬上来 —— 因为「已确认但早已过点」和「已确认要 10 分钟后开始」
 * 在单据上是同一个 status，在店里却是完全不同的两件事。
 */

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 「即将开始」的提前量：还有这么久就开单 → 换成醒目色 */
export const SOON_SECONDS = 30 * 60;

/** 「超时未完成」的宽限：结束时间 + 宽限都过了还没点完成才标红（正常拖堂不算异常） */
export const OVERTIME_GRACE_SECONDS = 10 * 60;

/** 时间轴两端各留的空白，避免首尾的块贴着屏幕边 */
const PADDING_SECONDS = 30 * 60;

/**
 * 时间轴的**最小跨度**（6 小时）。
 *
 * 早先这里用的是「固定铺开 9:00~21:00」当作基准，本意是无论有无数据都给出
 * 一整天的框架 —— 代价却是**每个块都被压窄**：一天只有下午几单时，时间轴
 * 仍然铺满 12 小时，75 分钟的预约只占到 8.9% 宽（1080p 上约 130px），
 * 那块地方连「还剩 25 分」五个字都摆不下，只能靠缩小字号，于是整块屏的字全变小了。
 *
 * 改成「数据范围 + 两端留白，不足 6 小时则**以中点为心**撑到 6 小时」：
 * 有早晚班时自然扩到全天（与原来等效），只有半天单时就只画那半天，块宽直接翻倍。
 * 撑到 6 小时的动机是防止「今天只有一单」时那一单横跨整屏刻度只剩两三个，
 * 那样看屏的人反而不知道现在是「忙」还是「空」。
 */
const MIN_SPAN_SECONDS = 6 * 3600;

/** 跨度超过这个值就把刻度从「每小时」改成「每 2 小时」，否则刻度标签会挤在一起 */
const DENSE_TICK_SECONDS = 11 * 3600;

/* ------------------------------------------------------------------ *
 * 时间换算（全部按店内本地时间，秒级）
 * ------------------------------------------------------------------ */

/** ISO 时刻 → 店内本地「当天 0 点起的秒数」 */
export function shopSecondsOf(iso: string): number {
  const local = dayjs(iso).tz();
  return local.hour() * 3600 + local.minute() * 60 + local.second();
}

/** 此刻的「当天 0 点起秒数」 */
export function nowSeconds(): number {
  const now = dayjs().tz();
  return now.hour() * 3600 + now.minute() * 60 + now.second();
}

/** 秒数 → `HH:mm` */
export function secondsLabel(seconds: number): string {
  const clamped = Math.max(0, Math.round(seconds));
  const hour = Math.floor(clamped / 3600) % 24;
  const minute = Math.floor((clamped % 3600) / 60);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** 1=周一 … 7=周日 */
export function isoWeekday(date: string): number {
  const weekday = dayjs(date).day();
  return weekday === 0 ? 7 : weekday;
}

/** `HH:MM(:SS)` 墙钟 → 秒；排班的 `segments` 是墙钟时间，不做时区换算 */
export function wallClockToSeconds(value: string): number {
  const [hour = 0, minute = 0, second = 0] = value.split(':').map(Number);
  return hour * 3600 + minute * 60 + second;
}

/* ------------------------------------------------------------------ *
 * 展示态
 * ------------------------------------------------------------------ */

/** 大屏块色板。深色底 + 高饱和，远距离也能分辨 */
export type BlockTone =
  | 'upcoming' // 待服务（还早）
  | 'soon' // 即将开始（30 分钟内）
  | 'active' // 进行中（含拖堂宽限内）
  | 'overtime' // 早该结束但没结单
  | 'done' // 已完成
  | 'dead'; // 已取消 / 已爽约

export const TONE_LABELS: Record<BlockTone, string> = {
  upcoming: '待服务',
  soon: '即将开始',
  active: '进行中',
  overtime: '未完成',
  done: '已完成',
  dead: '已取消',
};

/**
 * 图例顺序，按「一天里状态推进的顺序」排。
 *
 * 大屏的块内**不写状态文字** —— 颜色省下的那行全给字号，这样隔三五米也看得清。
 * 代价是墙上必须有一份图例，所以顺序要稳定。`dead` 不在其中（它不上时间轴）。
 */
export const TONE_ORDER: BlockTone[] = [
  'upcoming',
  'soon',
  'active',
  'overtime',
  'done',
];

/**
 * 按「当前时间 + 单据状态」推导展示态。
 *
 * 判断顺序很重要：**先排掉终态**（完成 / 取消 / 爽约），剩下未结单的才交给时间轴，
 * 否则「已完成的单停留在过去时段」会被算成 overtime。
 */
export function resolveTone(
  status: string,
  startSec: number,
  endSec: number,
  now: number,
): BlockTone {
  if (status === 'cancelled' || status === 'no_show') return 'dead';
  if (status === 'completed') return 'done';
  if (now >= endSec + OVERTIME_GRACE_SECONDS) return 'overtime';
  if (now >= startSec) return 'active';
  if (startSec - now <= SOON_SECONDS) return 'soon';
  return 'upcoming';
}

/** 进行中块的进度 0~1（超时则封顶在 1） */
export function blockProgress(
  startSec: number,
  endSec: number,
  now: number,
): number {
  if (endSec <= startSec) return 0;
  return Math.min(1, Math.max(0, (now - startSec) / (endSec - startSec)));
}

/* ------------------------------------------------------------------ *
 * 块 / 泳道 / 时间轴
 * ------------------------------------------------------------------ */

/** 块右上角时间徽标的语气：`info` 中性、`warn` 该准备了、`danger` 该动手了 */
export type BadgeKind = 'info' | 'warn' | 'danger';

export interface ScreenBlock {
  id: number;
  bookingNo: string;
  customerName: string;
  startSec: number;
  endSec: number;
  startLabel: string;
  endLabel: string;
  status: string;
  tone: BlockTone;
  /** 0~1，仅进行中 / 未完成有意义 */
  progress: number;
  /** 进度百分比（0~100 整数）—— 直接给内联样式用，省得模板里再乘一次 */
  progressPercent: number;
  /**
   * 右上角的时间徽标，null = 不显示。
   *
   * 这是「进度」最直接的表达：进行中报**还剩多久**、超时报**已超多久**、
   * 快开单报**还有多久**。抬个头就知道该去催谁。
   */
  badge: string | null;
  badgeKind: BadgeKind | null;
  /** 已到店（`arrived`）——前台最关心的一个信号，单独标出来 */
  arrived: boolean;
  /**
   * 时长徽章「90′」。
   *
   * 严格说它是**冗余**的 —— 时段本身已经隐含了时长。留着是因为「这单做完还有没有
   * 时间接下一个」这个减法店里几乎每次排期都要心算一遍，直接摆出来省一步。
   * 只在块够宽（`md` 档）时显示，窄块优先保住姓名与时段。
   */
  durationLabel: string;
}

/** 秒 → 「25 分」；块里寸土寸金，但隔几米看「分」比「′」认得清 */
function minuteMark(seconds: number): string {
  return `${Math.max(1, Math.round(seconds / 60))} 分`;
}

/** 秒 → 时长徽章文案：够两小时就换成小时，读的人不用自己除 60 */
function durationMark(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 120) return `${minutes} 分`;
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} 小时`;
}

export function buildScreenBlock(
  row: BookingCalendarBlock,
  now: number,
): ScreenBlock {
  const startSec = shopSecondsOf(row.startAt);
  const endSec = shopSecondsOf(row.endAt);
  const tone = resolveTone(row.status, startSec, endSec, now);
  const progress =
    tone === 'active' || tone === 'overtime'
      ? blockProgress(startSec, endSec, now)
      : 0;

  let badge: string | null = null;
  let badgeKind: BadgeKind | null = null;
  if (tone === 'overtime') {
    badge = `已超 ${minuteMark(now - endSec)}`;
    badgeKind = 'danger';
  } else if (tone === 'active') {
    const left = endSec - now;
    badge = `还剩 ${minuteMark(left)}`;
    // 只剩 5 分钟还没做完 → 时间不宽裕了，跟超时用同一种警示色
    badgeKind = left <= 5 * 60 ? 'danger' : 'info';
  } else if (tone === 'soon') {
    badge = `还有 ${minuteMark(startSec - now)}`;
    badgeKind = 'warn';
  }

  return {
    id: row.id,
    bookingNo: row.bookingNo,
    customerName: row.customerName,
    startSec,
    endSec,
    startLabel: secondsLabel(startSec),
    endLabel: secondsLabel(endSec),
    status: row.status,
    tone,
    progress,
    progressPercent: Math.round(progress * 100),
    badge,
    badgeKind,
    arrived: row.status === 'arrived',
    durationLabel: durationMark(endSec - startSec),
  };
}

/**
 * 已取消 / 已爽约：**不占任何人时间**，所以时间轴上不画。
 *
 * 时间轴上一块的语义是「这一段被占用了」，而取消单那一段其实是空的 ——
 * 画上去不仅误导，实测还会盖住真正有效的块（店里就有一条 11:45–16:15 的取消单，
 * 能把小美一下午的有效排期全遮掉）。它们只在统计里计一个数。
 */
export function isDeadStatus(status: string): boolean {
  return status === 'cancelled' || status === 'no_show';
}

/** 泳道里的一截班次 */
export interface ShiftSegment {
  startSec: number;
  endSec: number;
}

/** 泳道此刻的状态：有单在做 / 空闲 / 今天不上班 */
export type LaneState = 'busy' | 'free' | 'off';

export interface ScreenLane {
  staffId: number;
  nickname: string;
  /** true = 今天休息（`off` 例外），`shifts` 必为空 */
  off: boolean;
  shifts: ShiftSegment[];
  blocks: ScreenBlock[];
  state: LaneState;
  /** 空闲时提示「下一单 14:30」；没有后续单则为 null */
  nextStartSec: number | null;
}

/** 美甲师基础信息（`GET /biz/schedules/calendar` 的 `staffs`） */
export interface LaneStaff {
  id: number;
  nickname: string;
}

/**
 * 组装泳道。
 *
 * 三条规则：
 * 1. **只留有排班或有预约的人** —— 今天不上班也没单的人占一行是浪费屏幕；
 * 2. 预约里出现但 `staffs` 列表里没有的人（离职 / 权限不可见）**补进来**，不能丢单；
 * 3. 顺序沿用后端给的 `staffs` 顺序（店里的习惯顺序），补进来的人排最后。
 *
 * 已取消 / 爽约的单在这里就被滤掉（见 {@link isDeadStatus}），因此
 * 「今天只有取消单」的人如果本来也不上班，这一行会整个消失 —— 正确的，
 * 他那一天确实什么都没发生。
 */
export function buildLanes(
  staffs: LaneStaff[],
  cells: ScheduleCalendarCell[],
  blocks: BookingCalendarBlock[],
  now: number,
): ScreenLane[] {
  const cellByStaff = new Map(cells.map((cell) => [cell.staffId, cell]));
  const blocksByStaff = new Map<number, BookingCalendarBlock[]>();
  for (const block of blocks) {
    const list = blocksByStaff.get(block.staffId);
    if (list) list.push(block);
    else blocksByStaff.set(block.staffId, [block]);
  }

  const orderedIds: number[] = [];
  const nicknameOf = new Map<number, string>();
  for (const staff of staffs) {
    orderedIds.push(staff.id);
    nicknameOf.set(staff.id, staff.nickname);
  }
  for (const block of blocks) {
    if (nicknameOf.has(block.staffId)) continue;
    orderedIds.push(block.staffId);
    nicknameOf.set(
      block.staffId,
      block.staffName || `美甲师 #${block.staffId}`,
    );
  }

  const lanes: ScreenLane[] = [];
  for (const staffId of orderedIds) {
    const cell = cellByStaff.get(staffId);
    const off = cell?.off ?? false;
    const shifts: ShiftSegment[] = (cell?.segments ?? []).map((segment) => ({
      startSec: wallClockToSeconds(segment.startTime),
      endSec: wallClockToSeconds(segment.endTime),
    }));
    const screenBlocks = (blocksByStaff.get(staffId) ?? [])
      .filter((block) => !isDeadStatus(block.status))
      .map((block) => buildScreenBlock(block, now))
      .sort((a, b) => a.startSec - b.startSec);

    // 今天不上班、也没有任何单 → 这一行没有信息量
    if (off && screenBlocks.length === 0) continue;
    if (!off && shifts.length === 0 && screenBlocks.length === 0) continue;

    const live = screenBlocks.filter(
      (block) => block.tone === 'active' || block.tone === 'overtime',
    );
    const next = screenBlocks.find(
      (block) => block.tone === 'soon' || block.tone === 'upcoming',
    );
    const state: LaneState = live.length
      ? 'busy'
      : off || shifts.length === 0
        ? 'off'
        : 'free';

    lanes.push({
      staffId,
      nickname: nicknameOf.get(staffId) ?? `美甲师 #${staffId}`,
      off,
      shifts,
      blocks: screenBlocks,
      state,
      nextStartSec: next?.startSec ?? null,
    });
  }
  return lanes;
}

export interface TimelineScale {
  startSec: number;
  endSec: number;
  /** 刻度位置（秒） */
  ticks: number[];
}

/**
 * 算时间轴范围与刻度。
 *
 * 范围**只看预约块**，不看排班，也不看当前时间：
 *
 * - 不看当前时间 —— 否则时钟每走一秒范围就抖一下（现在线超出范围时贴边显示）；
 * - 不看排班 —— 排班表的跨度常常比实际生意大得多（实测这家店的模板排到 24:00），
 *   一旦算进来，时间轴会被拉到 16 小时：一个三小时的预约从 358px 缩到 263px，
 *   一下午三单全挤成 109px 的窄条，块里的字跟着一起小下去 —— 而这三单恰恰是
 *   这块屏上唯一要看的东西。班次底只负责「画」，不负责「定范围」，
 *   超出范围的那截由泳道的 `overflow: hidden` 自然裁掉。
 */
export function buildTimelineScale(
  blocks: { startSec: number; endSec: number }[],
): TimelineScale {
  let min: number;
  let max: number;
  if (blocks.length === 0) {
    // 今天没有任何有效预约：给一段「标准半天」的框架，别让轴上什么都不剩
    min = 9 * 3600;
    max = 15 * 3600;
  } else {
    min = Number.POSITIVE_INFINITY;
    max = Number.NEGATIVE_INFINITY;
    for (const block of blocks) {
      min = Math.min(min, block.startSec);
      max = Math.max(max, block.endSec);
    }
  }

  if (max - min < MIN_SPAN_SECONDS) {
    const mid = (min + max) / 2;
    min = mid - MIN_SPAN_SECONDS / 2;
    max = mid + MIN_SPAN_SECONDS / 2;
  }

  // 两端各留白并对齐到整点，刻度落在 `HH:00` 上看起来才舒服
  const startSec = Math.floor(Math.max(0, min - PADDING_SECONDS) / 3600) * 3600;
  const endSec =
    Math.ceil(Math.min(24 * 3600, max + PADDING_SECONDS) / 3600) * 3600;

  const step = endSec - startSec > DENSE_TICK_SECONDS ? 2 * 3600 : 3600;
  const ticks: number[] = [];
  for (let tick = startSec; tick <= endSec; tick += step) ticks.push(tick);
  return { startSec, endSec, ticks };
}

/** 秒 → 时间轴上的百分比（0~100） */
export function percentOf(value: number, scale: TimelineScale): number {
  const span = scale.endSec - scale.startSec;
  if (span <= 0) return 0;
  return ((value - scale.startSec) / span) * 100;
}

/** 把一段区间转成 `{ left%, width% }`，并给极短的块兜一个最小宽度 */
export function rangeStyle(
  startSec: number,
  endSec: number,
  scale: TimelineScale,
  minPercent = 0,
): Record<string, string> {
  const left = percentOf(startSec, scale);
  const width = Math.max(minPercent, percentOf(endSec, scale) - left);
  return { left: `${left}%`, width: `${width}%` };
}
