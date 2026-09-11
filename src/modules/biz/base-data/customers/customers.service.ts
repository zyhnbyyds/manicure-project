import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { DatabaseService } from '../../../../database/database.service.js';
import {
  bizBookingItems,
  bizBookings,
  bizCustomers,
} from '../../../../database/schema/index.js';
import { BizConfigService } from '../../common/biz-config.service.js';
import { buildDocNo } from '../../common/doc-no.js';
import {
  CustomerPort,
  type CustomerRow,
  type PageResult,
} from '../../common/ports.js';
import { keywordLike } from '../../common/query.js';
import { withoutUndefined } from '../../common/tx.js';
import type { BizTx } from '../../common/tx.js';

const SAMPLE_BOOKING_LIMIT = 3;

export type CreateCustomerInput = {
  name: string;
  phone?: string | null | undefined;
  gender?: 'unknown' | 'male' | 'female' | undefined;
  birthday?: string | null | undefined;
  remark?: string | null | undefined;
};

export type UpdateCustomerInput = {
  [K in keyof CreateCustomerInput]?: CreateCustomerInput[K] | undefined;
};

export type CustomerListFilter = {
  keyword?: string;
  levelId?: number;
  hasBalance?: boolean;
  /**
   * `active`（默认）只看在用档案；`deleted` 只看软删档案。
   *
   * 软删档案必须能被门店翻出来 —— 小程序端绑定命中软删时会回 409 并给出顾客 id，
   * 门店要能据此找到人、执行恢复（§4.3）。
   */
  status?: 'active' | 'deleted';
};

/**
 * 顾客档案（兼会员档案，§4.3 / §9.4）。
 *
 * - 手机号 UNIQUE，查重**不过滤软删**：命中软删记录时提示「恢复该顾客」而不是撞 1062；
 * - `visit_count` / `last_visit_at` 是冗余统计，预约完成时增量更新，可用 `recount` 修复；
 * - 会员字段（`level_id` 及以下）由账务流水驱动，本服务不写。
 */
@Injectable()
export class CustomersService extends CustomerPort {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: BizConfigService,
  ) {
    super();
  }

  async list(
    page: number,
    pageSize: number,
    filter: CustomerListFilter,
  ): Promise<PageResult<CustomerRow>> {
    const conditions = [
      filter.status === 'deleted'
        ? isNotNull(bizCustomers.deletedAt)
        : isNull(bizCustomers.deletedAt),
    ];
    const name = keywordLike(bizCustomers.name, filter.keyword);
    const phone = keywordLike(bizCustomers.phone, filter.keyword);
    if (name && phone) {
      const clause = or(name, phone);
      if (clause) conditions.push(clause);
    }
    if (filter.levelId !== undefined)
      conditions.push(eq(bizCustomers.levelId, filter.levelId));
    if (filter.hasBalance !== undefined) {
      const balance = sql`${bizCustomers.balancePrincipal} + ${bizCustomers.balanceBonus}`;
      conditions.push(
        filter.hasBalance ? sql`${balance} > 0` : sql`${balance} = 0`,
      );
    }
    const items = await this.database.db
      .select()
      .from(bizCustomers)
      .where(and(...conditions))
      .orderBy(desc(bizCustomers.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return { items, page, pageSize };
  }

  async findOne(id: number): Promise<CustomerRow> {
    const [customer] = await this.database.db
      .select()
      .from(bizCustomers)
      .where(and(eq(bizCustomers.id, id), isNull(bizCustomers.deletedAt)))
      .limit(1);
    if (!customer) throw new NotFoundException('顾客不存在');
    return customer;
  }

  async create(
    input: CreateCustomerInput,
    actorId: number,
  ): Promise<{ id: number }> {
    const phone = normalizePhone(input.phone);
    if (phone) await this.assertPhoneAvailable(phone);
    const result = await this.database.db.insert(bizCustomers).values({
      ...withoutUndefined({ ...input, phone }),
      createdBy: actorId,
      updatedBy: actorId,
    });
    return { id: Number(result[0].insertId) };
  }

  async update(
    id: number,
    input: UpdateCustomerInput,
    actorId: number,
  ): Promise<void> {
    await this.findOne(id);
    const patch = withoutUndefined(input);
    if (input.phone !== undefined) {
      const phone = normalizePhone(input.phone);
      if (phone) await this.assertPhoneAvailable(phone, id);
      patch.phone = phone;
    }
    const result = await this.database.db
      .update(bizCustomers)
      .set({ ...patch, updatedBy: actorId })
      .where(and(eq(bizCustomers.id, id), isNull(bizCustomers.deletedAt)));
    if (!result[0].affectedRows) throw new NotFoundException('顾客不存在');
  }

  async remove(id: number, actorId: number): Promise<void> {
    const customer = await this.findOne(id);
    const conditions = and(
      eq(bizBookings.customerId, customer.id),
      isNull(bizBookings.deletedAt),
    );
    const [row] = await this.database.db
      .select({ value: count() })
      .from(bizBookings)
      .where(conditions);
    const total = Number(row?.value ?? 0);
    if (total) {
      const samples = await this.database.db
        .select({ bookingNo: bizBookings.bookingNo })
        .from(bizBookings)
        .where(conditions)
        .limit(SAMPLE_BOOKING_LIMIT);
      const nos = samples.map((sample) => sample.bookingNo).join('、');
      throw new ConflictException(
        `顾客「${customer.name}」存在 ${total} 条预约记录（${nos}），不能删除`,
      );
    }
    const result = await this.database.db
      .update(bizCustomers)
      .set({ deletedAt: new Date(), updatedBy: actorId })
      .where(and(eq(bizCustomers.id, id), isNull(bizCustomers.deletedAt)));
    if (!result[0].affectedRows) throw new NotFoundException('顾客不存在');
  }

  /**
   * 恢复软删档案（§4.3）。
   *
   * - **幂等**：已经是启用状态时直接返回成功。两个店员同时点「恢复」不该报错，
   *   而且并发下后到的那个请求 `affectedRows` 会是 0 —— 那同样说明目标状态已达成。
   * - **查人不过滤软删**：`findOne` 会把软删档案挡在外面，这里必须换一个查法，
   *   否则「要恢复的那个人恰恰是被删的那个人」这个前提直接自相矛盾。
   * - **手机号冲突兜底**：正常路径下不可能冲突（`assertPhoneAvailable` 查重时
   *   不过滤 `deletedAt`，所以同一个手机号在整个表里最多只有一行）。这里再挡一道，
   *   是防有人绕过服务直改库；真撞上了给明确 409，而不是让两行同号共存、
   *   之后 `findByPhone` 随机命中一个。
   */
  async restore(id: number, actorId: number): Promise<void> {
    const customer = await this.findAnyById(id);
    if (!customer.deletedAt) return;
    if (customer.phone)
      await this.assertPhoneFreeForRestore(customer.phone, id);
    await this.database.db
      .update(bizCustomers)
      .set({ deletedAt: null, updatedBy: actorId })
      .where(and(eq(bizCustomers.id, id), isNotNull(bizCustomers.deletedAt)));
  }

  async requireById(id: number, tx?: BizTx): Promise<CustomerRow> {
    const executor = tx ?? this.database.db;
    const [customer] = await executor
      .select()
      .from(bizCustomers)
      .where(and(eq(bizCustomers.id, id), isNull(bizCustomers.deletedAt)))
      .limit(1);
    if (!customer) throw new NotFoundException('顾客不存在');
    return customer;
  }

  /** 不过滤软删（§4.3 坑 1）：调用方需要区分「已删除」与「已占用」 */
  async findByPhone(phone: string): Promise<CustomerRow | null> {
    const normalized = normalizePhone(phone);
    if (!normalized) return null;
    const [customer] = await this.database.db
      .select()
      .from(bizCustomers)
      .where(eq(bizCustomers.phone, normalized))
      .limit(1);
    return customer ?? null;
  }

  async listBookings(
    customerId: number,
    page: number,
    pageSize: number,
  ): Promise<PageResult<Record<string, unknown>>> {
    await this.findOne(customerId);
    const rows = await this.database.db
      .select()
      .from(bizBookings)
      .where(
        and(
          eq(bizBookings.customerId, customerId),
          isNull(bizBookings.deletedAt),
        ),
      )
      .orderBy(desc(bizBookings.startAt), desc(bizBookings.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const items = await this.attachBookingItems(rows);
    return { items, page, pageSize };
  }

  /** 按 `status='completed'` 的单子重算 visit_count / last_visit_at（对账修复，幂等） */
  async recount(
    id: number,
    actorId?: number | null,
  ): Promise<{ visitCount: number; lastVisitAt: Date | null }> {
    await this.findOne(id);
    const [row] = await this.database.db
      .select({
        value: count(),
        lastVisitAt: sql<Date | null>`max(${bizBookings.finishedAt})`,
      })
      .from(bizBookings)
      .where(
        and(
          eq(bizBookings.customerId, id),
          eq(bizBookings.status, 'completed'),
          isNull(bizBookings.deletedAt),
        ),
      );
    const visitCount = Number(row?.value ?? 0);
    const lastVisitAt = row?.lastVisitAt ?? null;
    await this.database.db
      .update(bizCustomers)
      .set({ visitCount, lastVisitAt, updatedBy: actorId ?? null })
      .where(and(eq(bizCustomers.id, id), isNull(bizCustomers.deletedAt)));
    return { visitCount, lastVisitAt };
  }

  /** 预约完成时累加（调用方保证只在状态真正流转时调用一次） */
  async onBookingCompleted(tx: BizTx, customerId: number): Promise<void> {
    await tx
      .update(bizCustomers)
      .set({
        visitCount: sql`${bizCustomers.visitCount} + 1`,
        lastVisitAt: new Date(),
      })
      .where(
        and(eq(bizCustomers.id, customerId), isNull(bizCustomers.deletedAt)),
      );
  }

  /** 纳为会员：生成 `M{yyyyMMdd}{id}` 会员号与入会时间（幂等） */
  async ensureMembership(
    tx: BizTx,
    customerId: number,
    actorId?: number | null,
  ): Promise<{ memberNo: string; memberSince: Date }> {
    const [customer] = await tx
      .select({
        id: bizCustomers.id,
        memberNo: bizCustomers.memberNo,
        memberSince: bizCustomers.memberSince,
      })
      .from(bizCustomers)
      .where(eq(bizCustomers.id, customerId))
      .limit(1);
    if (!customer) throw new NotFoundException('顾客不存在');
    if (customer.memberNo && customer.memberSince)
      return { memberNo: customer.memberNo, memberSince: customer.memberSince };

    const memberSince = customer.memberSince ?? new Date();
    // 会员号一律「主键回填」（§4.3）：并发下同一顾客算出同一个号，不存在重号
    const memberNo =
      customer.memberNo ??
      buildDocNo(
        'M',
        customer.id,
        (await this.config.booking()).timezone,
        memberSince,
      );
    await tx
      .update(bizCustomers)
      .set({ memberNo, memberSince, updatedBy: actorId ?? null })
      .where(
        and(eq(bizCustomers.id, customerId), isNull(bizCustomers.deletedAt)),
      );
    return { memberNo, memberSince };
  }

  /**
   * 按 id 查人，**不过滤软删**（恢复流程专用）。
   * 已删除的档案也要能查到，否则没法恢复；彻底不存在才 404。
   */
  private async findAnyById(id: number): Promise<CustomerRow> {
    const [customer] = await this.database.db
      .select()
      .from(bizCustomers)
      .where(eq(bizCustomers.id, id))
      .limit(1);
    if (!customer) throw new NotFoundException('顾客不存在');
    return customer;
  }

  /**
   * 恢复前的手机号兜底校验：启用态下同号必须仍然唯一。
   * 正常路径下走不到这里（见 `restore` 注释），纯防御。
   */
  private async assertPhoneFreeForRestore(
    phone: string,
    selfId: number,
  ): Promise<void> {
    const [other] = await this.database.db
      .select({ id: bizCustomers.id, name: bizCustomers.name })
      .from(bizCustomers)
      .where(
        and(
          eq(bizCustomers.phone, phone),
          ne(bizCustomers.id, selfId),
          isNull(bizCustomers.deletedAt),
        ),
      )
      .limit(1);
    if (other)
      throw new ConflictException(
        `手机号 ${phone} 已被在用顾客「${other.name}」(#${other.id}) 占用，` +
          `不能恢复；请先改掉其中一方的手机号`,
      );
  }

  /** 手机号查重：**不过滤 deletedAt**（§4.3 坑 1） */
  private async assertPhoneAvailable(
    phone: string,
    excludeId?: number,
  ): Promise<void> {
    const conditions = [eq(bizCustomers.phone, phone)];
    if (excludeId !== undefined)
      conditions.push(ne(bizCustomers.id, excludeId));
    const [existing] = await this.database.db
      .select({
        id: bizCustomers.id,
        name: bizCustomers.name,
        deletedAt: bizCustomers.deletedAt,
      })
      .from(bizCustomers)
      .where(and(...conditions))
      .limit(1);
    if (!existing) return;
    if (existing.deletedAt)
      throw new ConflictException(
        `该手机号属于已删除顾客 #${existing.id}，请恢复该顾客`,
      );
    throw new ConflictException(
      `手机号 ${phone} 已被顾客「${existing.name}」(#${existing.id}) 使用`,
    );
  }

  private async attachBookingItems(
    rows: (typeof bizBookings.$inferSelect)[],
  ): Promise<Record<string, unknown>[]> {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const itemRows = await this.database.db
      .select({
        bookingId: bizBookingItems.bookingId,
        serviceItemId: bizBookingItems.serviceItemId,
        name: bizBookingItems.name,
        durationMinutes: bizBookingItems.durationMinutes,
        price: bizBookingItems.price,
        sort: bizBookingItems.sort,
      })
      .from(bizBookingItems)
      .where(inArray(bizBookingItems.bookingId, ids))
      .orderBy(asc(bizBookingItems.sort), asc(bizBookingItems.id));
    const map = new Map<number, Record<string, unknown>[]>();
    for (const item of itemRows) {
      const list = map.get(item.bookingId) ?? [];
      list.push(item);
      map.set(item.bookingId, list);
    }
    return rows.map((row) => ({ ...row, items: map.get(row.id) ?? [] }));
  }
}

function normalizePhone(phone?: string | null): string | null {
  const text = phone?.trim();
  return text ? text : null;
}
