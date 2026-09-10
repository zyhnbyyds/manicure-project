import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { and, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import { DatabaseService } from '../../../database/database.service';
import { bizBookings, bizStaffs } from '../../../database/schema/index';
import {
  type SlotQuery,
  type SlotResult,
  SchedulePort,
  ServiceItemPort,
  SlotPort,
  StaffPort,
} from '../common/ports.js';
import { BizConfigService } from '../common/biz-config.service.js';
import { maxBuffer, sumDuration } from '../common/money.js';
import {
  formatShopDateTime,
  shopDateOf,
  shopDayRange,
  shopLocalToUtc,
} from '../common/shop-time.js';
import type { BizTx } from '../common/tx.js';

/** 参与冲突判定的服务状态（终态不占时段） */
export const ACTIVE_BOOKING_STATUS = [
  'pending',
  'confirmed',
  'arrived',
] as const;

/**
 * 冲突预筛窗口。
 *
 * 判据里要加 `gap = max(本单缓冲, 对方缓冲)`，而对方缓冲是行内数据，写不进 SQL；
 * 因此 SQL 只做「明显不可能重叠」的粗筛（±1 天），精确判据在内存里按 §5.3 执行。
 * 单美甲师单日预约 < 20 条，代价可忽略。
 */
const CONFLICT_SCAN_WINDOW_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * 可约时段与冲突检测。
 *
 * 后台 `GET /biz/bookings/available-slots` 与小程序 `GET /app/available-slots`
 * **必须复用本服务**，否则两侧口径会分叉（B6 验收项）。
 */
@Injectable()
export class SlotsService extends SlotPort {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: BizConfigService,
    private readonly serviceItems: ServiceItemPort,
    private readonly staffs: StaffPort,
    private readonly schedule: SchedulePort,
  ) {
    super();
  }

  /**
   * `SELECT ... FOR UPDATE` 锁美甲师行——**必须是事务内第一条语句**（§6.2 硬约束 1）。
   *
   * MySQL 默认 REPEATABLE READ 下，一致性读快照在事务里第一条普通 SELECT 时建立；
   * 若在拿锁之前先普通查过一次，等锁期间别人提交的单子会落在快照之外，
   * 复检会「看不见」它，照样超订。
   */
  async lockStaffRow(tx: BizTx, staffId: number): Promise<void> {
    const [row] = await tx
      .select({ id: bizStaffs.id })
      .from(bizStaffs)
      .where(eq(bizStaffs.id, staffId))
      .for('update')
      .limit(1);
    if (!row) throw new BadRequestException('美甲师不存在');
  }

  /** 可约时段（§5.2 / §5.3） */
  async availableSlots(query: SlotQuery): Promise<SlotResult> {
    const bookingConfig = await this.config.booking();
    const timeZone = query.timeZone ?? bookingConfig.timezone;

    const items = await this.serviceItems.requireActiveItems(
      query.serviceItemIds,
    );
    const quoteItems = items.map((item) => ({
      serviceItemId: item.id,
      name: item.name,
      durationMinutes: item.durationMinutes,
      bufferMinutes: item.bufferMinutes,
      price: item.price,
    }));
    const durationMinutes = sumDuration(quoteItems);
    const bufferMinutes = maxBuffer(quoteItems);

    // 步骤 1.5：美甲师可做项目校验（空集合 = 可做全部，§22）
    const allowed = await this.staffs.allowedServiceItemIds(query.staffId);
    if (allowed && items.some((item) => !allowed.includes(item.id))) {
      return {
        slots: [],
        reason: 'staff_cannot_do',
        durationMinutes,
        bufferMinutes,
      };
    }

    const { start: dayStart, end: dayEnd } = shopDayRange(query.date, timeZone);
    const now = new Date();
    const maxAdvanceMs = bookingConfig.maxAdvanceDays * 24 * 60 * 60 * 1000;
    if (dayStart.getTime() > now.getTime() + maxAdvanceMs) {
      return {
        slots: [],
        reason: 'out_of_window',
        durationMinutes,
        bufferMinutes,
      };
    }

    // 步骤 1：班次（off → 不可约；custom → 替代周模板；否则周模板）
    const { off, segments } = await this.schedule.resolveShifts(
      query.staffId,
      query.date,
    );
    if (off) {
      return { slots: [], reason: 'off', durationMinutes, bufferMinutes };
    }
    if (!segments.length) {
      return { slots: [], reason: 'no_shift', durationMinutes, bufferMinutes };
    }

    // 步骤 2：当天有效预约（范围条件，不用 DATE() 以免索引失效）
    const existing = await this.database.db
      .select({
        startAt: bizBookings.startAt,
        endAt: bizBookings.endAt,
        bufferMinutes: bizBookings.bufferMinutes,
      })
      .from(bizBookings)
      .where(
        and(
          eq(bizBookings.staffId, query.staffId),
          inArray(bizBookings.status, [...ACTIVE_BOOKING_STATUS]),
          isNull(bizBookings.deletedAt),
          lt(bizBookings.startAt, dayEnd),
          gt(bizBookings.endAt, dayStart),
        ),
      );

    const leadMinutes =
      query.channel === 'miniapp'
        ? bookingConfig.minLeadMinutes
        : bookingConfig.adminMinLeadMinutes;
    const earliest = now.getTime() + leadMinutes * MINUTE_MS;
    const latest = now.getTime() + maxAdvanceMs;
    const stepMs = bookingConfig.stepMinutes * MINUTE_MS;
    const durationMs = durationMinutes * MINUTE_MS;

    // 步骤 3：枚举候选起点，网格以「店内本地日 00:00」为基准对齐
    const slots: { startAt: string; endAt: string }[] = [];
    for (const segment of segments) {
      const segStart = shopLocalToUtc(query.date, segment.startTime, timeZone);
      const segEnd = shopLocalToUtc(query.date, segment.endTime, timeZone);
      const firstGrid =
        dayStart.getTime() +
        Math.ceil(
          Math.max(segStart.getTime() - dayStart.getTime(), 0) / stepMs,
        ) *
          stepMs;
      for (let t = firstGrid; ; t += stepMs) {
        if (t + durationMs > segEnd.getTime()) break;
        if (t < earliest) continue;
        if (t > latest) break;
        const conflict = existing.some((row) => {
          const gap = Math.max(bufferMinutes, row.bufferMinutes) * MINUTE_MS;
          return (
            t < row.endAt.getTime() + gap &&
            row.startAt.getTime() < t + durationMs + gap
          );
        });
        if (conflict) continue;
        slots.push({
          startAt: formatShopDateTime(new Date(t), timeZone),
          endAt: formatShopDateTime(new Date(t + durationMs), timeZone),
        });
      }
    }

    if (!slots.length) {
      return {
        slots: [],
        reason: 'fully_booked',
        durationMinutes,
        bufferMinutes,
      };
    }
    return { slots, durationMinutes, bufferMinutes };
  }

  /** 冲突复检（**查询带 `FOR UPDATE`**：当前读永远看最新已提交版本） */
  async findConflicts(
    tx: BizTx,
    input: {
      staffId: number;
      startAt: Date;
      durationMinutes: number;
      bufferMinutes: number;
      excludeBookingId?: number | undefined;
    },
  ): Promise<{ id: number; bookingNo: string; startAt: Date; endAt: Date }[]> {
    const start = input.startAt.getTime();
    const end = start + input.durationMinutes * MINUTE_MS;
    const rows = await tx
      .select({
        id: bizBookings.id,
        bookingNo: bizBookings.bookingNo,
        startAt: bizBookings.startAt,
        endAt: bizBookings.endAt,
        bufferMinutes: bizBookings.bufferMinutes,
      })
      .from(bizBookings)
      .where(
        and(
          eq(bizBookings.staffId, input.staffId),
          inArray(bizBookings.status, [...ACTIVE_BOOKING_STATUS]),
          isNull(bizBookings.deletedAt),
          lt(bizBookings.startAt, new Date(end + CONFLICT_SCAN_WINDOW_MS)),
          gt(bizBookings.endAt, new Date(start - CONFLICT_SCAN_WINDOW_MS)),
        ),
      )
      .for('update');
    return rows
      .filter((row) => row.id !== input.excludeBookingId)
      .filter((row) => {
        // 对称判据：gap = max(本单缓冲, 对方缓冲)，前后各加一次（§5.3）
        const gap =
          Math.max(input.bufferMinutes, row.bufferMinutes) * MINUTE_MS;
        return (
          start < row.endAt.getTime() + gap && row.startAt.getTime() < end + gap
        );
      })
      .map((row) => ({
        id: row.id,
        bookingNo: row.bookingNo,
        startAt: row.startAt,
        endAt: row.endAt,
      }));
  }

  async assertNoConflict(
    tx: BizTx,
    input: {
      staffId: number;
      startAt: Date;
      durationMinutes: number;
      bufferMinutes: number;
      excludeBookingId?: number | undefined;
    },
  ): Promise<void> {
    const conflicts = await this.findConflicts(tx, input);
    if (conflicts.length)
      throw new ConflictException('该时段已被占用，请重新选择');
  }

  /**
   * 网格对齐校验（§9.5 第 4 步）——`startAt` 必须落在以店内本地日 00:00
   * 为基准、`stepMinutes` 为粒度的网格上。
   */
  async assertGridAligned(
    startAt: Date,
    date: string,
    timeZone: string,
  ): Promise<void> {
    const bookingConfig = await this.config.booking();
    const { start } = shopDayRange(date, timeZone);
    const stepMs = bookingConfig.stepMinutes * MINUTE_MS;
    if ((startAt.getTime() - start.getTime()) % stepMs !== 0) {
      throw new BadRequestException(
        `开始时间必须落在 ${bookingConfig.stepMinutes} 分钟网格上`,
      );
    }
  }

  /** 校验 `[startAt, startAt + D]` 完整落在某个班次段内（§9.5 第 4 步） */
  async assertWithinShift(input: {
    staffId: number;
    date: string;
    startAt: Date;
    durationMinutes: number;
    timeZone: string;
  }): Promise<void> {
    const { off, segments } = await this.schedule.resolveShifts(
      input.staffId,
      input.date,
    );
    const start = input.startAt.getTime();
    const end = start + input.durationMinutes * MINUTE_MS;
    const inside =
      !off &&
      segments.some((segment) => {
        const segStart = shopLocalToUtc(
          input.date,
          segment.startTime,
          input.timeZone,
        ).getTime();
        const segEnd = shopLocalToUtc(
          input.date,
          segment.endTime,
          input.timeZone,
        ).getTime();
        return start >= segStart && end <= segEnd;
      });
    if (!inside) throw new BadRequestException('所选时间不在该美甲师的班次内');
  }

  /** 同顾客同时段软检查（防手滑重复录单，§9.5） */
  async findCustomerOverlaps(input: {
    customerId: number;
    startAt: Date;
    durationMinutes: number;
    excludeBookingId?: number | undefined;
  }): Promise<{ id: number; bookingNo: string; startAt: Date; endAt: Date }[]> {
    const start = input.startAt.getTime();
    const end = start + input.durationMinutes * MINUTE_MS;
    const rows = await this.database.db
      .select({
        id: bizBookings.id,
        bookingNo: bizBookings.bookingNo,
        startAt: bizBookings.startAt,
        endAt: bizBookings.endAt,
      })
      .from(bizBookings)
      .where(
        and(
          eq(bizBookings.customerId, input.customerId),
          inArray(bizBookings.status, [...ACTIVE_BOOKING_STATUS]),
          isNull(bizBookings.deletedAt),
          lt(bizBookings.startAt, new Date(end)),
          gt(bizBookings.endAt, new Date(start)),
        ),
      );
    return rows.filter((row) => row.id !== input.excludeBookingId);
  }

  /**
   * 提前期校验（§5.6）：后台代录默认 0 分钟（顾客已坐在店里是首期最常见的场景），
   * 小程序端默认 60 分钟防呆。
   */
  async assertLeadTime(
    startAt: Date,
    channel: 'admin' | 'miniapp',
  ): Promise<void> {
    const bookingConfig = await this.config.booking();
    const leadMinutes =
      channel === 'miniapp'
        ? bookingConfig.minLeadMinutes
        : bookingConfig.adminMinLeadMinutes;
    if (leadMinutes <= 0) return;
    if (startAt.getTime() < Date.now() + leadMinutes * MINUTE_MS) {
      throw new BadRequestException(`需至少提前 ${leadMinutes} 分钟预约`);
    }
  }

  /** 某美甲师某日的有效预约（只读，供排班页展示） */
  async listDayBookings(staffId: number, date: string, timeZone: string) {
    const { start, end } = shopDayRange(date, timeZone);
    return this.database.db
      .select({
        id: bizBookings.id,
        bookingNo: bizBookings.bookingNo,
        startAt: bizBookings.startAt,
        endAt: bizBookings.endAt,
        status: bizBookings.status,
        customerName: bizBookings.customerName,
      })
      .from(bizBookings)
      .where(
        and(
          eq(bizBookings.staffId, staffId),
          inArray(bizBookings.status, [...ACTIVE_BOOKING_STATUS]),
          isNull(bizBookings.deletedAt),
          lt(bizBookings.startAt, end),
          gt(bizBookings.endAt, start),
        ),
      )
      .orderBy(bizBookings.startAt);
  }

  /** 店内本地日（单号回填 / 列表筛选用） */
  async shopDate(now: Date = new Date()): Promise<string> {
    const bookingConfig = await this.config.booking();
    return shopDateOf(now, bookingConfig.timezone);
  }

  /** 供排班模块复用：某时段内是否有未完成预约（只读，无锁） */
  async hasActiveBooking(
    staffId: number,
    startAt: Date,
    endAt: Date,
  ): Promise<boolean> {
    const [row] = await this.database.db
      .select({ count: sql<number>`count(*)` })
      .from(bizBookings)
      .where(
        and(
          eq(bizBookings.staffId, staffId),
          inArray(bizBookings.status, [...ACTIVE_BOOKING_STATUS]),
          isNull(bizBookings.deletedAt),
          lt(bizBookings.startAt, endAt),
          gt(bizBookings.endAt, startAt),
        ),
      );
    return Number(row?.count ?? 0) > 0;
  }
}
