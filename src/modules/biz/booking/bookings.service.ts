import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { DatabaseService } from '../../../database/database.service';
import {
  bizBookingItems,
  bizBookings,
  bizCustomers,
  bizMemberLevels,
  bizPayments,
  bizStaffs,
  users,
} from '../../../database/schema/index';
import type { RequestActor } from '../../../common/data-scope/data-scope.js';
import { resolveDataScope } from '../../../common/data-scope/data-scope.js';
import { BizConfigService } from '../common/biz-config.service.js';
import { buildDocNo, tempDocNo } from '../common/doc-no.js';
import {
  calcDepositAmount,
  centsToPoints,
  quoteBooking,
  type QuoteResult,
} from '../common/money.js';
import { andConditions, keywordLike, localDateRange } from '../common/query.js';
import { formatShopDateTime, shopDateOf } from '../common/shop-time.js';
import type { BizTx } from '../common/tx.js';
import { withoutUndefined } from '../common/tx.js';
import {
  type BookingItemRow,
  type BookingPayStatus,
  BookingPort,
  type BookingRow,
  type BookingStatus,
  type BookingWithItems,
  CommissionPort,
  CreditPort,
  CustomerPort,
  MemberAccountPort,
  NoticePort,
  type PayChannel,
  PaymentPort,
  RefundPort,
  ServiceItemPort,
  SettlementPort,
  type StaffBookingFilter,
  StaffPort,
} from '../common/ports.js';
import { SlotsService } from './slots.service.js';

/** 状态枚举定义在端口层（app 域要用，且不能 import 业务模块），此处原样导出 */
export type { BookingStatus, BookingPayStatus };

export type PaymentInput = {
  channel: PayChannel;
  amount: number;
  receivedAmount?: number | undefined;
  memberCardId?: number | undefined;
};

export type CreateBookingInput = {
  customerId: number;
  staffId: number;
  startAt: string;
  serviceItemIds: number[];
  payMode: 'full' | 'deposit';
  depositAmount?: number | undefined;
  payments?: PaymentInput[] | undefined;
  pointsUsed?: number | undefined;
  adjustAmount?: number | undefined;
  adjustReason?: string | undefined;
  creditAccountId?: number | undefined;
  remark?: string | undefined;
  force?: boolean | undefined;
};

export type UpdateBookingInput = {
  staffId?: number | undefined;
  startAt?: string | undefined;
  serviceItemIds?: number[] | undefined;
  adjustAmount?: number | undefined;
  adjustReason?: string | undefined;
  remark?: string | undefined;
  force?: boolean | undefined;
};

export type SettleBookingInput = {
  payments?: PaymentInput[] | undefined;
  pointsUsed?: number | undefined;
  creditAccountId?: number | undefined;
  remark?: string | undefined;
};

export type BookingListFilter = {
  date?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  staffId?: number | undefined;
  status?: BookingStatus | undefined;
  payStatus?: BookingPayStatus | undefined;
  customerId?: number | undefined;
  keyword?: string | undefined;
};

/** 动作 → 允许的起始状态（集中一张表，禁止散落在 controller，§7.3） */
const TRANSITIONS = {
  confirm: ['pending'],
  arrive: ['confirmed'],
  complete: ['arrived'],
  'no-show': ['confirmed'],
  cancel: ['pending', 'confirmed'],
} as const satisfies Record<string, readonly BookingStatus[]>;

type TransitionAction = keyof typeof TRANSITIONS;

type TransitionPatch = {
  arrivedAt?: Date;
  cancelReason?: string;
  cancelledAt?: Date;
  confirmedAt?: Date;
};

type BookingScope =
  | { kind: 'all' }
  | { kind: 'self' }
  | { kind: 'staff'; staffId: number }
  | { kind: 'deptIds'; ids: number[] };

type QuoteItem = {
  id: number;
  name: string;
  durationMinutes: number;
  bufferMinutes: number;
  price: number;
};

/**
 * 预约主链路。
 *
 * 创建走 §9.5 的九步（顺序不可调换），改期 / 改美甲师 / 改项目走 §6.3 的
 * 「锁 + 复检」。金额字段一律交给 `BookingSettlementService.recalc()`，
 * 本服务不自己写 `paid_amount` / `due_amount` / `pay_status`。
 */
@Injectable()
export class BookingsService implements BookingPort {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: BizConfigService,
    private readonly slots: SlotsService,
    private readonly customers: CustomerPort,
    private readonly staffs: StaffPort,
    private readonly serviceItems: ServiceItemPort,
    private readonly members: MemberAccountPort,
    private readonly payments: PaymentPort,
    private readonly credit: CreditPort,
    private readonly settlement: SettlementPort,
    private readonly refunds: RefundPort,
    private readonly notices: NoticePort,
    private readonly commissions: CommissionPort,
  ) {}

  /* ---------------------------------------------------------------- *
   * 查询
   * ---------------------------------------------------------------- */

  async availableSlots(
    input: {
      staffId: number;
      date: string;
      serviceItemIds: number[];
      channel?: 'admin' | 'miniapp' | undefined;
    },
    actor: RequestActor,
  ) {
    await this.assertStaffVisible(input.staffId, actor);
    return this.slots.availableSlots({
      staffId: input.staffId,
      date: input.date,
      serviceItemIds: input.serviceItemIds,
      channel: input.channel ?? 'admin',
    });
  }

  async list(
    page: number,
    pageSize: number,
    filter: BookingListFilter,
    actor: RequestActor,
  ) {
    const bookingConfig = await this.config.booking();
    const scope = await this.resolveScope(actor);
    const where = andConditions([
      isNull(bizBookings.deletedAt),
      filter.staffId ? eq(bizBookings.staffId, filter.staffId) : undefined,
      filter.status ? eq(bizBookings.status, filter.status) : undefined,
      filter.payStatus
        ? eq(bizBookings.payStatus, filter.payStatus)
        : undefined,
      filter.customerId
        ? eq(bizBookings.customerId, filter.customerId)
        : undefined,
      filter.date
        ? localDateRange(
            bizBookings.startAt,
            filter.date,
            filter.date,
            bookingConfig.timezone,
          )
        : localDateRange(
            bizBookings.startAt,
            filter.dateFrom,
            filter.dateTo,
            bookingConfig.timezone,
          ),
      filter.keyword
        ? or(
            keywordLike(bizBookings.bookingNo, filter.keyword),
            keywordLike(bizBookings.customerName, filter.keyword),
            keywordLike(bizBookings.customerPhone, filter.keyword),
          )
        : undefined,
      ...(await this.scopeConditions(scope, actor)),
    ]);
    const rows = await this.database.db
      .select({ booking: bizBookings, staffName: bizStaffs.nickname })
      .from(bizBookings)
      .leftJoin(bizStaffs, eq(bizBookings.staffId, bizStaffs.id))
      .where(where)
      .orderBy(desc(bizBookings.startAt), desc(bizBookings.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return {
      items: rows.map((row) => ({ ...row.booking, staffName: row.staffName })),
      page,
      pageSize,
    };
  }

  async findOne(id: number, actor?: RequestActor) {
    const [row] = await this.database.db
      .select({ booking: bizBookings, staffName: bizStaffs.nickname })
      .from(bizBookings)
      .leftJoin(bizStaffs, eq(bizBookings.staffId, bizStaffs.id))
      .where(and(eq(bizBookings.id, id), isNull(bizBookings.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundException('预约不存在');
    if (actor) await this.assertBookingVisible(row.booking, actor);
    const items = await this.database.db
      .select()
      .from(bizBookingItems)
      .where(eq(bizBookingItems.bookingId, id))
      .orderBy(asc(bizBookingItems.sort), asc(bizBookingItems.id));
    const payments = await this.database.db
      .select()
      .from(bizPayments)
      .where(eq(bizPayments.bookingId, id))
      .orderBy(asc(bizPayments.id));
    return { ...row.booking, staffName: row.staffName, items, payments };
  }

  /** 创建弹窗展示顾客时的账务摘要 */
  async customerBrief(customerId: number) {
    const [row] = await this.database.db
      .select({
        id: bizCustomers.id,
        name: bizCustomers.name,
        phone: bizCustomers.phone,
        levelId: bizCustomers.levelId,
        levelName: bizMemberLevels.name,
        discountPermille: bizMemberLevels.discountPermille,
        points: bizCustomers.points,
        balancePrincipal: bizCustomers.balancePrincipal,
        balanceBonus: bizCustomers.balanceBonus,
      })
      .from(bizCustomers)
      .leftJoin(bizMemberLevels, eq(bizCustomers.levelId, bizMemberLevels.id))
      .where(
        and(eq(bizCustomers.id, customerId), isNull(bizCustomers.deletedAt)),
      )
      .limit(1);
    if (!row) throw new NotFoundException('顾客不存在');
    return row;
  }

  /* ---------------------------------------------------------------- *
   * app 域（小程序）端口实现（S3 读 / S4 写）
   *
   * 与后台方法的差别：**不做 admin 数据权限收敛**，改成硬限定「本人」。
   * 后台那个 `resolveScope` 走的是角色 / 部门，小程序端没有 sys_user，
   * 套上去只会得到错的范围。
   * ---------------------------------------------------------------- */

  async listByStaff(
    staffId: number,
    page: number,
    pageSize: number,
    filter: StaffBookingFilter,
  ): Promise<{ items: BookingWithItems[]; page: number; pageSize: number }> {
    const rows = await this.selectByScope(
      eq(bizBookings.staffId, staffId),
      filter,
      page,
      pageSize,
    );
    return { items: await this.attachItems(rows), page, pageSize };
  }

  async listByCustomer(
    customerId: number,
    page: number,
    pageSize: number,
  ): Promise<{ items: BookingWithItems[]; page: number; pageSize: number }> {
    const rows = await this.selectByScope(
      eq(bizBookings.customerId, customerId),
      {},
      page,
      pageSize,
    );
    return { items: await this.attachItems(rows), page, pageSize };
  }

  async arriveForStaff(
    id: number,
    staffId: number,
    actorId?: number | null,
  ): Promise<{ changed: boolean }> {
    const booking = await this.assertOwnedByStaff(id, staffId);
    if (booking.status === 'arrived') return { changed: false };
    return this.transition(id, 'arrived', 'arrive', actorId ?? null, {
      arrivedAt: new Date(),
    });
  }

  async completeForStaff(
    id: number,
    staffId: number,
    actorId?: number | null,
  ): Promise<{ changed: boolean; warning?: string | undefined }> {
    const booking = await this.assertOwnedByStaff(id, staffId);
    if (booking.status === 'completed') return { changed: false };
    // §12.4-3 时间护栏：早于 start_at 标记完成 = 可以提前刷提成
    if (booking.startAt.getTime() > Date.now())
      throw new BadRequestException('服务尚未开始，不能提前标记完成');
    return this.runComplete(id, actorId ?? null);
  }

  /* ---------------------------------------------------------------- *
   * 创建（§9.5 九步）
   * ---------------------------------------------------------------- */

  async create(input: CreateBookingInput, actor: RequestActor) {
    const bookingConfig = await this.config.booking();
    const tz = bookingConfig.timezone;

    // ---- 步骤 2：前置校验全部在事务外（FOR UPDATE 之前不能有普通 SELECT 建立 RR 快照）----
    const customer = await this.customers.requireById(input.customerId);
    await this.staffs.requireActive(input.staffId);
    const itemIds = [...new Set(input.serviceItemIds)];
    if (itemIds.length < 1 || itemIds.length > 3)
      throw new BadRequestException('服务项目需选择 1~3 个');
    const items = await this.serviceItems.requireActiveItems(itemIds);
    await this.assertStaffCanDo(input.staffId, itemIds);

    const startAt = parseIsoWithOffset(input.startAt);
    const date = shopDateOf(startAt, tz);
    const durationMinutes = sumOf(items, (item) => item.durationMinutes);
    const bufferMinutes = Math.max(
      ...items.map((item) => item.bufferMinutes),
      0,
    );
    await this.slots.assertGridAligned(startAt, date, tz);
    await this.slots.assertLeadTime(startAt, 'admin');
    await this.slots.assertWithinShift({
      staffId: input.staffId,
      date,
      startAt,
      durationMinutes,
      timeZone: tz,
    });

    const adjustAmount = Math.trunc(input.adjustAmount ?? 0);
    this.assertAdjustAllowed(adjustAmount, input.adjustReason, actor);

    const payments = input.payments ?? [];
    const creditPayments = payments.filter(
      (payment) => payment.channel === 'credit',
    );
    const realPayments = payments.filter(
      (payment) => payment.channel !== 'credit',
    );
    if (creditPayments.length && !input.creditAccountId)
      throw new BadRequestException('挂账必须指定挂账主体');
    for (const payment of realPayments) {
      if (payment.amount < 0) throw new BadRequestException('收款金额不能为负');
      if (payment.channel === 'card' && !payment.memberCardId)
        throw new BadRequestException('次卡核销必须选择次卡');
    }
    const cardPayment = realPayments.find(
      (payment) => payment.channel === 'card',
    );

    // ---- 步骤 3：算价（等级折扣 → 积分抵扣 → 改价 → 应付 → 定金）----
    const memberConfig = await this.config.member();
    const pricing = await this.members.getPricingContext(customer.id);
    const quote = this.buildQuote({
      items,
      levelDiscountPermille: pricing.levelDiscountPermille,
      pointsUsed: input.pointsUsed,
      memberConfig,
      adjustAmount,
      useCard: Boolean(cardPayment),
    });
    const depositAmount = calcDepositAmount(
      quote.payableAmount,
      input.payMode,
      input.depositAmount,
      bookingConfig.depositPermille,
    );
    const inputTotal = payments.reduce(
      (total, payment) => total + payment.amount,
      0,
    );
    if (inputTotal > depositAmount)
      throw new BadRequestException('收款金额超过下单应收金额');
    if (inputTotal < depositAmount && input.payMode === 'full')
      throw new BadRequestException(
        '全款模式必须收清；挂账请显式添加 channel=credit 的收款项',
      );

    // 顾客侧冲突（软检查，force=true 可覆盖）
    const overlaps = await this.slots.findCustomerOverlaps({
      customerId: customer.id,
      startAt,
      durationMinutes,
    });
    if (overlaps.length && !input.force) {
      throw new ConflictException({
        message: '该顾客此时段已有预约，确认重复录入请带 force=true',
        conflicts: overlaps.map((row) => ({
          id: row.id,
          bookingNo: row.bookingNo,
          startAt: formatShopDateTime(row.startAt, tz),
          endAt: formatShopDateTime(row.endAt, tz),
        })),
      });
    }

    // ---- 步骤 5~8：锁 → 复检 → 建单 → 收款（同一事务，一起提交或一起回滚）----
    const created = await this.database.db.transaction(async (tx) => {
      // 步骤 5：必须是事务内第一条语句
      await this.slots.lockStaffRow(tx, input.staffId);
      // 步骤 6：冲突复检（查询带 FOR UPDATE，当前读）
      await this.slots.assertNoConflict(tx, {
        staffId: input.staffId,
        startAt,
        durationMinutes,
        bufferMinutes,
      });

      // 步骤 7：建单 + 明细，拿 insertId 回填正式单号
      const inserted = await tx.insert(bizBookings).values({
        bookingNo: tempDocNo(),
        customerId: customer.id,
        staffId: input.staffId,
        startAt,
        endAt: new Date(startAt.getTime() + durationMinutes * 60_000),
        durationMinutes,
        bufferMinutes,
        originalPrice: quote.originalPrice,
        levelDiscountPermille: quote.levelDiscountPermille,
        levelDiscountAmount: quote.levelDiscountAmount,
        pointsDiscountAmount: quote.pointsDiscountAmount,
        adjustAmount: quote.adjustAmount,
        adjustReason: input.adjustReason ?? null,
        payableAmount: quote.payableAmount,
        depositAmount,
        paidAmount: 0,
        dueAmount: quote.payableAmount,
        payStatus: 'unpaid',
        creditAccountId: input.creditAccountId ?? null,
        memberCardId: cardPayment?.memberCardId ?? null,
        status: 'confirmed',
        channel: 'admin',
        customerName: customer.name,
        customerPhone: customer.phone,
        remark: input.remark ?? null,
        confirmedAt: new Date(),
        createdBy: actor.id,
        updatedBy: actor.id,
      });
      const bookingId = Number(inserted[0].insertId);
      const bookingNo = buildDocNo('B', bookingId, tz, new Date());
      await tx
        .update(bizBookings)
        .set({ bookingNo })
        .where(eq(bizBookings.id, bookingId));
      await tx.insert(bizBookingItems).values(
        items.map((item, index) => ({
          bookingId,
          serviceItemId: item.id,
          name: item.name,
          durationMinutes: item.durationMinutes,
          price: item.price,
          sort: index,
        })),
      );

      // 步骤 8：收款（锁顺序 staff → customer → payment）
      if (quote.pointsUsed > 0) {
        await this.members.deductPoints(tx, {
          customerId: customer.id,
          points: quote.pointsUsed,
          bookingId,
          type: 'points_spend',
          remark: `预约 ${bookingNo} 积分抵扣`,
          actorId: actor.id,
        });
      }
      const outcomes = [];
      for (const payment of realPayments) {
        outcomes.push(
          await this.payments.createInTx(
            tx,
            {
              customerId: customer.id,
              bookingId,
              purpose: input.payMode === 'deposit' ? 'deposit' : 'final',
              channel: payment.channel,
              amount: payment.amount,
              receivedAmount: payment.receivedAmount,
              memberCardId: payment.memberCardId ?? null,
              remark: `预约 ${bookingNo}`,
            },
            actor.id,
          ),
        );
      }
      for (const payment of creditPayments) {
        await this.credit.createFromBooking(tx, {
          creditAccountId: input.creditAccountId as number,
          bookingId,
          customerId: customer.id,
          amount: payment.amount,
          actorId: actor.id,
        });
      }
      const settlement = await this.settlement.recalc(tx, bookingId);
      const receivedNow = receivedAmountOf(outcomes);
      if (receivedNow > 0) {
        await this.members.recordConsumption(tx, {
          customerId: customer.id,
          paidAmount: receivedNow,
          bookingId,
          payChannel: await this.dominantChannel(tx, bookingId),
          remark: `预约 ${bookingNo} 消费`,
          actorId: actor.id,
        });
      }
      return { bookingId, bookingNo, outcomes, settlement };
    });

    // ---- 步骤 9：提交事务后才发通知（失败不回滚业务）----
    void this.notices
      .send({
        templateCode: 'booking_created',
        recipientType: 'customer',
        recipientId: customer.id,
        variables: {
          customerName: customer.name,
          bookingDate: shopDateOf(startAt, tz),
          bookingTime: formatShopDateTime(startAt, tz).slice(11, 16),
          amount: (quote.payableAmount / 100).toFixed(2),
        },
        bookingId: created.bookingId,
      })
      .catch(() => undefined);

    return {
      id: created.bookingId,
      bookingNo: created.bookingNo,
      startAt: formatShopDateTime(startAt, tz),
      endAt: formatShopDateTime(
        new Date(startAt.getTime() + durationMinutes * 60_000),
        tz,
      ),
      status: 'confirmed' as BookingStatus,
      durationMinutes,
      bufferMinutes,
      originalPrice: quote.originalPrice,
      levelDiscountAmount: quote.levelDiscountAmount,
      pointsDiscountAmount: quote.pointsDiscountAmount,
      pointsUsed: quote.pointsUsed,
      adjustAmount: quote.adjustAmount,
      payableAmount: quote.payableAmount,
      depositAmount,
      paidAmount: created.settlement.paidAmount,
      dueAmount: created.settlement.dueAmount,
      payStatus: created.settlement.payStatus,
      payChannelSummary: created.settlement.channelSummary,
      payments: created.outcomes,
    };
  }

  /* ---------------------------------------------------------------- *
   * 改期 / 改美甲师 / 改项目（§6.3：凡改变 start_at/end_at/staff_id/项目组合都走锁 + 复检）
   * ---------------------------------------------------------------- */

  async update(id: number, input: UpdateBookingInput, actor: RequestActor) {
    const bookingConfig = await this.config.booking();
    const tz = bookingConfig.timezone;
    const current = await this.findOne(id, actor);
    if (!['pending', 'confirmed'].includes(current.status))
      throw new ConflictException('仅待确认 / 已确认的预约可改期');

    const staffId = input.staffId ?? current.staffId;
    await this.staffs.requireActive(staffId);
    const itemIds = [
      ...new Set(
        input.serviceItemIds ?? current.items.map((item) => item.serviceItemId),
      ),
    ];
    const items = await this.serviceItems.requireActiveItems(itemIds);
    await this.assertStaffCanDo(staffId, itemIds);

    const startAt = input.startAt
      ? parseIsoWithOffset(input.startAt)
      : current.startAt;
    const date = shopDateOf(startAt, tz);
    const durationMinutes = sumOf(items, (item) => item.durationMinutes);
    const bufferMinutes = Math.max(
      ...items.map((item) => item.bufferMinutes),
      0,
    );
    await this.slots.assertGridAligned(startAt, date, tz);
    await this.slots.assertWithinShift({
      staffId,
      date,
      startAt,
      durationMinutes,
      timeZone: tz,
    });

    const adjustAmount =
      input.adjustAmount === undefined
        ? current.adjustAmount
        : Math.trunc(input.adjustAmount);
    this.assertAdjustAllowed(adjustAmount, input.adjustReason, actor);

    const memberConfig = await this.config.member();
    const quote = this.buildQuote({
      items,
      levelDiscountPermille: current.levelDiscountPermille,
      pointsUsed: centsToPoints(
        current.pointsDiscountAmount,
        memberConfig.pointsDiscountPerYuan,
      ),
      memberConfig,
      adjustAmount,
      useCard: current.memberCardId !== null,
    });

    const overlaps = await this.slots.findCustomerOverlaps({
      customerId: current.customerId,
      startAt,
      durationMinutes,
      excludeBookingId: id,
    });
    if (overlaps.length && !input.force) {
      throw new ConflictException({
        message: '该顾客此时段已有其它预约，确认重复录入请带 force=true',
        conflicts: overlaps.map((row) => ({
          id: row.id,
          bookingNo: row.bookingNo,
          startAt: formatShopDateTime(row.startAt, tz),
          endAt: formatShopDateTime(row.endAt, tz),
        })),
      });
    }

    const settlement = await this.database.db.transaction(async (tx) => {
      // 同类多行按 id 升序加锁（新旧美甲师都锁，防死锁，§6.6 锁顺序）
      const staffIds = [...new Set([staffId, current.staffId])].sort(
        (a, b) => a - b,
      );
      await tx
        .select({ id: bizStaffs.id })
        .from(bizStaffs)
        .where(inArray(bizStaffs.id, staffIds))
        .orderBy(asc(bizStaffs.id))
        .for('update');
      await this.slots.assertNoConflict(tx, {
        staffId,
        startAt,
        durationMinutes,
        bufferMinutes,
        excludeBookingId: id,
      });
      await tx
        .update(bizBookings)
        .set({
          staffId,
          startAt,
          endAt: new Date(startAt.getTime() + durationMinutes * 60_000),
          durationMinutes,
          bufferMinutes,
          originalPrice: quote.originalPrice,
          levelDiscountAmount: quote.levelDiscountAmount,
          pointsDiscountAmount: quote.pointsDiscountAmount,
          payableAmount: quote.payableAmount,
          adjustAmount: quote.adjustAmount,
          ...withoutUndefined({
            adjustReason: input.adjustReason,
            remark: input.remark,
          }),
          updatedBy: actor.id,
        })
        .where(and(eq(bizBookings.id, id), isNull(bizBookings.deletedAt)));
      await tx.delete(bizBookingItems).where(eq(bizBookingItems.bookingId, id));
      await tx.insert(bizBookingItems).values(
        items.map((item, index) => ({
          bookingId: id,
          serviceItemId: item.id,
          name: item.name,
          durationMinutes: item.durationMinutes,
          price: item.price,
          sort: index,
        })),
      );
      return this.settlement.recalc(tx, id);
    });

    // 差额不做补收：已收 > 新应付时提示走退款单（§15.6）
    const warning =
      settlement.paidAmount > quote.payableAmount
        ? '已收金额超过新的应付金额，差额请到「退款审批」发起退款（不做差额补收）'
        : undefined;
    return { ...settlement, payableAmount: quote.payableAmount, warning };
  }

  /* ---------------------------------------------------------------- *
   * 状态流转（独立动作端点 + 独立权限点）
   * ---------------------------------------------------------------- */

  async confirm(id: number, actor: RequestActor) {
    return this.transition(id, 'confirmed', 'confirm', actor.id, {
      confirmedAt: new Date(),
    });
  }

  async arrive(id: number, actor: RequestActor) {
    return this.transition(id, 'arrived', 'arrive', actor.id, {
      arrivedAt: new Date(),
    });
  }

  async complete(id: number, actor: RequestActor) {
    return this.runComplete(id, actor.id);
  }

  /**
   * 完成动作的唯一实现（后台与小程序共用）。
   *
   * `actorId` 可为 null：小程序端没有 sys_user 账号，`updated_by` 记 null。
   * 提成计提 / 顾客到店次数 / `affectedRows` 幂等闸门全在这里，
   * 任何调用方（含 app 域）都必须走它，禁止自己 UPDATE 状态（§12.4-1）。
   */
  private async runComplete(
    id: number,
    actorId: number | null,
  ): Promise<{ changed: boolean; warning?: string | undefined }> {
    const outcome = await this.database.db.transaction(async (tx) => {
      const booking = await this.lockBooking(tx, id);
      this.assertTransition(booking.status, 'complete');
      const affected = await tx
        .update(bizBookings)
        .set({
          status: 'completed',
          finishedAt: new Date(),
          updatedBy: actorId,
        })
        .where(
          and(
            eq(bizBookings.id, id),
            eq(bizBookings.status, 'arrived'),
            isNull(bizBookings.deletedAt),
          ),
        );
      // affectedRows=0 → 别人已经改过，直接跳过，统计不双计
      if (!affected[0].affectedRows) return null;
      await this.customers.onBookingCompleted(tx, booking.customerId);
      await this.commissions.accrueForBooking(tx, id, actorId);
      return booking;
    });
    if (!outcome) return { changed: false };
    void this.notices
      .send({
        templateCode: 'booking_completed',
        recipientType: 'customer',
        recipientId: outcome.customerId,
        variables: { customerName: outcome.customerName },
        bookingId: id,
      })
      .catch(() => undefined);
    return {
      changed: true,
      warning:
        outcome.payStatus === 'paid' ? undefined : '尾款未结清，请到收银台催收',
    };
  }

  async noShow(id: number, reason: string, actor: RequestActor) {
    if (!reason?.trim()) throw new BadRequestException('爽约必须填写原因');
    return this.transition(id, 'no_show', 'no-show', actor.id, {
      cancelReason: reason,
      cancelledAt: new Date(),
    });
  }

  async cancel(id: number, reason: string, actor: RequestActor) {
    if (!reason?.trim()) throw new BadRequestException('取消必须填写原因');
    const booking = await this.findOne(id, actor);
    const result = await this.transition(id, 'cancelled', 'cancel', actor.id, {
      cancelReason: reason,
      cancelledAt: new Date(),
    });
    if (result.changed) {
      await this.database.db
        .transaction((tx) =>
          this.commissions.reverseForBooking(tx, id, reason, actor.id),
        )
        .catch(() => undefined);
    }
    return {
      ...result,
      warning:
        booking.paidAmount > 0
          ? '该预约有实收，请到「退款审批」发起退款（系统不会自动退）'
          : undefined,
    };
  }

  async remove(id: number, actor: RequestActor) {
    const booking = await this.findOne(id, actor);
    if (booking.paidAmount > 0)
      throw new ConflictException('该预约已有实收，必须先完成退款流程才能删除');
    await this.database.db
      .update(bizBookings)
      .set({ deletedAt: new Date(), updatedBy: actor.id })
      .where(and(eq(bizBookings.id, id), isNull(bizBookings.deletedAt)));
  }

  /* ---------------------------------------------------------------- *
   * 结算尾款 / 挂账 / 补收（§17.2）
   * ---------------------------------------------------------------- */

  async settle(id: number, input: SettleBookingInput, actor: RequestActor) {
    const booking = await this.findOne(id, actor);
    if (['cancelled', 'no_show'].includes(booking.status))
      throw new ConflictException('已取消 / 爽约的预约不能结算');

    const memberConfig = await this.config.member();
    const previousPoints = centsToPoints(
      booking.pointsDiscountAmount,
      memberConfig.pointsDiscountPerYuan,
    );
    const requestedPoints =
      input.pointsUsed === undefined
        ? previousPoints
        : Math.max(Math.trunc(input.pointsUsed), 0);
    if (requestedPoints < previousPoints)
      throw new BadRequestException(
        '结算时只能增加积分抵扣，不能减少（减少需走冲正流程）',
      );

    const items = await this.serviceItems.requireActiveItems(
      booking.items.map((item) => item.serviceItemId),
    );
    const quote = this.buildQuote({
      items,
      levelDiscountPermille: booking.levelDiscountPermille,
      pointsUsed: requestedPoints,
      memberConfig,
      adjustAmount: booking.adjustAmount,
      useCard: booking.memberCardId !== null,
    });

    const payments = input.payments ?? [];
    const creditPayments = payments.filter(
      (payment) => payment.channel === 'credit',
    );
    const realPayments = payments.filter(
      (payment) => payment.channel !== 'credit',
    );
    if (creditPayments.length && !input.creditAccountId)
      throw new BadRequestException('挂账必须指定挂账主体');
    for (const payment of realPayments) {
      if (payment.channel === 'card' && !payment.memberCardId)
        throw new BadRequestException('次卡核销必须选择次卡');
    }

    const dueAmount = Math.max(quote.payableAmount - booking.paidAmount, 0);
    const inputTotal = payments.reduce(
      (total, payment) => total + payment.amount,
      0,
    );
    if (inputTotal > dueAmount)
      throw new BadRequestException('收款金额超过待收尾款');

    const result = await this.database.db.transaction(async (tx) => {
      // 锁顺序：customer → payment（本操作不改时段，无需锁美甲师）
      await this.members.lockAccount(tx, booking.customerId);
      const additionalPoints = quote.pointsUsed - previousPoints;
      if (additionalPoints > 0) {
        await this.members.deductPoints(tx, {
          customerId: booking.customerId,
          points: additionalPoints,
          bookingId: id,
          type: 'points_spend',
          remark: `预约 ${booking.bookingNo} 结算追加积分抵扣`,
          actorId: actor.id,
        });
      }
      await tx
        .update(bizBookings)
        .set({
          pointsDiscountAmount: quote.pointsDiscountAmount,
          payableAmount: quote.payableAmount,
          updatedBy: actor.id,
        })
        .where(eq(bizBookings.id, id));

      const outcomes = [];
      for (const payment of realPayments) {
        outcomes.push(
          await this.payments.createInTx(
            tx,
            {
              customerId: booking.customerId,
              bookingId: id,
              purpose: 'final',
              channel: payment.channel,
              amount: payment.amount,
              receivedAmount: payment.receivedAmount,
              memberCardId: payment.memberCardId ?? null,
              remark: `预约 ${booking.bookingNo} 结算`,
            },
            actor.id,
          ),
        );
      }
      for (const payment of creditPayments) {
        await this.credit.createFromBooking(tx, {
          creditAccountId: input.creditAccountId as number,
          bookingId: id,
          customerId: booking.customerId,
          amount: payment.amount,
          actorId: actor.id,
        });
      }
      const settlement = await this.settlement.recalc(tx, id);
      const receivedNow = receivedAmountOf(outcomes);
      if (receivedNow > 0) {
        await this.members.recordConsumption(tx, {
          customerId: booking.customerId,
          paidAmount: receivedNow,
          bookingId: id,
          payChannel: await this.dominantChannel(tx, id),
          remark: `预约 ${booking.bookingNo} 结算消费`,
          actorId: actor.id,
        });
      }
      return { settlement, outcomes };
    });

    return {
      ...result.settlement,
      payableAmount: quote.payableAmount,
      payments: result.outcomes,
    };
  }

  /** 发起退款（§17.4：判责 + 申请/审批分离，本方法只负责「申请」） */
  async applyRefund(
    id: number,
    input: {
      amount?: number | undefined;
      mode: 'original' | 'cash' | 'balance';
      reason: string;
      liable?: 'store' | 'customer' | 'force_majeure' | undefined;
      remark?: string | undefined;
    },
    actor: RequestActor,
  ) {
    await this.findOne(id, actor);
    return this.refunds.apply(
      {
        bookingId: id,
        amount: input.amount,
        mode: input.mode,
        reason: input.reason,
        liable: input.liable,
        remark: input.remark,
      },
      actor.id,
    );
  }

  async refundPreview(id: number, actor: RequestActor) {
    await this.findOne(id, actor);
    return this.refunds.preview({ bookingId: id });
  }

  /* ---------------------------------------------------------------- *
   * 定时任务入口（§11）——只改状态，**不碰钱**
   * ---------------------------------------------------------------- */

  /** `status='arrived'` 且 `end_at < now` → `completed`（幂等：条件更新 + affectedRows 闸门） */
  async autoCompleteExpired(): Promise<{ completed: number }> {
    const rows = await this.database.db
      .select({ id: bizBookings.id })
      .from(bizBookings)
      .where(
        and(
          eq(bizBookings.status, 'arrived'),
          isNull(bizBookings.deletedAt),
          lt(bizBookings.endAt, new Date()),
        ),
      );
    let completed = 0;
    for (const row of rows) {
      const changed = await this.database.db.transaction(async (tx) => {
        const booking = await this.lockBooking(tx, row.id);
        if (booking.status !== 'arrived') return false;
        const affected = await tx
          .update(bizBookings)
          .set({ status: 'completed', finishedAt: booking.endAt })
          .where(
            and(eq(bizBookings.id, row.id), eq(bizBookings.status, 'arrived')),
          );
        if (!affected[0].affectedRows) return false;
        await this.customers.onBookingCompleted(tx, booking.customerId);
        await this.commissions.accrueForBooking(tx, row.id);
        return true;
      });
      if (changed) completed += 1;
    }
    return { completed };
  }

  /** `status='confirmed'` 且 `start_at + 容忍期 < now` → `no_show`（容忍期是配置项） */
  async autoNoShowExpired(): Promise<{ noShow: number }> {
    const bookingConfig = await this.config.booking();
    const boundary = new Date(
      Date.now() - bookingConfig.noShowGraceMinutes * 60_000,
    );
    const affected = await this.database.db
      .update(bizBookings)
      .set({ status: 'no_show', cancelledAt: new Date() })
      .where(
        and(
          eq(bizBookings.status, 'confirmed'),
          isNull(bizBookings.deletedAt),
          lt(bizBookings.startAt, boundary),
        ),
      );
    return { noShow: affected[0].affectedRows ?? 0 };
  }

  /** 对账修复：按明细重算时长 / 结束时间，并按支付单重算金额（§9.5 的 recount 入口） */
  async recount(id: number, actor: RequestActor) {
    const booking = await this.findOne(id, actor);
    const items = await this.serviceItems.requireActiveItems(
      booking.items.map((item) => item.serviceItemId),
    );
    const durationMinutes = sumOf(items, (item) => item.durationMinutes);
    const bufferMinutes = Math.max(
      ...items.map((item) => item.bufferMinutes),
      0,
    );
    return this.database.db.transaction(async (tx) => {
      await tx
        .update(bizBookings)
        .set({
          durationMinutes,
          bufferMinutes,
          endAt: new Date(booking.startAt.getTime() + durationMinutes * 60_000),
          updatedBy: actor.id,
        })
        .where(eq(bizBookings.id, id));
      return this.settlement.recalc(tx, id);
    });
  }

  /* ---------------------------------------------------------------- *
   * 内部
   * ---------------------------------------------------------------- */

  private async transition(
    id: number,
    target: BookingStatus,
    action: TransitionAction,
    /** null = 非后台来源（小程序端没有 sys_user） */
    actorId: number | null,
    extra: TransitionPatch,
  ): Promise<{ changed: boolean }> {
    const allowed = TRANSITIONS[action];
    const affected = await this.database.db
      .update(bizBookings)
      .set({ status: target, updatedBy: actorId, ...extra })
      .where(
        and(
          eq(bizBookings.id, id),
          inArray(bizBookings.status, [...allowed]),
          isNull(bizBookings.deletedAt),
        ),
      );
    if (!affected[0].affectedRows) {
      const [exists] = await this.database.db
        .select({ status: bizBookings.status })
        .from(bizBookings)
        .where(and(eq(bizBookings.id, id), isNull(bizBookings.deletedAt)))
        .limit(1);
      if (!exists) throw new NotFoundException('预约不存在');
      throw new ConflictException(`当前状态（${exists.status}）不允许该操作`);
    }
    return { changed: true };
  }

  private assertTransition(
    from: BookingStatus,
    action: TransitionAction,
  ): void {
    const allowed = TRANSITIONS[action] as readonly BookingStatus[];
    if (!allowed.includes(from))
      throw new ConflictException(`当前状态（${from}）不允许该操作`);
  }

  /** app 域列表：按「本人」硬限定 + 本地日区间，不做 admin 数据权限收敛 */
  private async selectByScope(
    ownerCondition: SQL,
    filter: StaffBookingFilter,
    page: number,
    pageSize: number,
  ) {
    const bookingConfig = await this.config.booking();
    const where = andConditions([
      isNull(bizBookings.deletedAt),
      ownerCondition,
      filter.status ? eq(bizBookings.status, filter.status) : undefined,
      filter.date
        ? localDateRange(
            bizBookings.startAt,
            filter.date,
            filter.date,
            bookingConfig.timezone,
          )
        : localDateRange(
            bizBookings.startAt,
            filter.dateFrom,
            filter.dateTo,
            bookingConfig.timezone,
          ),
    ]);
    return this.database.db
      .select()
      .from(bizBookings)
      .where(where)
      .orderBy(asc(bizBookings.startAt), asc(bizBookings.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
  }

  /** 批量补项目明细快照（一次查询，避免 N+1） */
  private async attachItems(rows: BookingRow[]): Promise<BookingWithItems[]> {
    if (!rows.length) return [];
    const items = await this.database.db
      .select()
      .from(bizBookingItems)
      .where(
        inArray(
          bizBookingItems.bookingId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(asc(bizBookingItems.sort), asc(bizBookingItems.id));
    const grouped = new Map<number, BookingItemRow[]>();
    for (const item of items) {
      const list = grouped.get(item.bookingId) ?? [];
      list.push(item);
      grouped.set(item.bookingId, list);
    }
    return rows.map((row) => ({ ...row, items: grouped.get(row.id) ?? [] }));
  }

  /**
   * S4 越权闸门：预约不存在 → 404；不属于该美甲师 → 403。
   *
   * 注意这里**不复用** `assertBookingVisible` —— 那是 admin 的角色/部门口径，
   * 小程序端传不出 `RequestActor`。
   */
  private async assertOwnedByStaff(id: number, staffId: number) {
    const [row] = await this.database.db
      .select({
        id: bizBookings.id,
        staffId: bizBookings.staffId,
        startAt: bizBookings.startAt,
        status: bizBookings.status,
      })
      .from(bizBookings)
      .where(and(eq(bizBookings.id, id), isNull(bizBookings.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundException('预约不存在');
    if (row.staffId !== staffId)
      throw new ForbiddenException('只能操作本人的预约');
    return row;
  }

  private async lockBooking(tx: BizTx, id: number) {
    const [row] = await tx
      .select({
        id: bizBookings.id,
        customerId: bizBookings.customerId,
        customerName: bizBookings.customerName,
        status: bizBookings.status,
        payStatus: bizBookings.payStatus,
        endAt: bizBookings.endAt,
      })
      .from(bizBookings)
      .where(and(eq(bizBookings.id, id), isNull(bizBookings.deletedAt)))
      .for('update')
      .limit(1);
    if (!row) throw new NotFoundException('预约不存在');
    return row;
  }

  private buildQuote(input: {
    items: QuoteItem[];
    levelDiscountPermille: number;
    pointsUsed: number | undefined;
    memberConfig: { pointsDiscountPerYuan: number; maxPointsPermille: number };
    adjustAmount: number;
    useCard: boolean;
  }): QuoteResult {
    const quote = quoteBooking({
      items: input.items.map((item) => ({
        serviceItemId: item.id,
        name: item.name,
        durationMinutes: item.durationMinutes,
        bufferMinutes: item.bufferMinutes,
        price: item.price,
      })),
      levelDiscountPermille: input.levelDiscountPermille,
      pointsUsed: input.pointsUsed,
      pointsDiscountPerYuan: input.memberConfig.pointsDiscountPerYuan,
      maxPointsPermille: input.memberConfig.maxPointsPermille,
      adjustAmount: input.adjustAmount,
    });
    // 次卡核销：payable = 0，**不叠加**等级折扣与积分抵扣（卡价已是打包优惠，§5.7）
    if (input.useCard) {
      return {
        ...quote,
        levelDiscountAmount: 0,
        pointsDiscountAmount: 0,
        pointsUsed: 0,
        adjustAmount: 0,
        payableAmount: 0,
      };
    }
    return quote;
  }

  private assertAdjustAllowed(
    adjustAmount: number,
    adjustReason: string | undefined,
    actor: RequestActor,
  ): void {
    if (adjustAmount === 0) return;
    if (!this.hasPermission(actor, 'biz:booking:adjust'))
      throw new ForbiddenException('无手动改价权限（biz:booking:adjust）');
    if (!adjustReason?.trim())
      throw new BadRequestException('手动改价必须填写原因');
  }

  private async assertStaffCanDo(
    staffId: number,
    serviceItemIds: number[],
  ): Promise<void> {
    const allowed = await this.staffs.allowedServiceItemIds(staffId);
    if (allowed && serviceItemIds.some((id) => !allowed.includes(id)))
      throw new BadRequestException('该美甲师不能做所选项目');
  }

  private async dominantChannel(
    tx: BizTx,
    bookingId: number,
  ): Promise<PayChannel | null> {
    const rows = await tx
      .select({ channel: bizPayments.channel })
      .from(bizPayments)
      .where(
        and(
          eq(bizPayments.bookingId, bookingId),
          eq(bizPayments.status, 'success'),
        ),
      )
      .orderBy(asc(bizPayments.id));
    const first = rows[0];
    if (!first) return null;
    return first.channel === 'card' ? null : first.channel;
  }

  private hasPermission(actor: RequestActor, permission: string): boolean {
    return (
      actor.permissions.includes(permission) ||
      actor.permissions.includes('*:*:*')
    );
  }

  /** §8.2：先判「是否受美甲师身份限制」，否则回落到通用数据权限 */
  private async resolveScope(actor: RequestActor): Promise<BookingScope> {
    const staff = await this.staffs.findByUserId(actor.id);
    if (staff && !this.hasPermission(actor, 'biz:booking:manageall'))
      return { kind: 'staff', staffId: staff.id };
    const scope = await resolveDataScope(this.database.db, actor);
    if (scope.kind === 'deptIds') return { kind: 'deptIds', ids: scope.ids };
    return { kind: scope.kind };
  }

  private async scopeConditions(
    scope: BookingScope,
    actor: RequestActor,
  ): Promise<SQL[]> {
    if (scope.kind === 'staff') return [eq(bizBookings.staffId, scope.staffId)];
    if (scope.kind === 'self') return [eq(bizBookings.createdBy, actor.id)];
    if (scope.kind === 'deptIds') {
      if (!scope.ids.length) return [sql`1 = 0`];
      return [
        inArray(
          bizBookings.createdBy,
          this.database.db
            .select({ id: users.id })
            .from(users)
            .where(inArray(users.deptId, scope.ids)),
        ),
      ];
    }
    return [];
  }

  private async assertBookingVisible(
    booking: { staffId: number; createdBy: number | null },
    actor: RequestActor,
  ): Promise<void> {
    const scope = await this.resolveScope(actor);
    if (scope.kind === 'all') return;
    if (scope.kind === 'staff' && booking.staffId === scope.staffId) return;
    if (scope.kind === 'self' && booking.createdBy === actor.id) return;
    if (scope.kind === 'deptIds') {
      if (!booking.createdBy) throw new ForbiddenException('无权查看该预约');
      const [owner] = await this.database.db
        .select({ deptId: users.deptId })
        .from(users)
        .where(eq(users.id, booking.createdBy))
        .limit(1);
      if (owner?.deptId && scope.ids.includes(owner.deptId)) return;
    }
    throw new ForbiddenException('无权查看该预约');
  }

  /** 具有美甲师身份且无 manageall 时，只能查自己的可约时段（§8.2） */
  private async assertStaffVisible(
    staffId: number,
    actor: RequestActor,
  ): Promise<void> {
    if (this.hasPermission(actor, 'biz:booking:manageall')) return;
    const staff = await this.staffs.findByUserId(actor.id);
    if (staff && staff.id !== staffId)
      throw new ForbiddenException('只能查看自己的可约时段');
  }
}

/** 解析带偏移的 ISO8601；不接受的写法直接 400（避免 `new Date('2026-09-11')` 类误用） */
export function parseIsoWithOffset(value: string): Date {
  if (!/Z$|[+-]\d{2}:\d{2}$/.test(value))
    throw new BadRequestException(
      'startAt 必须是带时区偏移的 ISO8601（如 2026-09-11T10:00:00+08:00）',
    );
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new BadRequestException('startAt 不是合法时间');
  return parsed;
}

function sumOf<T>(rows: T[], pick: (row: T) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}

function receivedAmountOf(
  outcomes: { status: string; receivedAmount: number }[],
): number {
  return outcomes
    .filter((outcome) => outcome.status === 'success')
    .reduce((total, outcome) => total + outcome.receivedAmount, 0);
}
