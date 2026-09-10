import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, gte, isNull, ne } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../../../database/database.service.js';
import {
  bizBookingItems,
  bizBookingRecurrences,
  bizBookings,
} from '../../../../database/schema/index.js';
import { BizConfigService } from '../../common/biz-config.service.js';
import { buildDocNo } from '../../common/doc-no.js';
import {
  quoteBooking,
  sumDuration,
  type QuoteItem,
  type QuoteResult,
} from '../../common/money.js';
import {
  CustomerPort,
  MemberAccountPort,
  RecurrencePort,
  ServiceItemPort,
  SlotPort,
  StaffPort,
  type RecurrenceRow,
} from '../../common/ports.js';
import { andConditions, parsePagination } from '../../common/query.js';
import {
  addLocalDays,
  daysBetween,
  formatShopDateTime,
  listLocalDates,
  minutesToTime,
  shopDateOf,
  shopDayRange,
  shopLocalToUtc,
  shopToday,
  shopWeekday,
  timeToMinutes,
} from '../../common/shop-time.js';
import { withoutUndefined, type BizTx } from '../../common/tx.js';
import {
  NoticesService,
  NOTICE_TEMPLATES,
} from '../notices/notices.service.js';

export type CreateRecurrenceInput = {
  name?: string | null | undefined;
  customerId: number;
  staffId: number;
  serviceItemIds: number[];
  weekday: number;
  startTime: string;
  startDate: string;
  endDate?: string | null | undefined;
  generateDays?: number | undefined;
  conflictPolicy?: 'skip' | 'notify' | undefined;
  remark?: string | null | undefined;
};

export type UpdateRecurrenceInput = {
  name?: string | null | undefined;
  customerId?: number | undefined;
  staffId?: number | undefined;
  serviceItemIds?: number[] | undefined;
  weekday?: number | undefined;
  startTime?: string | undefined;
  startDate?: string | undefined;
  endDate?: string | null | undefined;
  generateDays?: number | undefined;
  conflictPolicy?: 'skip' | 'notify' | undefined;
  remark?: string | null | undefined;
};

export type RecurrenceFilter = {
  status?: 'active' | 'paused' | 'stopped' | undefined;
  customerId?: number | undefined;
  staffId?: number | undefined;
};

/** 生成时撞上已有预约的明细（创建接口回吐给前端） */
export type RecurrenceConflict = {
  date: string;
  startAt: string;
  policy: 'skip' | 'notify';
  bookingNos: string[];
  bookingId: number | null;
};

type RuleResult = {
  generated: number;
  skipped: number;
  conflicts: RecurrenceConflict[];
};

const CONFLICT_MARK = '周期生成·时段冲突待人工处理';
const MINUTE_MS = 60 * 1000;

/**
 * 周期预约（§21）。
 *
 * **幂等双保险**：
 * 1. `generated_until` 游标推进（窗口 = `[max(今天, 游标+1), min(今天+generate_days, end_date)]`）；
 * 2. `biz_booking` 上 `uq_booking_recurrence_start (recurrence_id, start_at)` 唯一索引——
 *    插入前先查 `(recurrence_id, start_at)`，冲突则跳过，并捕获 1062 兜底。
 *
 * **周期单默认不收款**：`pay_status='unpaid'`、`paid_amount=0`、`due_amount=payable_amount`，
 * 生成时**不建支付单**（§5.9 的唯一例外）；金额按项目快照用 `quoteBooking` 算，
 * 等级折扣取顾客当前等级，**不叠加积分抵扣**。
 */
@Injectable()
export class RecurrencesService extends RecurrencePort {
  private readonly logger = new Logger(RecurrencesService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly config: BizConfigService,
    private readonly serviceItems: ServiceItemPort,
    private readonly staffs: StaffPort,
    private readonly customers: CustomerPort,
    private readonly members: MemberAccountPort,
    private readonly slots: SlotPort,
    private readonly notices: NoticesService,
  ) {
    super();
  }

  /* ------------------------------------------------------------------ *
   * 规则 CRUD
   * ------------------------------------------------------------------ */

  /** 创建规则并**立即生成第一个窗口**（§21.2） */
  async create(
    input: CreateRecurrenceInput,
    actorId: number,
  ): Promise<{
    id: number;
    generated: number;
    skipped: number;
    conflicts: RecurrenceConflict[];
  }> {
    const items = await this.serviceItems.requireActiveItems(
      input.serviceItemIds,
    );
    await this.customers.requireById(input.customerId);
    await this.staffs.requireActive(input.staffId);
    const itemIds = items.map((item) => item.id);
    await this.assertStaffCanDo(input.staffId, itemIds);
    const startTime = normalizeTime(input.startTime);
    if (input.endDate && daysBetween(input.startDate, input.endDate) < 0)
      throw new BadRequestException('生效截止日不能早于生效起始日');
    await this.assertRuleSlotUnique(input.staffId, input.weekday, startTime);

    const [inserted] = await this.database.db
      .insert(bizBookingRecurrences)
      .values({
        name: input.name ?? null,
        customerId: input.customerId,
        staffId: input.staffId,
        serviceItemIds: itemIds,
        weekday: input.weekday,
        startTime,
        durationMinutes: sumDuration(items.map(toQuoteItem)),
        startDate: input.startDate,
        endDate: input.endDate ?? null,
        generateDays: input.generateDays ?? 30,
        status: 'active',
        conflictPolicy: input.conflictPolicy ?? 'notify',
        remark: input.remark ?? null,
        createdBy: actorId,
        updatedBy: actorId,
      });
    const id = Number(inserted.insertId);
    const result = await this.generateDetailed(id);
    return {
      id,
      generated: result.generated,
      skipped: result.skipped,
      conflicts: result.conflicts,
    };
  }

  async list(page: number, pageSize: number, filter: RecurrenceFilter = {}) {
    const paging = parsePagination(page, pageSize);
    const conditions = andConditions([
      isNull(bizBookingRecurrences.deletedAt),
      filter.status
        ? eq(bizBookingRecurrences.status, filter.status)
        : undefined,
      filter.customerId !== undefined
        ? eq(bizBookingRecurrences.customerId, filter.customerId)
        : undefined,
      filter.staffId !== undefined
        ? eq(bizBookingRecurrences.staffId, filter.staffId)
        : undefined,
    ]);
    const rows = await this.database.db
      .select()
      .from(bizBookingRecurrences)
      .where(conditions)
      .orderBy(desc(bizBookingRecurrences.id))
      .limit(paging.pageSize)
      .offset(paging.offset);
    const timeZone = (await this.config.booking()).timezone;
    const today = shopToday(timeZone);
    const items = rows.map((row) => ({
      ...row,
      nextGenerateDate: nextGenerateDate(row, today),
    }));
    return { items, page: paging.page, pageSize: paging.pageSize };
  }

  async findOne(id: number): Promise<RecurrenceRow> {
    const [row] = await this.database.db
      .select()
      .from(bizBookingRecurrences)
      .where(
        and(
          eq(bizBookingRecurrences.id, id),
          isNull(bizBookingRecurrences.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('周期预约规则不存在');
    return row;
  }

  /** 该规则已生成的预约（保留原单，不做回溯修改） */
  async listBookings(id: number, page: number, pageSize: number) {
    await this.findOne(id);
    const paging = parsePagination(page, pageSize);
    const items = await this.database.db
      .select({
        id: bizBookings.id,
        bookingNo: bizBookings.bookingNo,
        customerId: bizBookings.customerId,
        customerName: bizBookings.customerName,
        staffId: bizBookings.staffId,
        startAt: bizBookings.startAt,
        endAt: bizBookings.endAt,
        durationMinutes: bizBookings.durationMinutes,
        status: bizBookings.status,
        payStatus: bizBookings.payStatus,
        payableAmount: bizBookings.payableAmount,
        paidAmount: bizBookings.paidAmount,
        dueAmount: bizBookings.dueAmount,
        remark: bizBookings.remark,
      })
      .from(bizBookings)
      .where(
        and(eq(bizBookings.recurrenceId, id), isNull(bizBookings.deletedAt)),
      )
      .orderBy(asc(bizBookings.startAt))
      .limit(paging.pageSize)
      .offset(paging.offset);
    return { items, page: paging.page, pageSize: paging.pageSize };
  }

  /**
   * 改规则（时间 / 项目 / 有效期）**只影响未来生成**：
   * `generated_until` 游标不动，已生成的预约一单也不改（§21.3）。
   */
  async update(
    id: number,
    input: UpdateRecurrenceInput,
    actorId: number,
  ): Promise<void> {
    const rule = await this.findOne(id);
    if (rule.status === 'stopped')
      throw new ConflictException('规则已停止（终态），不可修改');

    const patch: Partial<typeof bizBookingRecurrences.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.remark !== undefined) patch.remark = input.remark;
    if (input.conflictPolicy !== undefined)
      patch.conflictPolicy = input.conflictPolicy;
    if (input.generateDays !== undefined)
      patch.generateDays = input.generateDays;
    if (input.weekday !== undefined) patch.weekday = input.weekday;
    if (input.startTime !== undefined)
      patch.startTime = normalizeTime(input.startTime);
    if (input.startDate !== undefined) patch.startDate = input.startDate;
    if (input.endDate !== undefined) patch.endDate = input.endDate;
    if (input.customerId !== undefined) {
      await this.customers.requireById(input.customerId);
      patch.customerId = input.customerId;
    }
    if (input.staffId !== undefined) {
      await this.staffs.requireActive(input.staffId);
      patch.staffId = input.staffId;
    }

    const staffId = patch.staffId ?? rule.staffId;
    if (input.serviceItemIds !== undefined) {
      const items = await this.serviceItems.requireActiveItems(
        input.serviceItemIds,
      );
      const itemIds = items.map((item) => item.id);
      await this.assertStaffCanDo(staffId, itemIds);
      patch.serviceItemIds = itemIds;
      patch.durationMinutes = sumDuration(items.map(toQuoteItem));
    } else if (patch.staffId !== undefined) {
      await this.assertStaffCanDo(
        staffId,
        readNumberArray(rule.serviceItemIds),
      );
    }

    const startDate = patch.startDate ?? rule.startDate;
    const endDate = input.endDate === undefined ? rule.endDate : input.endDate;
    if (endDate && daysBetween(startDate, endDate) < 0)
      throw new BadRequestException('生效截止日不能早于生效起始日');

    if (
      patch.weekday !== undefined ||
      patch.startTime !== undefined ||
      patch.staffId !== undefined
    )
      await this.assertRuleSlotUnique(
        staffId,
        patch.weekday ?? rule.weekday,
        patch.startTime ?? rule.startTime,
        id,
      );

    const fields = withoutUndefined(patch);
    if (!Object.keys(fields).length) return;
    await this.database.db
      .update(bizBookingRecurrences)
      .set({ ...fields, updatedBy: actorId })
      .where(
        and(
          eq(bizBookingRecurrences.id, id),
          isNull(bizBookingRecurrences.deletedAt),
        ),
      );
  }

  /** 暂停：只停生成，**已生成的单不受影响** */
  async pause(id: number, actorId: number) {
    return this.changeStatus(id, 'pause', actorId);
  }

  /** 恢复生成 */
  async resume(id: number, actorId: number) {
    return this.changeStatus(id, 'resume', actorId);
  }

  /** 停止：终态 */
  async stop(id: number, actorId: number) {
    return this.changeStatus(id, 'stop', actorId);
  }

  /**
   * 删除 = 停止 + 软删 + **把已生成预约的 `recurrence_id` 置空**。
   *
   * 外键是 `ON DELETE SET NULL`，软删不触发外键动作，必须显式 UPDATE（§21.3）。
   */
  async remove(
    id: number,
    actorId: number,
  ): Promise<{ id: number; status: 'stopped'; unlinkedBookings: number }> {
    await this.findOne(id);
    const unlinkedBookings = await this.database.db.transaction(async (tx) => {
      const unlinked = await tx
        .update(bizBookings)
        .set({ recurrenceId: null })
        .where(eq(bizBookings.recurrenceId, id));
      await tx
        .update(bizBookingRecurrences)
        .set({
          status: 'stopped',
          deletedAt: new Date(),
          updatedBy: actorId,
        })
        .where(eq(bizBookingRecurrences.id, id));
      return unlinked[0].affectedRows;
    });
    return { id, status: 'stopped', unlinkedBookings };
  }

  /**
   * 「撤销本窗口生成的单」（§21.2，**仅限未被收款的单**）。
   *
   * 把该规则**未来、未收款**的周期单软删并解绑 `recurrence_id`（释放唯一约束），
   * 同时把 `generated_until` 回退到最早被撤销日期的前一天，下一次生成会重新补上。
   */
  async revokeWindow(
    id: number,
    actorId: number,
  ): Promise<{ revoked: number; from: string | null }> {
    await this.findOne(id);
    const timeZone = (await this.config.booking()).timezone;
    const { start } = shopDayRange(shopToday(timeZone), timeZone);
    const candidates = await this.database.db
      .select({
        id: bizBookings.id,
        startAt: bizBookings.startAt,
      })
      .from(bizBookings)
      .where(
        and(
          eq(bizBookings.recurrenceId, id),
          isNull(bizBookings.deletedAt),
          eq(bizBookings.payStatus, 'unpaid'),
          eq(bizBookings.paidAmount, 0),
          eq(bizBookings.refundAmount, 0),
          gte(bizBookings.startAt, start),
          ne(bizBookings.status, 'cancelled'),
        ),
      )
      .orderBy(asc(bizBookings.startAt));
    if (!candidates.length) return { revoked: 0, from: null };

    const first = candidates[0];
    if (!first) return { revoked: 0, from: null };
    const from = shopDateOf(first.startAt, timeZone);
    await this.database.db.transaction(async (tx) => {
      for (const candidate of candidates) {
        await tx
          .update(bizBookings)
          .set({
            deletedAt: new Date(),
            recurrenceId: null,
            updatedBy: actorId,
          })
          .where(
            and(
              eq(bizBookings.id, candidate.id),
              eq(bizBookings.recurrenceId, id),
              eq(bizBookings.paidAmount, 0),
            ),
          );
      }
      await tx
        .update(bizBookingRecurrences)
        .set({ generatedUntil: addLocalDays(from, -1), updatedBy: actorId })
        .where(eq(bizBookingRecurrences.id, id));
    });
    return { revoked: candidates.length, from };
  }

  /* ------------------------------------------------------------------ *
   * 生成（RecurrencePort）
   * ------------------------------------------------------------------ */

  /** 滚动生成（定时任务 `generateRecurringBookings` 用），幂等 */
  async generate(
    recurrenceId?: number,
  ): Promise<{ generated: number; skipped: number }> {
    const result = await this.generateDetailed(recurrenceId);
    return { generated: result.generated, skipped: result.skipped };
  }

  /** 带冲突明细的生成（创建接口 / 手工生成用） */
  async generateDetailed(recurrenceId?: number): Promise<RuleResult> {
    const conditions = andConditions([
      isNull(bizBookingRecurrences.deletedAt),
      eq(bizBookingRecurrences.status, 'active'),
      recurrenceId !== undefined
        ? eq(bizBookingRecurrences.id, recurrenceId)
        : undefined,
    ]);
    const rules = await this.database.db
      .select()
      .from(bizBookingRecurrences)
      .where(conditions)
      .orderBy(asc(bizBookingRecurrences.id));
    const timeZone = (await this.config.booking()).timezone;
    const total: RuleResult = { generated: 0, skipped: 0, conflicts: [] };
    for (const rule of rules) {
      try {
        const result = await this.generateRule(rule, timeZone);
        total.generated += result.generated;
        total.skipped += result.skipped;
        total.conflicts.push(...result.conflicts);
      } catch (error) {
        // 单条规则失败不影响其它规则；通知店员人工补单（§19.2）
        const message = messageOf(error);
        total.skipped += 1;
        this.logger.warn(`周期规则 ${rule.id} 生成失败：${message}`);
        await this.notifyRuleFailure(rule, message);
      }
    }
    return total;
  }

  /* ------------------------------------------------------------------ *
   * 内部实现
   * ------------------------------------------------------------------ */

  private async generateRule(
    rule: RecurrenceRow,
    timeZone: string,
  ): Promise<RuleResult> {
    const today = shopToday(timeZone);
    const cursor = rule.generatedUntil
      ? addLocalDays(rule.generatedUntil, 1)
      : rule.startDate;
    const windowStart = laterOf(laterOf(today, cursor), rule.startDate);
    const windowEnd = earlierOf(
      addLocalDays(today, rule.generateDays),
      rule.endDate,
    );
    if (daysBetween(windowStart, windowEnd) < 0) {
      await this.touchRun(rule.id);
      return { generated: 0, skipped: 0, conflicts: [] };
    }

    // 事务外前置读：项目 / 顾客 / 等级 / 美甲师（§9.5 第 2-3 步的思想）
    const items = await this.serviceItems.requireActiveItems(
      readNumberArray(rule.serviceItemIds),
    );
    const customer = await this.customers.requireById(rule.customerId);
    const staff = await this.staffs.requireActive(rule.staffId);
    const pricing = await this.members.getPricingContext(rule.customerId);
    const memberConfig = await this.config.member();
    const quote = quoteBooking({
      items: items.map(toQuoteItem),
      levelDiscountPermille: pricing.levelDiscountPermille,
      pointsUsed: 0, // 周期单不叠加积分抵扣（§5.9）
      pointsDiscountPerYuan: memberConfig.pointsDiscountPerYuan,
      maxPointsPermille: memberConfig.maxPointsPermille,
    });

    const dates = listLocalDates(windowStart, windowEnd).filter(
      (date) => shopWeekday(date) === rule.weekday,
    );
    const result: RuleResult = { generated: 0, skipped: 0, conflicts: [] };
    for (const date of dates) {
      const startAt = shopLocalToUtc(date, rule.startTime, timeZone);
      const outcome = await this.generateOne({
        rule,
        date,
        startAt,
        timeZone,
        durationMinutes: rule.durationMinutes,
        bufferMinutes: quote.bufferMinutes,
        customerName: customer.name,
        customerPhone: customer.phone,
        staffName: staff.nickname,
        staffUserId: staff.userId,
        quote,
        items,
      });
      if (outcome.kind === 'generated') result.generated += 1;
      else if (outcome.kind === 'skipped') result.skipped += 1;
      else result.skipped += 1; // 已存在 → 跳过（幂等）
      if (outcome.conflict) result.conflicts.push(outcome.conflict);
      if (outcome.logIds.length)
        await this.notices.flushPending(outcome.logIds);
    }

    await this.database.db
      .update(bizBookingRecurrences)
      .set({ generatedUntil: windowEnd, lastRunAt: new Date() })
      .where(eq(bizBookingRecurrences.id, rule.id));
    return result;
  }

  /** 生成单个日期的预约（一个日期一个事务，便于失败重跑） */
  private async generateOne(input: {
    rule: RecurrenceRow;
    date: string;
    startAt: Date;
    timeZone: string;
    durationMinutes: number;
    bufferMinutes: number;
    customerName: string;
    customerPhone: string | null;
    staffName: string;
    staffUserId: number | null;
    quote: QuoteResult;
    items: {
      id: number;
      name: string;
      durationMinutes: number;
      price: number;
    }[];
  }): Promise<{
    kind: 'exists' | 'skipped' | 'generated';
    conflict: RecurrenceConflict | null;
    logIds: number[];
  }> {
    const { rule, date, startAt } = input;
    try {
      return await this.database.db.transaction(async (tx) => {
        // 事务内**第一条**就是带锁的冲突检测（§6.2 硬约束 1）：
        // `findConflicts` 是当前读（`FOR UPDATE`），并会对
        // `idx_booking_staff_time` 的扫描区间加间隙锁，阻止并发插入同段预约。
        const conflictRows = await this.slots.findConflicts(tx, {
          staffId: rule.staffId,
          startAt,
          durationMinutes: input.durationMinutes,
          bufferMinutes: input.bufferMinutes,
        });

        // 幂等①：唯一约束的另一半——插入前先查 (recurrence_id, start_at) 是否已存在
        const [existing] = await tx
          .select({ id: bizBookings.id })
          .from(bizBookings)
          .where(
            and(
              eq(bizBookings.recurrenceId, rule.id),
              eq(bizBookings.startAt, startAt),
            ),
          )
          .limit(1);
        if (existing)
          return { kind: 'exists' as const, conflict: null, logIds: [] };

        const bookingNos = conflictRows.map((row) => row.bookingNo);
        const conflictBase = {
          date,
          startAt: formatShopDateTime(startAt, input.timeZone),
          bookingNos,
        };

        if (conflictRows.length && rule.conflictPolicy === 'skip') {
          const logIds = await this.notifyConflict(
            tx,
            input,
            'skip',
            bookingNos,
          );
          return {
            kind: 'skipped' as const,
            conflict: {
              ...conflictBase,
              policy: 'skip' as const,
              bookingId: null,
            },
            logIds,
          };
        }

        // 周期单不收预付款（§5.9）：pay_status='unpaid'，不建支付单
        const bookingId = await this.insertBooking(
          tx,
          input,
          conflictRows.length > 0,
        );
        const logIds =
          conflictRows.length > 0
            ? await this.notifyConflict(tx, input, 'notify', bookingNos)
            : [];
        return {
          kind: 'generated' as const,
          conflict:
            conflictRows.length > 0
              ? { ...conflictBase, policy: 'notify' as const, bookingId }
              : null,
          logIds,
        };
      });
    } catch (error) {
      // 幂等②：并发/重跑时唯一索引兜底（1062 直接当「已存在」跳过）
      if (isDuplicateKeyError(error))
        return { kind: 'exists', conflict: null, logIds: [] };
      throw error;
    }
  }

  private async insertBooking(
    tx: BizTx,
    input: {
      rule: RecurrenceRow;
      date: string;
      startAt: Date;
      timeZone: string;
      durationMinutes: number;
      bufferMinutes: number;
      customerName: string;
      customerPhone: string | null;
      quote: QuoteResult;
      items: {
        id: number;
        name: string;
        durationMinutes: number;
        price: number;
      }[];
    },
    conflicted: boolean,
  ): Promise<number> {
    const { rule, startAt, quote } = input;
    const endAt = new Date(
      startAt.getTime() + input.durationMinutes * MINUTE_MS,
    );
    const now = new Date();
    const [inserted] = await tx.insert(bizBookings).values({
      // 先占位再回填（主键回填口径），占位值带随机串避免唯一索引互撞
      bookingNo: `T${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      customerId: rule.customerId,
      staffId: rule.staffId,
      startAt,
      endAt,
      durationMinutes: input.durationMinutes,
      bufferMinutes: input.bufferMinutes,
      originalPrice: quote.originalPrice,
      levelDiscountPermille: quote.levelDiscountPermille,
      levelDiscountAmount: quote.levelDiscountAmount,
      pointsDiscountAmount: 0,
      adjustAmount: 0,
      payableAmount: quote.payableAmount,
      depositAmount: 0,
      paidAmount: 0,
      dueAmount: quote.payableAmount,
      payStatus: 'unpaid',
      recurrenceId: rule.id,
      status: 'confirmed',
      channel: 'admin',
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      remark: conflicted
        ? CONFLICT_MARK
        : rule.name
          ? `周期生成：${rule.name}`
          : '周期生成',
      confirmedAt: now,
      createdBy: rule.createdBy,
      updatedBy: rule.createdBy,
    });
    const bookingId = Number(inserted.insertId);
    await tx
      .update(bizBookings)
      .set({ bookingNo: buildDocNo('B', bookingId, input.timeZone) })
      .where(eq(bizBookings.id, bookingId));
    await tx.insert(bizBookingItems).values(
      input.items.map((item, index) => ({
        bookingId,
        serviceItemId: item.id,
        name: item.name,
        durationMinutes: item.durationMinutes,
        price: item.price,
        sort: index,
      })),
    );
    return bookingId;
  }

  /** 冲突通知店员（站内）：`skip` 跳过也记一条，便于人工补单（§19.2） */
  private async notifyConflict(
    tx: BizTx,
    input: {
      rule: RecurrenceRow;
      date: string;
      startAt: Date;
      timeZone: string;
      customerName: string;
      staffName: string;
      staffUserId: number | null;
    },
    policy: 'skip' | 'notify',
    bookingNos: string[],
  ): Promise<number[]> {
    if (input.staffUserId === null) {
      this.logger.warn(
        `周期规则 ${input.rule.id} 时段冲突（${input.date}），但美甲师未绑定后台账号，无法发站内通知`,
      );
      return [];
    }
    return this.notices.enqueueInTx(tx, {
      templateCode: NOTICE_TEMPLATES.recurrenceConflict,
      recipientType: 'user',
      recipientId: input.staffUserId,
      // 变量名与 seed / 前端模板变量口径一致（`shopName` 取自可选的 `biz.shop.name`）
      variables: {
        recurrenceId: input.rule.id,
        customerName: input.customerName,
        staffName: input.staffName,
        shopName: await this.shopName(),
        bookingDate: input.date,
        bookingTime: hhmm(input.rule.startTime),
        policy: policy === 'skip' ? '已跳过' : '已生成并标记待人工处理',
        conflicts: bookingNos.join('、'),
      },
    });
  }

  /** 生成失败通知店员（在事务外调用，用 `send` 而不是 `enqueueInTx`） */
  private async notifyRuleFailure(
    rule: RecurrenceRow,
    reason: string,
  ): Promise<void> {
    try {
      const staff = await this.staffs.requireActive(rule.staffId);
      if (staff.userId === null) return;
      await this.notices.send({
        templateCode: NOTICE_TEMPLATES.recurrenceFailed,
        recipientType: 'user',
        recipientId: staff.userId,
        variables: {
          recurrenceId: rule.id,
          staffName: staff.nickname,
          shopName: await this.shopName(),
          bookingDate: rule.generatedUntil ?? rule.startDate,
          reason,
        },
      });
    } catch (error) {
      this.logger.warn(`周期生成失败通知发送异常：${messageOf(error)}`);
    }
  }

  /** 门店名称：可选配置项 `biz.shop.name`（缺省空串；模板未引用则无影响） */
  private async shopName(): Promise<string> {
    return this.config.getString('biz.shop.name', '');
  }

  private async changeStatus(
    id: number,
    action: 'pause' | 'resume' | 'stop',
    actorId: number,
  ): Promise<{ id: number; status: 'active' | 'paused' | 'stopped' }> {
    const rule = await this.findOne(id);
    if (action === 'stop') {
      if (rule.status !== 'stopped')
        await this.database.db
          .update(bizBookingRecurrences)
          .set({ status: 'stopped', updatedBy: actorId })
          .where(eq(bizBookingRecurrences.id, id));
      return { id, status: 'stopped' };
    }
    if (rule.status === 'stopped')
      throw new ConflictException('规则已停止（终态），不可恢复');
    const status = action === 'pause' ? 'paused' : 'active';
    if (rule.status !== status)
      await this.database.db
        .update(bizBookingRecurrences)
        .set({ status, updatedBy: actorId })
        .where(eq(bizBookingRecurrences.id, id));
    return { id, status };
  }

  private async touchRun(id: number): Promise<void> {
    await this.database.db
      .update(bizBookingRecurrences)
      .set({ lastRunAt: new Date() })
      .where(eq(bizBookingRecurrences.id, id));
  }

  /** 同一美甲师 + 星期几 + 开始时间只允许一条生效规则（§21.1 → 409） */
  private async assertRuleSlotUnique(
    staffId: number,
    weekday: number,
    startTime: string,
    excludeId?: number,
  ): Promise<void> {
    const conditions = [
      eq(bizBookingRecurrences.staffId, staffId),
      eq(bizBookingRecurrences.weekday, weekday),
      eq(bizBookingRecurrences.startTime, normalizeTime(startTime)),
      ne(bizBookingRecurrences.status, 'stopped'),
      isNull(bizBookingRecurrences.deletedAt),
    ];
    if (excludeId !== undefined)
      conditions.push(ne(bizBookingRecurrences.id, excludeId));
    const [duplicate] = await this.database.db
      .select({ id: bizBookingRecurrences.id })
      .from(bizBookingRecurrences)
      .where(and(...conditions))
      .limit(1);
    if (duplicate)
      throw new ConflictException(
        '该美甲师在同一星期几同一开始时间已有周期规则（避免同一时段生成两单）',
      );
  }

  /** 美甲师可做项目校验（§22：空集合 = 可做全部） */
  private async assertStaffCanDo(
    staffId: number,
    itemIds: number[],
  ): Promise<void> {
    const allowed = await this.staffs.allowedServiceItemIds(staffId);
    if (allowed && itemIds.some((id) => !allowed.includes(id)))
      throw new BadRequestException('该美甲师不能做所选项目');
  }
}

function toQuoteItem(item: {
  id: number;
  name: string;
  durationMinutes: number;
  bufferMinutes: number;
  price: number;
}): QuoteItem {
  return {
    serviceItemId: item.id,
    name: item.name,
    durationMinutes: item.durationMinutes,
    bufferMinutes: item.bufferMinutes,
    price: item.price,
  };
}

/** `service_item_ids` 是 JSON 数组，顺序即服务顺序 */
function readNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is number =>
      typeof item === 'number' && Number.isInteger(item),
  );
}

/** `HH:MM` / `HH:MM:SS` 统一成 `HH:MM:SS`（唯一性比较与写库口径） */
function normalizeTime(value: string): string {
  return minutesToTime(timeToMinutes(value));
}

function hhmm(value: string): string {
  return normalizeTime(value).slice(0, 5);
}

/** 较晚的日期（`b` 为空时取 `a`） */
function laterOf(a: string, b: string): string {
  return daysBetween(a, b) >= 0 ? b : a;
}

/**
 * 较早的日期（`b` 为空时取 `a`）。
 *
 * 注意：`daysBetween(a, b) >= 0` 表示 **`b` 不早于 `a`**，此时应返回 `a`。
 * 这里曾经写反（返回了较晚的那个），导致滚动窗口越过 `end_date`，
 * 多生成一期（集成用例「恰好 4 单」实测 5 单时暴露）。
 */
function earlierOf(a: string, b: string | null): string {
  if (!b) return a;
  return daysBetween(a, b) >= 0 ? a : b;
}

/** 规则「下次生成日」：窗口起点里第一个命中星期几的日期 */
function nextGenerateDate(
  rule: {
    status: 'active' | 'paused' | 'stopped';
    weekday: number;
    startDate: string;
    endDate: string | null;
    generatedUntil: string | null;
  },
  today: string,
): string | null {
  if (rule.status !== 'active') return null;
  const cursor = rule.generatedUntil
    ? addLocalDays(rule.generatedUntil, 1)
    : rule.startDate;
  let candidate = laterOf(laterOf(today, cursor), rule.startDate);
  for (let index = 0; index < 7; index += 1) {
    if (rule.endDate && daysBetween(candidate, rule.endDate) < 0) return null;
    if (shopWeekday(candidate) === rule.weekday) return candidate;
    candidate = addLocalDays(candidate, 1);
  }
  return null;
}

/** MySQL 唯一键冲突（`ER_DUP_ENTRY` / errno 1062）兜底幂等 */
function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { errno?: number; code?: string };
  return candidate.errno === 1062 || candidate.code === 'ER_DUP_ENTRY';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
