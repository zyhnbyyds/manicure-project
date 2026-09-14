/**
 * 下单草稿（跨页面传递，不落库、不持久化）。
 *
 * 为什么不用 URL 参数传：一次预约要带「1~3 个项目 + 美甲师 + 日期 + 时段」，
 * 序列化进 query 又长又容易超限，而且中间页返回时要能复原，草稿更合适。
 *
 * **失效联动（容易被忽略但很关键）**：
 * - 改项目 → 时长/价格/适配的美甲师都变了 → 清掉美甲师与时段；
 * - 改美甲师 → 该美甲师的排班与冲突都变了 → 清掉时段。
 * 不做这个联动，就会出现「选好时段后回头改了项目，时段还是按旧时长算的」这类幽灵 bug。
 */
import type { ServiceItem, Staff } from '../api/types';

let items: ServiceItem[] = [];
let staff: Pick<Staff, 'id' | 'nickname' | 'avatar'> | null = null;
let slot: { date: string; startAt: string; endAt: string } | null = null;
let remark = '';

export function setDraftItems(next: ServiceItem[]): void {
  items = [...next];
  staff = null;
  slot = null;
}

export function setDraftStaff(
  next: Pick<Staff, 'id' | 'nickname' | 'avatar'>,
): void {
  staff = { ...next };
  slot = null;
}

export function setDraftSlot(next: {
  date: string;
  startAt: string;
  endAt: string;
}): void {
  slot = { ...next };
}

export function setDraftRemark(text: string): void {
  remark = text;
}

export function getDraftItems(): ServiceItem[] {
  return items;
}

export function getDraftStaff(): Pick<
  Staff,
  'id' | 'nickname' | 'avatar'
> | null {
  return staff;
}

export function getDraftSlot(): {
  date: string;
  startAt: string;
  endAt: string;
} | null {
  return slot;
}

export function getDraftRemark(): string {
  return remark;
}

export function hasDraftItems(): boolean {
  return items.length > 0;
}

export interface DraftTotals {
  durationMinutes: number;
  /** 项目原价合计（分） */
  originalPrice: number;
  itemCount: number;
}

export function getDraftTotals(): DraftTotals {
  return {
    durationMinutes: items.reduce((sum, item) => sum + item.durationMinutes, 0),
    originalPrice: items.reduce((sum, item) => sum + item.price, 0),
    itemCount: items.length,
  };
}

/** 确认页渲染用的一次性快照 */
export function getDraftSnapshot(): {
  items: ServiceItem[];
  staff: Pick<Staff, 'id' | 'nickname' | 'avatar'> | null;
  slot: { date: string; startAt: string; endAt: string } | null;
  remark: string;
} {
  return { items: [...items], staff, slot, remark };
}

/** 下单成功 / 用户放弃后调用 */
export function clearDraft(): void {
  items = [];
  staff = null;
  slot = null;
  remark = '';
}
