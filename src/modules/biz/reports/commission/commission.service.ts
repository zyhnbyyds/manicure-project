/**
 * 提成：规则 / 计提 / 结算 / 冲销（§20.3）。
 *
 * 规则优先级 `service_item > category > staff`（同维度取 `sort` 最小、生效期命中的一条）；
 * 计提基数 `base` 默认 `paid`（实收，防挂账提前计提）；一单多项目 → 逐明细计提。
 * 未命中任何规则 → **不提成**（不猜默认比例，报表里单独列「未配置规则」的单量）。
 *
 * 红线（§15.7 / money-invariants）：
 * - 计提记录只追加；冲销只改 `status='reversed'`，**不删**。
 * - 结算把 `accrued` 置 `settled` + `settled_at` + `settle_batch`，**结算后不可修改，只能冲销**。
 * - 幂等：同一 `booking_item_id` 已有 `status != 'reversed'` 的记录就跳过（先查再插 + 事务内锁）。
 * - 冲销走条件更新（`status='accrued'`）当唯一闸门，不做「读出来再判断」。
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { DatabaseService } from '../../../../database/database.service';
import type { RequestActor } from '../../../../common/data-scope/data-scope.js';
import {
  resolveStoreScope,
  storeConditions,
} from '../../../../common/data-scope/store-scope.js';
import {
  bizBookingItems,
  bizBookings,
  bizCommissionRecords,
  bizCommissionRules,
  bizServiceItems,
  bizStaffs,
} from '../../../../database/schema/index.js';
import { BizConfigService } from '../../common/biz-config.service.js';
import { buildSettleBatch } from '../../common/doc-no.js';
import { commissionOf } from '../../common/money.js';
import type { PageResult } from '../../common/ports.js';
import {
  CommissionPort,
  ServiceItemPort,
  StaffPort,
  STAFF_COMMISSION_LIMIT,
  type StaffCommissionItem,
} from '../../common/ports.js';
import {
  andConditions,
  keywordLike,
  parsePagination,
} from '../../common/query.js';
import { shopDateOf } from '../../common/shop-time.js';
import type { BizTx } from '../../common/tx.js';
import { withoutUndefined } from '../../common/tx.js';

type CommissionRuleRow = typeof bizCommissionRules.$inferSelect;
type CommissionRecordRow = typeof bizCommissionRecords.$inferSelect;

export type CommissionScope = 'staff' | 'category' | 'service_item';
export type CommissionBase = 'payable' | 'paid' | 'original';
export type CommissionRecordStatus = 'accrued' | 'settled' | 'reversed';

export type CommissionRuleInput = {
  name: string;
  scope: CommissionScope;
  targetId?: number | null | undefined;
  staffId?: number | null | undefined;
  category?: string | null | undefined;
  permille?: number | undefined;
  fixedAmount?: number | undefined;
  base?: CommissionBase | undefined;
  effectiveFrom: string;
  effectiveTo?: string | null | undefined;
  status?: 'active' | 'disabled' | undefined;
  sort?: number | undefined;
  remark?: string | null | undefined;
};

/** 局部更新：逐字段带 `| undefined`，兼容 `exactOptionalPropertyTypes` */
export type CommissionRulePatch = {
  name?: string | undefined;
  scope?: CommissionScope | undefined;
  targetId?: number | null | undefined;
  staffId?: number | null | undefined;
  category?: string | null | undefined;
  permille?: number | undefined;
  fixedAmount?: number | undefined;
  base?: CommissionBase | undefined;
  effectiveFrom?: string | undefined;
  effectiveTo?: string | null | undefined;
  status?: 'active' | 'disabled' | undefined;
  sort?: number | undefined;
  remark?: string | null | undefined;
};

export type CommissionRuleFilter = {
  scope?: CommissionScope | undefined;
  staffId?: number | undefined;
  category?: string | undefined;
  status?: 'active' | 'disabled' | undefined;
  keyword?: string | undefined;
};

export type CommissionRecordFilter = {
  staffId?: number | undefined;
  period?: string | undefined;
  status?: CommissionRecordStatus | undefined;
  bookingId?: number | undefined;
  /** 门店维度：记录本身没有 `store_id`，按关联预约的门店归属过滤（阶段 1.8） */
  storeId?: number | undefined;
};

export type CommissionRecordItem = CommissionRecordRow & {
  staffNickname: string | null;
  bookingNo: string | null;
  serviceItemId: number | null;
  serviceItemName: string | null;
};

/** 计提记录按状态聚合出的一格 */
export type CommissionRecordStatusSummary = {
  /** 金额（分）。`reversed` 桶里是负数 —— 冲销记录本身就记负数 */
  amount: number;
  /** 笔数 */
  count: number;
  /** 涉及美甲师人数 */
  staffCount: number;
};

/**
 * 计提记录的期间汇总（按状态分桶）。
 *
 * **为什么必须放在后端算**：`/biz/commission-records` 是分页接口（单页上限 200），
 * 前端把 `pageSize` 顶到 200 再 `reduce` 求和的话，某期记录一旦超过 200 条，
 * 「本期已结算 ¥X」就会**静默少算** —— 金额被当作完整值展示，连截断提示都没有。
 * 结算确认弹窗里的「本期计提总额」同样受影响（这里少算会直接影响结算决策）。
 */
export type CommissionRecordSummary = {
  period: string | null;
  accrued: CommissionRecordStatusSummary;
  settled: CommissionRecordStatusSummary;
  reversed: CommissionRecordStatusSummary;
};

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_PATTERN = /^\d{6}$/;
const SCOPE_ORDER: CommissionScope[] = ['service_item', 'category', 'staff'];

/** 金额分摊：按原价占比向下取整（差额留在单头，可手工复核） */
function apportion(total: number, part: number, whole: number): number {
  if (total <= 0 || whole <= 0) return 0;
  return Math.min(Math.floor((total * part) / whole), total);
}

function batchSequence(batch: string | null): number {
  const matched = batch ? /^S\d{6}(\d{3,})$/.exec(batch) : null;
  return matched?.[1] ? Number(matched[1]) : 0;
}

function truncate(value: string, length: number): string {
  return value.length > length ? value.slice(0, length) : value;
}

@Injectable()
export class CommissionService extends CommissionPort {
  private readonly logger = new Logger(CommissionService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly config: BizConfigService,
    private readonly staffs: StaffPort,
    private readonly serviceItems: ServiceItemPort,
  ) {
    super();
  }

  /* ---------------- 计提 / 冲销（端口实现） ---------------- */

  /**
   * 预约完成时计提（幂等）。
   *
   * 逐 `biz_booking_item` 找规则 → `amount = commissionOf(baseAmount, permille, fixedAmount)`；
   * `period` 取**计提时点的店内本地日**对应的 `yyyyMM`；`status='accrued'`。
   *
   * 幂等闸门：先按 `booking_item_id` 锁定已存在的非冲销记录（`FOR UPDATE` 读最新已提交数据），
   * 有则跳过；同一预约行也在事务内锁住（`FOR UPDATE`），并发调用被串行化。
   *
   * TODO（本期未做）：§20.3 的「尾款收清后补提差额」——当前口径是「同一 booking_item 已计提即跳过」，
   * 补提需要按已收比例差额再插入一条记录；等 B1 完成流程确认后补。
   */
  override async accrueForBooking(
    tx: BizTx,
    bookingId: number,
    actorId?: number | null,
  ): Promise<{ records: number; amount: number }> {
    const timeZone = await this.timeZone();
    const [booking] = await tx
      .select({
        id: bizBookings.id,
        status: bizBookings.status,
        staffId: bizBookings.staffId,
        startAt: bizBookings.startAt,
        originalPrice: bizBookings.originalPrice,
        payableAmount: bizBookings.payableAmount,
        paidAmount: bizBookings.paidAmount,
      })
      .from(bizBookings)
      .where(and(eq(bizBookings.id, bookingId), isNull(bizBookings.deletedAt)))
      .limit(1)
      .for('update');
    // 只在 completed 时计提；其它状态直接返回 0（不改动、不抛错，避免拖垮预约主流程）
    if (!booking || booking.status !== 'completed')
      return { records: 0, amount: 0 };

    const items = await tx
      .select({
        id: bizBookingItems.id,
        serviceItemId: bizBookingItems.serviceItemId,
        price: bizBookingItems.price,
      })
      .from(bizBookingItems)
      .where(eq(bizBookingItems.bookingId, bookingId))
      .orderBy(asc(bizBookingItems.id));
    if (!items.length) return { records: 0, amount: 0 };

    // 营业日 = 服务开始的那一天（店内本地日），生效区间按它命中
    const businessDay = shopDateOf(booking.startAt, timeZone);
    const categories = await this.serviceCategories(
      tx,
      items.map((item) => item.serviceItemId),
    );
    const rules = await tx
      .select()
      .from(bizCommissionRules)
      .where(
        and(
          eq(bizCommissionRules.status, 'active'),
          isNull(bizCommissionRules.deletedAt),
          lte(bizCommissionRules.effectiveFrom, businessDay),
          or(
            isNull(bizCommissionRules.effectiveTo),
            gte(bizCommissionRules.effectiveTo, businessDay),
          ),
        ),
      );
    const ordered = [...rules].sort((a, b) => a.sort - b.sort || a.id - b.id);
    const period = shopDateOf(new Date(), timeZone)
      .slice(0, 7)
      .replace('-', '');

    let records = 0;
    let amount = 0;
    for (const item of items) {
      const [existing] = await tx
        .select({ id: bizCommissionRecords.id })
        .from(bizCommissionRecords)
        .where(
          and(
            eq(bizCommissionRecords.bookingItemId, item.id),
            ne(bizCommissionRecords.status, 'reversed'),
          ),
        )
        .limit(1)
        .for('update');
      if (existing) continue;

      const rule = pickRule(
        ordered,
        booking.staffId,
        item.serviceItemId,
        categories.get(item.serviceItemId) ?? null,
      );
      // 未命中规则 → 不提成（不要猜默认比例）
      if (!rule) continue;

      const baseAmount = baseOf(rule.base, item.price, booking);
      const commissionAmount = commissionOf(
        baseAmount,
        rule.permille,
        rule.fixedAmount,
      );
      if (commissionAmount <= 0) continue;

      await tx.insert(bizCommissionRecords).values({
        bookingId: booking.id,
        bookingItemId: item.id,
        staffId: booking.staffId,
        ruleId: rule.id,
        baseAmount,
        amount: commissionAmount,
        period,
        status: 'accrued',
        createdBy: actorId ?? null,
      });
      records += 1;
      amount += commissionAmount;
    }
    return { records, amount };
  }

  /**
   * 退款 / 取消时冲销该预约的计提。
   *
   * 只动 `status='accrued'` 的记录；`settled` 的记录**不动**（结算后不可修改），
   * 但会记一条 warning 便于人工跟进（§20.3 的「进下一期为负数」本期未实现，见交付说明）。
   */
  override async reverseForBooking(
    tx: BizTx,
    bookingId: number,
    reason: string,
    actorId?: number | null,
  ): Promise<{ reversed: number }> {
    const rows = await tx
      .select({
        id: bizCommissionRecords.id,
        status: bizCommissionRecords.status,
      })
      .from(bizCommissionRecords)
      .where(
        and(
          eq(bizCommissionRecords.bookingId, bookingId),
          inArray(bizCommissionRecords.status, ['accrued', 'settled']),
        ),
      )
      .for('update');

    const accruedIds: number[] = [];
    const settledIds: number[] = [];
    for (const row of rows) {
      if (row.status === 'accrued') accruedIds.push(row.id);
      else settledIds.push(row.id);
    }
    if (settledIds.length)
      this.logger.warn(
        `预约 ${bookingId} 有 ${settledIds.length} 条已结算提成无法冲销（ids=${settledIds.join(',')}，操作人=${actorId ?? 'system'}）：只能冲销 accrued`,
      );
    if (!accruedIds.length) return { reversed: 0 };

    const result = await tx
      .update(bizCommissionRecords)
      .set({
        status: 'reversed',
        remark: truncate(`冲销：${reason}`, 200),
      })
      .where(
        and(
          inArray(bizCommissionRecords.id, accruedIds),
          eq(bizCommissionRecords.status, 'accrued'),
        ),
      );
    return { reversed: Number(result[0]?.affectedRows ?? 0) };
  }

  /* ---------------- 结算 ---------------- */

  /**
   * 按期间结算：把该期间 `accrued` 全部置 `settled` + `settled_at` + `settle_batch`。
   *
   * 批次号 `S{yyyyMM}{seq}`，`seq` 取库内该期间已有批次的最大序号 + 1；
   * 结算后不可修改，只能冲销（§20.3）。
   */
  async settle(
    period: string,
    actorId: number,
  ): Promise<{ batch: string; count: number; amount: number }> {
    if (
      !PERIOD_PATTERN.test(period) ||
      Number(period.slice(4, 6)) < 1 ||
      Number(period.slice(4, 6)) > 12
    )
      throw new BadRequestException('period 必须是 yyyyMM，例如 202609');

    const result = await this.database.db.transaction(async (tx) => {
      /*
       * 这里**不加** `FOR UPDATE`：`(period, status)` 没有前缀索引，锁读会扫全表并把
       * 大量无关行锁住。改为「普通读拿 id → 条件更新当闸门」——
       * 并发结算时后提交的那个 `affectedRows < ids.length`，直接 409 回滚，不会重复结算。
       */
      const rows = await tx
        .select({
          id: bizCommissionRecords.id,
          amount: bizCommissionRecords.amount,
        })
        .from(bizCommissionRecords)
        .where(
          and(
            eq(bizCommissionRecords.period, period),
            eq(bizCommissionRecords.status, 'accrued'),
          ),
        );
      if (!rows.length)
        throw new BadRequestException(
          `期间 ${period} 没有待结算（accrued）的计提记录`,
        );

      const batches = await tx
        .selectDistinct({ batch: bizCommissionRecords.settleBatch })
        .from(bizCommissionRecords)
        .where(eq(bizCommissionRecords.period, period));
      const sequence =
        batches.reduce(
          (max, row) => Math.max(max, batchSequence(row.batch)),
          0,
        ) + 1;
      const batch = buildSettleBatch(period, sequence);

      const ids = rows.map((row) => row.id);
      const updated = await tx
        .update(bizCommissionRecords)
        .set({ status: 'settled', settledAt: new Date(), settleBatch: batch })
        .where(
          and(
            inArray(bizCommissionRecords.id, ids),
            eq(bizCommissionRecords.status, 'accrued'),
          ),
        );
      const affected = Number(updated[0]?.affectedRows ?? 0);
      if (affected !== ids.length)
        throw new ConflictException('结算期间有并发变更，请重试');

      return {
        batch,
        count: ids.length,
        amount: rows.reduce((total, row) => total + row.amount, 0),
      };
    });
    // 结算批次不进操作日志表（记录表无 updated_by 列），这里显式留一条审计痕迹
    this.logger.log(
      `提成结算：期间 ${period}，批次 ${result.batch}，${result.count} 条，合计 ${result.amount} 分（操作人=${actorId}）`,
    );
    return result;
  }

  /** 单笔冲销（必填原因）：条件更新当闸门，已结算 / 已冲销一律拒绝 */
  async reverseRecord(
    id: number,
    reason: string,
    actorId: number,
  ): Promise<{ reversed: number }> {
    const trimmed = reason.trim();
    if (!trimmed) throw new BadRequestException('冲销原因必填');
    const [existing] = await this.database.db
      .select({
        id: bizCommissionRecords.id,
        status: bizCommissionRecords.status,
      })
      .from(bizCommissionRecords)
      .where(eq(bizCommissionRecords.id, id))
      .limit(1);
    if (!existing) throw new NotFoundException('提成记录不存在');

    const result = await this.database.db
      .update(bizCommissionRecords)
      .set({ status: 'reversed', remark: truncate(`冲销：${trimmed}`, 200) })
      .where(
        and(
          eq(bizCommissionRecords.id, id),
          eq(bizCommissionRecords.status, 'accrued'),
        ),
      );
    const reversed = Number(result[0]?.affectedRows ?? 0);
    if (!reversed) {
      this.logger.warn(
        `冲销被拒：记录 ${id} 状态为 ${existing.status}，操作人=${actorId}`,
      );
      throw new ConflictException(
        `该记录当前状态为 ${existing.status}，只有 accrued 可冲销（结算后不可修改）`,
      );
    }
    return { reversed };
  }

  /* ---------------- 规则 CRUD ---------------- */

  async listRules(
    page: number,
    pageSize: number,
    filter: CommissionRuleFilter,
  ): Promise<PageResult<CommissionRuleRow>> {
    const { offset } = parsePagination(page, pageSize);
    const items = await this.database.db
      .select()
      .from(bizCommissionRules)
      .where(
        andConditions([
          isNull(bizCommissionRules.deletedAt),
          filter.scope ? eq(bizCommissionRules.scope, filter.scope) : undefined,
          filter.staffId
            ? eq(bizCommissionRules.staffId, filter.staffId)
            : undefined,
          filter.status
            ? eq(bizCommissionRules.status, filter.status)
            : undefined,
          filter.category
            ? eq(bizCommissionRules.category, filter.category)
            : undefined,
          keywordLike(bizCommissionRules.name, filter.keyword),
        ]),
      )
      .orderBy(asc(bizCommissionRules.sort), asc(bizCommissionRules.id))
      .limit(pageSize)
      .offset(offset);
    return { items, page, pageSize };
  }

  async createRule(
    input: CommissionRuleInput,
    actorId: number,
  ): Promise<{ id: number }> {
    const normalised = {
      name: input.name,
      scope: input.scope,
      targetId: input.targetId ?? null,
      staffId: input.staffId ?? null,
      category: input.category ?? null,
      permille: input.permille ?? 0,
      fixedAmount: input.fixedAmount ?? 0,
      base: input.base ?? ('paid' as CommissionBase),
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
      status: input.status ?? ('active' as const),
      sort: input.sort ?? 0,
      remark: input.remark ?? null,
    };
    await this.assertRuleValid(normalised);
    const result = await this.database.db.insert(bizCommissionRules).values({
      ...normalised,
      createdBy: actorId,
      updatedBy: actorId,
    });
    return { id: Number(result[0]?.insertId ?? 0) };
  }

  /** 修改规则只影响之后计提（不做回溯重算） */
  async updateRule(
    id: number,
    patch: CommissionRulePatch,
    actorId: number,
  ): Promise<void> {
    const [existing] = await this.database.db
      .select()
      .from(bizCommissionRules)
      .where(
        and(
          eq(bizCommissionRules.id, id),
          isNull(bizCommissionRules.deletedAt),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundException('提成规则不存在');

    const merged = {
      name: patch.name ?? existing.name,
      scope: patch.scope ?? existing.scope,
      targetId:
        patch.targetId === undefined ? existing.targetId : patch.targetId,
      staffId: patch.staffId === undefined ? existing.staffId : patch.staffId,
      category:
        patch.category === undefined ? existing.category : patch.category,
      permille: patch.permille ?? existing.permille,
      fixedAmount: patch.fixedAmount ?? existing.fixedAmount,
      base: patch.base ?? existing.base,
      effectiveFrom: patch.effectiveFrom ?? existing.effectiveFrom,
      effectiveTo:
        patch.effectiveTo === undefined
          ? existing.effectiveTo
          : patch.effectiveTo,
      status: patch.status ?? existing.status,
      sort: patch.sort ?? existing.sort,
      remark: patch.remark === undefined ? existing.remark : patch.remark,
    };
    await this.assertRuleValid(merged);

    const result = await this.database.db
      .update(bizCommissionRules)
      .set({ ...withoutUndefined(patch), updatedBy: actorId })
      .where(
        and(
          eq(bizCommissionRules.id, id),
          isNull(bizCommissionRules.deletedAt),
        ),
      );
    if (!result[0]?.affectedRows) throw new NotFoundException('提成规则不存在');
  }

  async removeRule(id: number, actorId: number): Promise<void> {
    const result = await this.database.db
      .update(bizCommissionRules)
      .set({
        deletedAt: new Date(),
        status: 'disabled',
        updatedBy: actorId,
      })
      .where(
        and(
          eq(bizCommissionRules.id, id),
          isNull(bizCommissionRules.deletedAt),
        ),
      );
    if (!result[0]?.affectedRows) throw new NotFoundException('提成规则不存在');
  }

  /* ---------------- 计提记录（S3 美甲师业绩） ---------------- */

  override async listByStaff(
    staffId: number,
    period?: string | undefined,
  ): Promise<StaffCommissionItem[]> {
    return this.database.db
      .select({
        id: bizCommissionRecords.id,
        bookingId: bizCommissionRecords.bookingId,
        bookingItemId: bizCommissionRecords.bookingItemId,
        staffId: bizCommissionRecords.staffId,
        baseAmount: bizCommissionRecords.baseAmount,
        amount: bizCommissionRecords.amount,
        period: bizCommissionRecords.period,
        status: bizCommissionRecords.status,
        settledAt: bizCommissionRecords.settledAt,
        bookingNo: bizBookings.bookingNo,
        serviceItemName: bizBookingItems.name,
      })
      .from(bizCommissionRecords)
      .leftJoin(bizBookings, eq(bizCommissionRecords.bookingId, bizBookings.id))
      .leftJoin(
        bizBookingItems,
        eq(bizCommissionRecords.bookingItemId, bizBookingItems.id),
      )
      .where(
        andConditions([
          eq(bizCommissionRecords.staffId, staffId),
          period ? eq(bizCommissionRecords.period, period) : undefined,
        ]),
      )
      .orderBy(desc(bizCommissionRecords.id))
      .limit(STAFF_COMMISSION_LIMIT);
  }

  override async summarizeByStaff(
    staffId: number,
    period?: string | undefined,
  ): Promise<{ accrued: number; settled: number; reversed: number }> {
    const rows = await this.database.db
      .select({
        status: bizCommissionRecords.status,
        total: sql<number>`COALESCE(SUM(${bizCommissionRecords.amount}), 0)`,
      })
      .from(bizCommissionRecords)
      .where(
        andConditions([
          eq(bizCommissionRecords.staffId, staffId),
          period ? eq(bizCommissionRecords.period, period) : undefined,
        ]),
      )
      .groupBy(bizCommissionRecords.status);
    const summary = { accrued: 0, settled: 0, reversed: 0 };
    for (const row of rows) summary[row.status] = Number(row.total);
    return summary;
  }

  /* ---------------- 计提记录 ---------------- */

  async listRecords(
    page: number,
    pageSize: number,
    filter: CommissionRecordFilter,
    actor: RequestActor | null,
  ): Promise<PageResult<CommissionRecordItem>> {
    const { offset } = parsePagination(page, pageSize);
    /*
     * 门店维度（阶段 1.8）：`biz_commission_record` 没有 `store_id`，
     * 门店归属只能顺着 `booking_id → biz_booking.store_id` 找。
     * 没有门店筛选时不加任何条件 —— 不写成 `inArray(bookingId, 全部预约 id)`，
     * 那是等价但白跑一次全表子查询。
     */
    const store = await resolveStoreScope(
      this.database.db,
      actor,
      filter.storeId,
    );
    const storeFilters = storeConditions(bizBookings.storeId, store);
    const items = await this.database.db
      .select({
        id: bizCommissionRecords.id,
        bookingId: bizCommissionRecords.bookingId,
        bookingItemId: bizCommissionRecords.bookingItemId,
        staffId: bizCommissionRecords.staffId,
        ruleId: bizCommissionRecords.ruleId,
        baseAmount: bizCommissionRecords.baseAmount,
        amount: bizCommissionRecords.amount,
        period: bizCommissionRecords.period,
        status: bizCommissionRecords.status,
        settledAt: bizCommissionRecords.settledAt,
        settleBatch: bizCommissionRecords.settleBatch,
        remark: bizCommissionRecords.remark,
        createdBy: bizCommissionRecords.createdBy,
        createdAt: bizCommissionRecords.createdAt,
        staffNickname: bizStaffs.nickname,
        bookingNo: bizBookings.bookingNo,
        serviceItemId: bizBookingItems.serviceItemId,
        serviceItemName: bizBookingItems.name,
      })
      .from(bizCommissionRecords)
      .leftJoin(bizStaffs, eq(bizCommissionRecords.staffId, bizStaffs.id))
      .leftJoin(bizBookings, eq(bizCommissionRecords.bookingId, bizBookings.id))
      .leftJoin(
        bizBookingItems,
        eq(bizCommissionRecords.bookingItemId, bizBookingItems.id),
      )
      .where(
        andConditions([
          ...(storeFilters.length
            ? [
                inArray(
                  bizCommissionRecords.bookingId,
                  this.database.db
                    .select({ id: bizBookings.id })
                    .from(bizBookings)
                    .where(and(...storeFilters)),
                ),
              ]
            : []),
          filter.staffId
            ? eq(bizCommissionRecords.staffId, filter.staffId)
            : undefined,
          filter.period
            ? eq(bizCommissionRecords.period, filter.period)
            : undefined,
          filter.status
            ? eq(bizCommissionRecords.status, filter.status)
            : undefined,
          filter.bookingId
            ? eq(bizCommissionRecords.bookingId, filter.bookingId)
            : undefined,
        ]),
      )
      .orderBy(desc(bizCommissionRecords.id))
      .limit(pageSize)
      .offset(offset);
    return { items, page, pageSize };
  }

  /**
   * 期间汇总：按 `status` 分桶聚合，不受分页上限影响。
   *
   * 门店维度的过滤条件与 `listRecords` **必须保持一致** —— 只要两处有一点差异，
   * 「列表里的数字加起来 ≠ 汇总数字」，店长会直接质疑整张报表。
   *
   * 注意：`filter.status` 有意不参与过滤 —— 本方法的职责就是按状态分桶，
   * 传了也只会把其余两个桶变成 0。
   */
  async summaryRecords(
    filter: CommissionRecordFilter,
    actor: RequestActor | null,
  ): Promise<CommissionRecordSummary> {
    const store = await resolveStoreScope(
      this.database.db,
      actor,
      filter.storeId,
    );
    const storeFilters = storeConditions(bizBookings.storeId, store);
    const rows = await this.database.db
      .select({
        status: bizCommissionRecords.status,
        amount: sql<number>`COALESCE(SUM(${bizCommissionRecords.amount}), 0)`,
        count: sql<number>`COUNT(*)`,
        staffCount: sql<number>`COUNT(DISTINCT ${bizCommissionRecords.staffId})`,
      })
      .from(bizCommissionRecords)
      .where(
        andConditions([
          ...(storeFilters.length
            ? [
                inArray(
                  bizCommissionRecords.bookingId,
                  this.database.db
                    .select({ id: bizBookings.id })
                    .from(bizBookings)
                    .where(and(...storeFilters)),
                ),
              ]
            : []),
          filter.staffId
            ? eq(bizCommissionRecords.staffId, filter.staffId)
            : undefined,
          filter.period
            ? eq(bizCommissionRecords.period, filter.period)
            : undefined,
          filter.bookingId
            ? eq(bizCommissionRecords.bookingId, filter.bookingId)
            : undefined,
        ]),
      )
      .groupBy(bizCommissionRecords.status);

    const buckets: Record<
      CommissionRecordStatus,
      CommissionRecordStatusSummary
    > = {
      accrued: { amount: 0, count: 0, staffCount: 0 },
      settled: { amount: 0, count: 0, staffCount: 0 },
      reversed: { amount: 0, count: 0, staffCount: 0 },
    };
    for (const row of rows) {
      buckets[row.status] = {
        amount: Number(row.amount),
        count: Number(row.count),
        staffCount: Number(row.staffCount),
      };
    }
    return { period: filter.period ?? null, ...buckets };
  }

  /* ---------------- 内部 ---------------- */

  private async assertRuleValid(input: {
    scope: CommissionScope;
    targetId: number | null;
    staffId: number | null;
    category: string | null;
    permille: number;
    fixedAmount: number;
    effectiveFrom: string;
    effectiveTo: string | null;
  }): Promise<void> {
    if (!LOCAL_DATE_PATTERN.test(input.effectiveFrom))
      throw new BadRequestException('effectiveFrom 必须是 YYYY-MM-DD');
    if (
      input.effectiveTo !== null &&
      !LOCAL_DATE_PATTERN.test(input.effectiveTo)
    )
      throw new BadRequestException('effectiveTo 必须是 YYYY-MM-DD');
    if (input.effectiveTo !== null && input.effectiveTo < input.effectiveFrom)
      throw new BadRequestException('生效结束日不能早于生效开始日');
    if (input.permille <= 0 && input.fixedAmount <= 0)
      throw new BadRequestException('比例（‰）与固定额不能同时为 0');
    if (input.permille < 0 || input.permille > 1000)
      throw new BadRequestException(
        'permille 取值 0~1000（千分比，1000 = 100%）',
      );
    if (input.fixedAmount < 0)
      throw new BadRequestException('fixedAmount 不能为负');

    if (input.scope === 'service_item') {
      if (!input.targetId)
        throw new BadRequestException('scope=service_item 时 targetId 必填');
      await this.serviceItems.findOne(input.targetId);
    } else if (input.scope === 'category') {
      if (!input.category)
        throw new BadRequestException('scope=category 时 category 必填');
    } else {
      if (!input.staffId)
        throw new BadRequestException('scope=staff 时 staffId 必填');
      await this.staffs.requireActive(input.staffId);
    }
  }

  /** 项目 → 分类（category 维度规则命中用，只读） */
  private async serviceCategories(
    tx: BizTx,
    serviceItemIds: number[],
  ): Promise<Map<number, string | null>> {
    const ids = [...new Set(serviceItemIds)];
    const map = new Map<number, string | null>();
    if (!ids.length) return map;
    const rows = await tx
      .select({ id: bizServiceItems.id, category: bizServiceItems.category })
      .from(bizServiceItems)
      .where(inArray(bizServiceItems.id, ids));
    for (const row of rows) map.set(row.id, row.category);
    return map;
  }

  private async timeZone(): Promise<string> {
    const { timezone } = await this.config.booking();
    return timezone;
  }
}

/* ------------------------------------------------------------------ *
 * 纯函数
 * ------------------------------------------------------------------ */

/** 按 `service_item > category > staff` 优先级取一条规则（同维度已按 sort/id 升序） */
export function pickRule(
  rules: CommissionRuleRow[],
  staffId: number,
  serviceItemId: number,
  category: string | null,
): CommissionRuleRow | null {
  for (const scope of SCOPE_ORDER) {
    const matched = rules.find((rule) => {
      if (rule.scope !== scope) return false;
      if (scope === 'service_item') return rule.targetId === serviceItemId;
      if (scope === 'category')
        return category !== null && rule.category === category;
      return rule.staffId === staffId;
    });
    if (matched) return matched;
  }
  return null;
}

/** 计提基数：`paid` 实收（默认，防挂账提前计提）/ `payable` 应付 / `original` 原价 */
export function baseOf(
  base: CommissionBase,
  itemPrice: number,
  booking: { originalPrice: number; payableAmount: number; paidAmount: number },
): number {
  if (base === 'original') return Math.max(itemPrice, 0);
  if (base === 'payable')
    return apportion(booking.payableAmount, itemPrice, booking.originalPrice);
  return apportion(booking.paidAmount, itemPrice, booking.originalPrice);
}
