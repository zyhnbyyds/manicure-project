import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
} from 'drizzle-orm';
import { DatabaseService } from '../../../database/database.service.js';
import {
  bizBookings,
  bizStaffScheduleOverrides,
  bizStaffs,
  bizStaffWeeklyShifts,
} from '../../../database/schema/index.js';
import { BizConfigService } from '../common/biz-config.service.js';
import { SchedulePort, type BookingConflictItem } from '../common/ports.js';
import {
  addLocalDays,
  minutesToTime,
  shopDateOf,
  shopDayRange,
  shopLocalToUtc,
  shopToday,
  shopWeekday,
  timeToMinutes,
} from '../common/shop-time.js';
import type { BizExecutor, BizTx } from '../common/tx.js';

/** 周模板变更的保护视窗：未来 30 天（§6.4） */
const TEMPLATE_CONFLICT_DAYS = 30;

/** 未完成预约：会阻止排班被改成「把它们甩在班次之外」（§6.4） */
const UNFINISHED_BOOKING_STATUSES = [
  'pending',
  'confirmed',
  'arrived',
] as const;

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME_PATTERN = /^\d{2}:\d{2}(:\d{2})?$/;

export type ShiftSegment = { startTime: string; endTime: string };

export type WeeklyShiftRow = {
  id: number;
  weekday: number;
  startTime: string;
  endTime: string;
};

export type WeeklyShiftInput = {
  weekday: number;
  startTime: string;
  endTime: string;
};

export type ScheduleOverrideRow = {
  id: number;
  date: string;
  type: 'off' | 'custom';
  startTime: string | null;
  endTime: string | null;
  reason: string | null;
  /** 门店（null = 通用例外） */
  storeId: number | null;
};

export type ScheduleOverrideInput = {
  date: string;
  type: 'off' | 'custom';
  startTime?: string | null | undefined;
  endTime?: string | null | undefined;
  reason?: string | null | undefined;
  /** 门店（可空 = 通用例外，对能服务的所有门店生效）；层叠规则同周模板 */
  storeId?: number | null | undefined;
};

export type ScheduleOverrideFilter = {
  from?: string | undefined;
  to?: string | undefined;
  /** 只看该门店的例外（不传 = 不过滤） */
  storeId?: number | undefined;
};

export type ConflictItem = BookingConflictItem;

type OverrideState = {
  type: 'off' | 'custom';
  startTime: string | null;
  endTime: string | null;
};

/**
 * 排班（§4.3 / §9.3 / §6.4）。
 *
 * - 周模板 PUT **整体替换**（事务内先删后插，该表物理删）；
 * - 日期例外 `off` / `custom` 是**替代**而非叠加；
 * - 任何会让既有预约落在无效区间的变更默认 409 + 受影响清单，`force=true` 才落库。
 */
@Injectable()
export class SchedulingService extends SchedulePort {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: BizConfigService,
  ) {
    super();
  }

  /**
   * 周模板。
   *
   * 传了 `storeId` 就返回**该门店实际生效**的模板（专属优先、通用兜底），
   * 并用 `source` 说清这次用的是哪一层 —— 前端据此提示「这是通用模板」，
   * 否则运营会以为「我在 A 店明明改过了」。不传 = 只看通用层（老行为）。
   */
  async getWeeklyShifts(
    staffId: number,
    storeId: number | null = null,
  ): Promise<{ shifts: WeeklyShiftRow[]; source: 'store' | 'shared' }> {
    await this.assertStaffExists(staffId);
    const selection = {
      id: bizStaffWeeklyShifts.id,
      weekday: bizStaffWeeklyShifts.weekday,
      startTime: bizStaffWeeklyShifts.startTime,
      endTime: bizStaffWeeklyShifts.endTime,
    };
    const fetch = (scope: ReturnType<typeof isNull> | undefined) =>
      this.database.db
        .select(selection)
        .from(bizStaffWeeklyShifts)
        .where(and(eq(bizStaffWeeklyShifts.staffId, staffId), scope))
        .orderBy(
          asc(bizStaffWeeklyShifts.weekday),
          asc(bizStaffWeeklyShifts.startTime),
          asc(bizStaffWeeklyShifts.id),
        );
    if (storeId !== null) {
      const scoped = await fetch(eq(bizStaffWeeklyShifts.storeId, storeId));
      if (scoped.length) return { shifts: scoped, source: 'store' };
    }
    return {
      shifts: await fetch(isNull(bizStaffWeeklyShifts.storeId)),
      source: 'shared',
    };
  }

  /**
   * 周模板整体替换：事务内先删后插。
   *
   * **只替换指定那一层**（`storeId = null` 替换通用模板，否则替换该门店的专属模板）——
   * 改 A 店的班不该动到通用模板，反之亦然。
   *
   * 缩短 / 删除班次会让未来 30 天内既有预约越界时直接 409（§6.4 要求「先改期再保存」；
   * 周模板是长期生效的骨架，刻意不提供 force）。
   */
  async replaceWeeklyShifts(
    staffId: number,
    storeId: number | null,
    shifts: WeeklyShiftInput[],
    actorId: number,
  ): Promise<void> {
    await this.assertStaffExists(staffId);
    const normalized = this.validateWeeklyShifts(shifts);
    const conflicts = await this.findTemplateConflicts(
      staffId,
      storeId,
      normalized,
    );
    if (conflicts.length)
      throw this.conflictException(
        `新的周模板会让 ${conflicts.length} 条既有预约落在班次之外，请先改期再保存`,
        conflicts,
      );
    await this.database.db.transaction(async (tx) => {
      const scope =
        storeId === null
          ? isNull(bizStaffWeeklyShifts.storeId)
          : eq(bizStaffWeeklyShifts.storeId, storeId);
      await tx
        .delete(bizStaffWeeklyShifts)
        .where(and(eq(bizStaffWeeklyShifts.staffId, staffId), scope));
      if (!normalized.length) return;
      await tx.insert(bizStaffWeeklyShifts).values(
        normalized.map((shift) => ({
          staffId,
          storeId,
          weekday: shift.weekday,
          startTime: shift.startTime,
          endTime: shift.endTime,
          createdBy: actorId,
          updatedBy: actorId,
        })),
      );
    });
  }

  async listOverrides(
    staffId: number,
    filter: ScheduleOverrideFilter,
  ): Promise<ScheduleOverrideRow[]> {
    await this.assertStaffExists(staffId);
    const conditions = [eq(bizStaffScheduleOverrides.staffId, staffId)];
    if (filter.from)
      conditions.push(
        gte(bizStaffScheduleOverrides.date, this.assertLocalDate(filter.from)),
      );
    if (filter.to)
      conditions.push(
        lte(bizStaffScheduleOverrides.date, this.assertLocalDate(filter.to)),
      );
    if (filter.storeId !== undefined)
      conditions.push(eq(bizStaffScheduleOverrides.storeId, filter.storeId));
    return this.database.db
      .select({
        id: bizStaffScheduleOverrides.id,
        date: bizStaffScheduleOverrides.date,
        type: bizStaffScheduleOverrides.type,
        startTime: bizStaffScheduleOverrides.startTime,
        endTime: bizStaffScheduleOverrides.endTime,
        reason: bizStaffScheduleOverrides.reason,
        storeId: bizStaffScheduleOverrides.storeId,
      })
      .from(bizStaffScheduleOverrides)
      .where(and(...conditions))
      .orderBy(
        asc(bizStaffScheduleOverrides.date),
        asc(bizStaffScheduleOverrides.startTime),
        asc(bizStaffScheduleOverrides.id),
      );
  }

  /** 新增例外；撞既有预约时 409 + 受影响清单，`force=true` 才落库（§6.4） */
  async createOverride(
    staffId: number,
    input: ScheduleOverrideInput,
    actorId: number,
    force = false,
  ): Promise<{ id: number; conflicts: ConflictItem[] }> {
    await this.assertStaffExists(staffId);
    const timeZone = await this.timeZone();
    const date = this.assertLocalDate(input.date);
    if (input.type !== 'off' && input.type !== 'custom')
      throw new BadRequestException('例外类型只能是 off 或 custom');

    const existing = await this.loadDayOverrides(
      this.database.db,
      staffId,
      date,
      { storeId: input.storeId ?? null },
    );
    let startTime: string | null = null;
    let endTime: string | null = null;
    if (input.type === 'off') {
      if (input.startTime || input.endTime)
        throw new BadRequestException(
          '请假（type=off）不能填写开始/结束时间，否则会出现「既请假又上班」的脏数据',
        );
      if (existing.some((row) => row.type === 'off'))
        throw new ConflictException(`该日（${date}）已存在请假记录`);
    } else {
      startTime = this.normalizeTime(input.startTime);
      endTime = this.normalizeTime(input.endTime);
      if (!startTime || !endTime)
        throw new BadRequestException(
          '自定义时段（type=custom）必须填写 HH:MM:SS 格式的开始与结束时间',
        );
      if (timeToMinutes(startTime) >= timeToMinutes(endTime))
        throw new BadRequestException('自定义时段的开始时间必须早于结束时间');
      const customs = existing.filter(
        (row) => row.type === 'custom' && row.startTime && row.endTime,
      );
      this.assertNoOverlap(
        [
          ...customs.map((row) => ({
            startTime: row.startTime as string,
            endTime: row.endTime as string,
          })),
          { startTime, endTime },
        ],
        `日期 ${date} 的自定义时段存在重叠`,
      );
    }

    // 以「落库后」的有效班次做冲突判定（off 优先于 custom），按同一门店层级联
    const storeId = input.storeId ?? null;
    const after = await this.resolveSegments(
      this.database.db,
      staffId,
      date,
      [...existing, { type: input.type, startTime, endTime }],
      storeId,
    );
    const conflicts = await this.findDayConflicts(
      this.database.db,
      staffId,
      date,
      after.segments,
      timeZone,
      storeId,
    );
    if (conflicts.length && !force)
      throw this.conflictException(
        `该日（${date}）已有 ${conflicts.length} 条预约落在新班次之外，请先改期，或确认后强制保存`,
        conflicts,
      );

    const result = await this.database.db
      .insert(bizStaffScheduleOverrides)
      .values({
        staffId,
        storeId,
        date,
        type: input.type,
        startTime,
        endTime,
        reason: input.reason ?? null,
        createdBy: actorId,
        updatedBy: actorId,
      });
    return { id: Number(result[0].insertId), conflicts };
  }

  /** 删除例外（回到其余 custom 段 / 周模板）；产生越界预约时同样 409 + 清单 */
  async deleteOverride(
    staffId: number,
    overrideId: number,
    actorId: number,
    force = false,
  ): Promise<{ conflicts: ConflictItem[] }> {
    void actorId; // 物理删表，无可写入的审计列；保留形参以对齐冻结签名
    await this.assertStaffExists(staffId);
    const timeZone = await this.timeZone();
    const [row] = await this.database.db
      .select({
        id: bizStaffScheduleOverrides.id,
        date: bizStaffScheduleOverrides.date,
        storeId: bizStaffScheduleOverrides.storeId,
      })
      .from(bizStaffScheduleOverrides)
      .where(
        and(
          eq(bizStaffScheduleOverrides.id, overrideId),
          eq(bizStaffScheduleOverrides.staffId, staffId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('排班例外不存在');

    // 删掉后回到「同一层级的其余例外 / 周模板」，所以按这条例外自己的门店求值
    const remaining = await this.loadDayOverrides(
      this.database.db,
      staffId,
      row.date,
      { storeId: row.storeId, excludeOverrideId: overrideId },
    );
    const after = await this.resolveSegments(
      this.database.db,
      staffId,
      row.date,
      remaining,
      row.storeId,
    );
    const conflicts = await this.findDayConflicts(
      this.database.db,
      staffId,
      row.date,
      after.segments,
      timeZone,
      row.storeId,
    );
    if (conflicts.length && !force)
      throw this.conflictException(
        `删除该例外后，${row.date} 有 ${conflicts.length} 条预约落在班次之外，请先改期，或确认后强制删除`,
        conflicts,
      );

    await this.database.db
      .delete(bizStaffScheduleOverrides)
      .where(
        and(
          eq(bizStaffScheduleOverrides.id, overrideId),
          eq(bizStaffScheduleOverrides.staffId, staffId),
        ),
      );
    return { conflicts };
  }

  /**
   * 求值优先级：off → 当天不可约；custom → 替代周模板；否则周模板（§4.3 / §5.2）。
   *
   * **门店维度**（阶段 1.11）：传了 `storeId` 就按该门店求值 ——
   * 例外与周模板**各自**遵守「门店专属优先、通用兜底」（`store_id IS NULL` 即通用）。
   * 不传 / 传 `null` = 只看通用层，老调用方的行为不变。
   */
  async resolveShifts(
    staffId: number,
    date: string,
    options?: { storeId?: number | null | undefined; tx?: BizTx | undefined },
  ): Promise<{ off: boolean; segments: ShiftSegment[] }> {
    const executor: BizExecutor = options?.tx ?? this.database.db;
    const localDate = this.assertLocalDate(date);
    const storeId = options?.storeId ?? null;
    const overrides = await this.loadDayOverrides(
      executor,
      staffId,
      localDate,
      { storeId },
    );
    const resolved = await this.resolveSegments(
      executor,
      staffId,
      localDate,
      overrides,
      storeId,
    );
    return { off: resolved.off, segments: resolved.segments };
  }

  /** 指定班次段下越界的既有预约清单（§2.9） */
  async listConflicts(
    staffId: number,
    date: string,
    segments: ShiftSegment[],
  ): Promise<ConflictItem[]> {
    await this.assertStaffExists(staffId);
    const timeZone = await this.timeZone();
    return this.findDayConflicts(
      this.database.db,
      staffId,
      this.assertLocalDate(date),
      segments,
      timeZone,
    );
  }

  /* ---------------------------------------------------------------- *
   * 内部实现
   * ---------------------------------------------------------------- */

  private async timeZone(): Promise<string> {
    return (await this.config.booking()).timezone;
  }

  private async assertStaffExists(staffId: number): Promise<void> {
    const [staff] = await this.database.db
      .select({ id: bizStaffs.id })
      .from(bizStaffs)
      .where(and(eq(bizStaffs.id, staffId), isNull(bizStaffs.deletedAt)))
      .limit(1);
    if (!staff) throw new NotFoundException('美甲师不存在');
  }

  private assertLocalDate(value: string): string {
    const text = String(value ?? '').trim();
    if (!LOCAL_DATE_PATTERN.test(text))
      throw new BadRequestException('日期格式应为 YYYY-MM-DD');
    if (addLocalDays(text, 0) !== text)
      throw new BadRequestException(`非法日期：${text}`);
    return text;
  }

  private normalizeTime(value?: string | null): string | null {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    if (!LOCAL_TIME_PATTERN.test(text)) return null;
    const minutes = timeToMinutes(text);
    if (minutes < 0 || minutes > 24 * 60 - 1) return null;
    return minutesToTime(minutes);
  }

  private validateWeeklyShifts(
    shifts: WeeklyShiftInput[],
  ): { weekday: number; startTime: string; endTime: string }[] {
    if (!Array.isArray(shifts))
      throw new BadRequestException('班次数据格式不正确，应为数组');
    if (shifts.length > 70) throw new BadRequestException('班次段数过多');
    const grouped = new Map<number, ShiftSegment[]>();
    const normalized: {
      weekday: number;
      startTime: string;
      endTime: string;
    }[] = [];
    for (const shift of shifts) {
      const weekday = Math.trunc(Number(shift?.weekday));
      if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7)
        throw new BadRequestException(
          `星期取值非法：${String(shift?.weekday)}（应为 1=周一 ~ 7=周日）`,
        );
      const startTime = this.normalizeTime(shift?.startTime);
      const endTime = this.normalizeTime(shift?.endTime);
      if (!startTime || !endTime)
        throw new BadRequestException('班次时间格式应为 HH:MM:SS（或 HH:MM）');
      if (timeToMinutes(startTime) >= timeToMinutes(endTime))
        throw new BadRequestException(
          `星期${weekday} 的班次 ${startTime}-${endTime} 开始时间必须早于结束时间`,
        );
      const list = grouped.get(weekday) ?? [];
      list.push({ startTime, endTime });
      grouped.set(weekday, list);
      normalized.push({ weekday, startTime, endTime });
    }
    for (const [weekday, list] of grouped)
      this.assertNoOverlap(list, `星期${weekday} 的班次存在重叠`);
    return normalized.sort(
      (a, b) =>
        a.weekday - b.weekday ||
        timeToMinutes(a.startTime) - timeToMinutes(b.startTime),
    );
  }

  private assertNoOverlap(segments: ShiftSegment[], message: string): void {
    const sorted = [...segments].sort(
      (a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime),
    );
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (!previous || !current) continue;
      if (timeToMinutes(current.startTime) < timeToMinutes(previous.endTime))
        throw new BadRequestException(message);
    }
  }

  /**
   * 当天的例外，**按门店级联**：该门店的专属例外优先；一条都没有才看通用例外。
   *
   * 注意是「整体级联」而不是「混合取用」：A 店配了请假，就不会再叠加通用层的自定义时段 ——
   * 否则「上午请假 + 通用模板的下午班」会拼出一个运营根本没配过的班。
   */
  private async loadDayOverrides(
    executor: BizExecutor,
    staffId: number,
    date: string,
    options: {
      storeId?: number | null | undefined;
      excludeOverrideId?: number;
    } = {},
  ): Promise<OverrideState[]> {
    const base = [
      eq(bizStaffScheduleOverrides.staffId, staffId),
      eq(bizStaffScheduleOverrides.date, date),
    ];
    if (options.excludeOverrideId !== undefined)
      base.push(ne(bizStaffScheduleOverrides.id, options.excludeOverrideId));
    const selection = {
      type: bizStaffScheduleOverrides.type,
      startTime: bizStaffScheduleOverrides.startTime,
      endTime: bizStaffScheduleOverrides.endTime,
    };
    if (options.storeId !== null && options.storeId !== undefined) {
      const scoped = await executor
        .select(selection)
        .from(bizStaffScheduleOverrides)
        .where(
          and(...base, eq(bizStaffScheduleOverrides.storeId, options.storeId)),
        );
      if (scoped.length) return scoped;
    }
    return executor
      .select(selection)
      .from(bizStaffScheduleOverrides)
      .where(and(...base, isNull(bizStaffScheduleOverrides.storeId)));
  }

  /** 周模板级联：该门店的专属班次优先；没有专属班次才用通用（`store_id IS NULL`） */
  private async loadWeeklySegments(
    executor: BizExecutor,
    staffId: number,
    weekday: number,
    storeId: number | null,
  ): Promise<ShiftSegment[]> {
    const base = [
      eq(bizStaffWeeklyShifts.staffId, staffId),
      eq(bizStaffWeeklyShifts.weekday, weekday),
    ];
    const selection = {
      startTime: bizStaffWeeklyShifts.startTime,
      endTime: bizStaffWeeklyShifts.endTime,
    };
    const toSegments = (rows: ShiftSegment[]): ShiftSegment[] =>
      rows
        .map((row) => ({ startTime: row.startTime, endTime: row.endTime }))
        .sort(
          (a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime),
        );
    if (storeId !== null) {
      const scoped = await executor
        .select(selection)
        .from(bizStaffWeeklyShifts)
        .where(and(...base, eq(bizStaffWeeklyShifts.storeId, storeId)));
      if (scoped.length) return toSegments(scoped);
    }
    return toSegments(
      await executor
        .select(selection)
        .from(bizStaffWeeklyShifts)
        .where(and(...base, isNull(bizStaffWeeklyShifts.storeId))),
    );
  }

  /** off → 空；custom → 这些段；否则周模板该 weekday 的段（按门店级联） */
  private async resolveSegments(
    executor: BizExecutor,
    staffId: number,
    date: string,
    overrides: OverrideState[],
    storeId: number | null = null,
  ): Promise<{ off: boolean; segments: ShiftSegment[] }> {
    if (overrides.some((row) => row.type === 'off'))
      return { off: true, segments: [] };
    const customs = overrides
      .filter((row) => row.type === 'custom' && row.startTime && row.endTime)
      .map((row) => ({
        startTime: row.startTime as string,
        endTime: row.endTime as string,
      }))
      .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
    if (customs.length) return { off: false, segments: customs };
    return {
      off: false,
      segments: await this.loadWeeklySegments(
        executor,
        staffId,
        shopWeekday(date),
        storeId,
      ),
    };
  }

  /** 该日存在、且 `[start_at, end_at]` 不完全落在某个班次段内的未完成预约 */
  private async findDayConflicts(
    executor: BizExecutor,
    staffId: number,
    date: string,
    segments: ShiftSegment[],
    timeZone: string,
    storeId: number | null = null,
  ): Promise<ConflictItem[]> {
    const { start, end } = shopDayRange(date, timeZone);
    const rows = await executor
      .select({
        id: bizBookings.id,
        bookingNo: bizBookings.bookingNo,
        startAt: bizBookings.startAt,
        endAt: bizBookings.endAt,
        customerName: bizBookings.customerName,
      })
      .from(bizBookings)
      .where(
        and(
          eq(bizBookings.staffId, staffId),
          inArray(bizBookings.status, [...UNFINISHED_BOOKING_STATUSES]),
          isNull(bizBookings.deletedAt),
          gte(bizBookings.startAt, start),
          lt(bizBookings.startAt, end),
          // 门店专属班次只影响本店预约；通用班次看全部
          storeId === null ? undefined : eq(bizBookings.storeId, storeId),
        ),
      )
      .orderBy(asc(bizBookings.startAt));
    return rows
      .filter(
        (row) =>
          !this.withinSegments(
            row.startAt,
            row.endAt,
            date,
            segments,
            timeZone,
          ),
      )
      .map((row) => ({
        id: row.id,
        bookingNo: row.bookingNo,
        startAt: row.startAt,
        endAt: row.endAt,
        customerName: row.customerName,
        staffId,
      }));
  }

  private withinSegments(
    startAt: Date,
    endAt: Date,
    date: string,
    segments: ShiftSegment[],
    timeZone: string,
  ): boolean {
    const start = startAt.getTime();
    const end = endAt.getTime();
    return segments.some((segment) => {
      const segmentStart = shopLocalToUtc(
        date,
        segment.startTime,
        timeZone,
      ).getTime();
      const segmentEnd = shopLocalToUtc(
        date,
        segment.endTime,
        timeZone,
      ).getTime();
      return start >= segmentStart && end <= segmentEnd;
    });
  }

  /**
   * 周模板缩短 / 删除：未来 30 天内越界的既有预约
   * （有日期例外的日子不受模板影响）。
   *
   * **门店范围**：通用模板（`storeId = null`）影响所有门店的预约；
   * 门店专属模板只影响该门店 —— 误报比漏报好，所以通用层不去排除各店的专属例外。
   */
  private async findTemplateConflicts(
    staffId: number,
    storeId: number | null,
    shifts: WeeklyShiftInput[],
  ): Promise<ConflictItem[]> {
    const timeZone = await this.timeZone();
    const today = shopToday(timeZone);
    const lastDate = addLocalDays(today, TEMPLATE_CONFLICT_DAYS - 1);
    const byWeekday = new Map<number, ShiftSegment[]>();
    for (const shift of shifts) {
      const list = byWeekday.get(shift.weekday) ?? [];
      list.push({ startTime: shift.startTime, endTime: shift.endTime });
      byWeekday.set(shift.weekday, list);
    }
    // 例外按「该层 + 通用层」排除：这两层才是会盖住本次模板的
    const overrideScope =
      storeId === null
        ? isNull(bizStaffScheduleOverrides.storeId)
        : or(
            isNull(bizStaffScheduleOverrides.storeId),
            eq(bizStaffScheduleOverrides.storeId, storeId),
          );
    const overrides = await this.database.db
      .select({ date: bizStaffScheduleOverrides.date })
      .from(bizStaffScheduleOverrides)
      .where(
        and(
          eq(bizStaffScheduleOverrides.staffId, staffId),
          gte(bizStaffScheduleOverrides.date, today),
          lte(bizStaffScheduleOverrides.date, lastDate),
          overrideScope,
        ),
      );
    const overrideDates = new Set(overrides.map((row) => row.date));
    return this.findRangeConflicts(
      staffId,
      shopDayRange(today, timeZone).start,
      shopDayRange(addLocalDays(lastDate, 1), timeZone).start,
      byWeekday,
      timeZone,
      overrideDates,
      storeId,
    );
  }

  private async findRangeConflicts(
    staffId: number,
    from: Date,
    to: Date,
    byWeekday: Map<number, ShiftSegment[]>,
    timeZone: string,
    overrideDates: Set<string>,
    storeId: number | null = null,
  ): Promise<ConflictItem[]> {
    const rows = await this.database.db
      .select({
        id: bizBookings.id,
        bookingNo: bizBookings.bookingNo,
        startAt: bizBookings.startAt,
        endAt: bizBookings.endAt,
        customerName: bizBookings.customerName,
      })
      .from(bizBookings)
      .where(
        and(
          eq(bizBookings.staffId, staffId),
          inArray(bizBookings.status, [...UNFINISHED_BOOKING_STATUSES]),
          isNull(bizBookings.deletedAt),
          gte(bizBookings.startAt, from),
          lt(bizBookings.startAt, to),
          // 专属模板只影响本店的预约；通用模板看全部
          storeId === null ? undefined : eq(bizBookings.storeId, storeId),
        ),
      )
      .orderBy(asc(bizBookings.startAt));
    const conflicts: ConflictItem[] = [];
    for (const row of rows) {
      const date = shopDateOf(row.startAt, timeZone);
      if (overrideDates.has(date)) continue;
      const segments = byWeekday.get(shopWeekday(date)) ?? [];
      if (this.withinSegments(row.startAt, row.endAt, date, segments, timeZone))
        continue;
      conflicts.push({
        id: row.id,
        bookingNo: row.bookingNo,
        startAt: row.startAt,
        endAt: row.endAt,
        customerName: row.customerName,
        staffId,
      });
    }
    return conflicts;
  }

  private conflictException(
    message: string,
    conflicts: ConflictItem[],
  ): ConflictException {
    return new ConflictException({ message, conflicts });
  }
}
