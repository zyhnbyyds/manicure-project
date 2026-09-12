import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, count, desc, eq, getTableColumns, isNull, or, sql } from 'drizzle-orm';
import { DatabaseService } from '../../../../database/database.service';
import {
  bizCouponTemplates,
  bizCustomerCoupons,
} from '../../../../database/schema/index.js';
import { BizConfigService } from '../../common/biz-config.service.js';
import { buildDocNo } from '../../common/doc-no.js';
import { keywordLike, parsePagination } from '../../common/query.js';
import type { BizDatabase, BizTx } from '../../common/tx.js';

export type CouponTemplateRow = typeof bizCouponTemplates.$inferSelect;
export type CustomerCouponRow = typeof bizCustomerCoupons.$inferSelect;

/** 券的对外状态。`expired` 由 `expire_at` **现算**，不依赖定时任务是否跑过 */
export type CustomerCouponStatus = 'usable' | 'used' | 'expired' | 'void';

/** 列表筛选：`all` 或某个状态 */
export type CustomerCouponFilter = CustomerCouponStatus | 'all';

/** 毫秒/天 */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 优惠券（本目标新增的子系统）。
 *
 * 三条口径（与 `biz_coupon_template` / `biz_customer_coupon` 的注释一致）：
 * 1. **面额与门槛在下发时快照**：模板之后改价，不影响已发出的券；
 * 2. **状态现算**：`usable` 但已过期 → 对外显示 `expired`（同次卡的既有做法：
 *    不依赖定时任务是否已把行翻成 expired，到店那一刻就是准的）；
 * 3. **核销只在这里做条件更新**（下一轮接入下单）：`used_booking_id` 唯一索引 +
 *    `WHERE status='usable' AND used_booking_id IS NULL`，`affectedRows=0` 即拒绝。
 */
@Injectable()
export class CouponsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: BizConfigService,
  ) {}

  /** 发券：给某位顾客发一张模板券（后台发券 / 活动发券都走这里） */
  async issue(input: {
    customerId: number;
    templateId: number;
    actorId: number | null;
    source?: string;
  }): Promise<CustomerCouponRow> {
    const [template] = await this.database.db
      .select()
      .from(bizCouponTemplates)
      .where(
        and(
          eq(bizCouponTemplates.id, input.templateId),
          isNull(bizCouponTemplates.deletedAt),
        ),
      )
      .limit(1);
    if (!template) throw new NotFoundException('优惠券模板不存在');
    if (template.status !== 'active')
      throw new ConflictException('该优惠券已停用，不能发放');

    const { timezone } = await this.config.booking();
    const now = new Date();
    const expireAt = this.resolveExpireAt(template, now);

    // **整段放进事务**：单号是「主键回填」（先插占位号，拿到自增 id 再回填正式号，
    // 因为「查当日最大号 +1」在并发下必然重号）。
    // 不包事务的话，insert 与回填之间一旦失败，库里会永久留下一张 `TMP...` 号的券。
    return this.database.db.transaction(async (tx) => {
      const inserted = await tx.insert(bizCustomerCoupons).values({
        couponNo: `TMP${Date.now()}${Math.floor(Math.random() * 1e6)}`,
        customerId: input.customerId,
        templateId: template.id,
        discountAmount: template.discountAmount,
        thresholdAmount: template.thresholdAmount,
        status: 'usable',
        expireAt,
        source: input.source ?? 'manual',
        createdBy: input.actorId ?? undefined,
      });
      const id = Number(inserted[0].insertId);

      await tx
        .update(bizCustomerCoupons)
        .set({ couponNo: buildDocNo('X', id, timezone, now) })
        .where(eq(bizCustomerCoupons.id, id));

      const [row] = await tx
        .select()
        .from(bizCustomerCoupons)
        .where(eq(bizCustomerCoupons.id, id))
        .limit(1);
      if (!row) throw new NotFoundException('发券失败，请重试');
      return row;
    });
  }

  /**
   * 我的券（顾客侧）。
   *
   * **状态筛选必须下推到 SQL**，不能查出来再在内存里过滤 ——
   * 否则分页会在过滤前截断，出现「第 2 页是空的但第 3 页有数据」。
   */
  async listMine(
    customerId: number,
    filter: CustomerCouponFilter = 'all',
    page = 1,
    pageSize = 20,
  ): Promise<{
    items: (CustomerCouponRow & {
      displayStatus: CustomerCouponStatus;
      /** 券名（模板名）：顾客需要知道这是张什么券 */
      templateName: string | null;
    })[];
    page: number;
    pageSize: number;
  }> {
    const {
      page: safePage,
      pageSize: safePageSize,
      offset,
    } = parsePagination(page, pageSize);
    const now = new Date();

    const conditions = [
      eq(bizCustomerCoupons.customerId, customerId),
      isNull(bizCustomerCoupons.deletedAt),
      this.filterCondition(filter, now),
    ];

    const rows = await this.database.db
      .select({
        ...getTableColumns(bizCustomerCoupons),
        // 券名来自模板：它是营销文案，给顾客看没有问题；模板 id 仍不外泄
        templateName: bizCouponTemplates.name,
      })
      .from(bizCustomerCoupons)
      .leftJoin(
        bizCouponTemplates,
        eq(bizCouponTemplates.id, bizCustomerCoupons.templateId),
      )
      .where(and(...conditions))
      .orderBy(desc(bizCustomerCoupons.id))
      .limit(safePageSize)
      .offset(offset);

    return {
      items: rows.map((row) => ({
        ...row,
        displayStatus: this.displayStatus(row, now),
      })),
      page: safePage,
      pageSize: safePageSize,
    };
  }

  /** 单张券（核销与展示都要用；校验归属由调用方负责） */
  async findById(id: number): Promise<CustomerCouponRow | null> {
    const [row] = await this.database.db
      .select()
      .from(bizCustomerCoupons)
      .where(
        and(eq(bizCustomerCoupons.id, id), isNull(bizCustomerCoupons.deletedAt)),
      )
      .limit(1);
    return row ?? null;
  }

  /** 过期任务：把到期的 `usable` 翻成 `expired`（只改状态，不碰钱与积分） */
  async expireDue(now = new Date()): Promise<number> {
    const result = await this.database.db
      .update(bizCustomerCoupons)
      .set({ status: 'expired' })
      .where(
        and(
          eq(bizCustomerCoupons.status, 'usable'),
          isNull(bizCustomerCoupons.deletedAt),
          sql`${bizCustomerCoupons.expireAt} IS NOT NULL AND ${bizCustomerCoupons.expireAt} <= ${now}`,
        ),
      );
    return Number(result[0].affectedRows ?? 0);
  }

  /** 有效期：优先「领取后 N 天」，否则用模板的绝对区间；都没有 = 长期有效 */
  private resolveExpireAt(template: CouponTemplateRow, now: Date): Date | null {
    if (template.validDays > 0) {
      return new Date(now.getTime() + template.validDays * DAY_MS);
    }
    return template.validTo ?? null;
  }

  /** 展示状态：usable 但已过期 → expired（现算） */
  private displayStatus(
    row: CustomerCouponRow,
    now: Date,
  ): CustomerCouponStatus {
    if (
      row.status === 'usable' &&
      row.expireAt &&
      row.expireAt.getTime() <= now.getTime()
    ) {
      return 'expired';
    }
    return row.status;
  }

  /** 状态筛选 → SQL 条件（`usable` / `expired` 都要考虑「未翻状态但已过期」的行） */
  private filterCondition(filter: CustomerCouponFilter, now: Date) {
    const notExpired = or(
      isNull(bizCustomerCoupons.expireAt),
      sql`${bizCustomerCoupons.expireAt} > ${now}`,
    );
    if (filter === 'all') return sql`1 = 1`;
    if (filter === 'usable') {
      return and(eq(bizCustomerCoupons.status, 'usable'), notExpired);
    }
    if (filter === 'expired') {
      return or(
        eq(bizCustomerCoupons.status, 'expired'),
        and(
          eq(bizCustomerCoupons.status, 'usable'),
          sql`${bizCustomerCoupons.expireAt} IS NOT NULL AND ${bizCustomerCoupons.expireAt} <= ${now}`,
        ),
      );
    }
    return eq(bizCustomerCoupons.status, filter);
  }

  /**
   * 核销：把券绑到某一单上，返回**实际抵扣额（分）**。
   *
   * ## 必须在建单的同一事务里调用（因此第一个参数是 `tx`）
   *
   * 否则会出现两类事故：券核销了但单没建成（顾客白丢一张券），
   * 或者单建成了但券还能再用（门店白送一次让利）。
   *
   * ## 闸门是条件更新，不是「读出来判断再写」
   *
   * `WHERE id=? AND customer_id=? AND status='usable' AND used_booking_id IS NULL`，
   * `affectedRows = 0` 一律 409。上面那段「先查一遍」只用于给出**友好报错**
   * （已过期 / 不到门槛 / 不是你的券），**并发安全完全由条件更新保证** ——
   * 读-判断-写在并发下会让同一张券被两单同时用掉。
   *
   * ## 门槛基准
   *
   * `baseAmount` 传**等级折扣之后**的金额（券在等级折扣后、积分前，见 `money.ts`）。
   * 抵扣额再夹一次 `min(面额, baseAmount)`，与算价里的夹取保持一致。
   */
  /**
   * 取券并做**可用性前置校验**（只读）。
   *
   * `previewForBooking`（算价取面额）与 `redeemForBooking`（真正核销）共用，
   * 避免两处口径分叉 —— 否则会出现「算价时能用、核销时说不能」的诡异体验。
   *
   * **它不是闸门**：并发安全始终由 `redeemForBooking` 末尾的条件更新保证。
   */
  private async loadUsable(
    db: BizTx | BizDatabase,
    input: { couponId: number; customerId: number; baseAmount: number },
  ): Promise<{ row: CustomerCouponRow; discountAmount: number }> {
    const [row] = await db
      .select()
      .from(bizCustomerCoupons)
      .where(
        and(
          eq(bizCustomerCoupons.id, input.couponId),
          isNull(bizCustomerCoupons.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('优惠券不存在');
    if (row.customerId !== input.customerId) {
      // 不暴露「这张券属于谁」，只说不能用 —— 避免拿别人的券 id 探测
      throw new ConflictException('这张优惠券不可用');
    }
    const now = new Date();
    if (
      row.status !== 'usable' ||
      (row.expireAt && row.expireAt.getTime() <= now.getTime())
    ) {
      throw new ConflictException('优惠券已使用或已过期');
    }
    if (input.baseAmount < row.thresholdAmount) {
      const yuan = Math.ceil(row.thresholdAmount / 100);
      throw new ConflictException(`未达到优惠券使用门槛（满 ${yuan} 元可用）`);
    }
    return {
      row,
      discountAmount: Math.min(
        row.discountAmount,
        Math.max(input.baseAmount, 0),
      ),
    };
  }

  /**
   * 算价阶段取券面额（**只读，不核销**）。
   *
   * 券抵扣额是算价的输入，而核销需要 bookingId —— 两者互相依赖，
   * 所以建单处先用本方法拿到面额算价，建单拿到 id 后再调 `redeemForBooking`。
   * 若在「读取」与「核销」之间这张券被别人用掉，核销会 409 并让整个建单事务回滚。
   */
  async previewForBooking(
    db: BizTx | BizDatabase,
    input: { couponId: number; customerId: number; baseAmount: number },
  ): Promise<{ couponNo: string; discountAmount: number }> {
    const { row, discountAmount } = await this.loadUsable(db, input);
    return { couponNo: row.couponNo, discountAmount };
  }

  /**
   * 核销：把券绑到某一单上，返回**实际抵扣额（分）**。
   *
   * ## 必须在建单的同一事务里调用（因此第一个参数是 `tx`）
   *
   * 否则会出现两类事故：券核销了但单没建成（顾客白丢一张券），
   * 或者单建成了但券还能再用（门店白送一次让利）。
   *
   * ## 闸门是条件更新，不是「读出来判断再写」
   *
   * `WHERE id=? AND customer_id=? AND status='usable' AND used_booking_id IS NULL`，
   * `affectedRows = 0` 一律 409。`loadUsable` 只用于给出**友好报错**，
   * **并发安全完全由这条条件更新保证** —— 读-判断-写在并发下会让同一张券被两单同时用掉。
   *
   * ## 门槛基准
   *
   * `baseAmount` 传**等级折扣之后**的金额（券在等级折扣后、积分前，见 `money.ts`）。
   */
  async redeemForBooking(
    tx: BizTx | BizDatabase,
    input: {
      couponId: number;
      customerId: number;
      /** 建单场景传真实 bookingId；单测/预演可传 null（此时 `status` 仍会翻转，闸门照旧生效） */
      bookingId: number | null;
      /** 等级折扣之后的金额（分） */
      baseAmount: number;
      actorId?: number | null;
    },
  ): Promise<{ couponNo: string; discountAmount: number }> {
    const { row, discountAmount } = await this.loadUsable(tx, input);

    const result = await tx
      .update(bizCustomerCoupons)
      .set({
        status: 'used',
        usedBookingId: input.bookingId ?? null,
        usedAt: new Date(),
        updatedBy: input.actorId ?? undefined,
      })
      .where(
        and(
          eq(bizCustomerCoupons.id, input.couponId),
          eq(bizCustomerCoupons.customerId, input.customerId),
          eq(bizCustomerCoupons.status, 'usable'),
          isNull(bizCustomerCoupons.usedBookingId),
        ),
      );
    if (!result[0].affectedRows) throw new ConflictException('优惠券已被使用');

    return { couponNo: row.couponNo, discountAmount };
  }


  /**
   * 可领取的券模板（顾客侧）。
   *
   * 排除「已经持有可用券」的模板 —— 同一张券反复领就是薅羊毛，
   * 且顾客看到自己已领的券出现在「可领取」里也会困惑。
   */
  async listClaimable(customerId: number): Promise<
    {
      id: number;
      name: string;
      thresholdAmount: number;
      discountAmount: number;
      validDays: number;
      validTo: Date | null;
      remark: string | null;
    }[]
  > {
    const rows = await this.database.db
      .select({
        id: bizCouponTemplates.id,
        name: bizCouponTemplates.name,
        thresholdAmount: bizCouponTemplates.thresholdAmount,
        discountAmount: bizCouponTemplates.discountAmount,
        validDays: bizCouponTemplates.validDays,
        validTo: bizCouponTemplates.validTo,
        remark: bizCouponTemplates.remark,
      })
      .from(bizCouponTemplates)
      .where(
        and(
          eq(bizCouponTemplates.status, 'active'),
          isNull(bizCouponTemplates.deletedAt),
        ),
      )
      .orderBy(bizCouponTemplates.sort, desc(bizCouponTemplates.id));

    const held = await this.database.db
      .select({ templateId: bizCustomerCoupons.templateId })
      .from(bizCustomerCoupons)
      .where(
        and(
          eq(bizCustomerCoupons.customerId, customerId),
          eq(bizCustomerCoupons.status, 'usable'),
          isNull(bizCustomerCoupons.deletedAt),
        ),
      );
    const heldIds = new Set(held.map((row) => row.templateId));
    return rows.filter((row) => !heldIds.has(row.id));
  }

  /**
   * 领券（顾客自助领取）。
   *
   * **必须在事务里锁模板行**：MySQL 没有「部分唯一索引」，
   * 无法用唯一约束表达「同一顾客同一模板只能有一张**未使用**的券」，
   * 所以用 `SELECT ... FOR UPDATE` 把并发领取串行化 ——
   * 同一顾客并发点两次「领取」只会成功一次。这比「先查再插」可靠
   * （后者在并发下会发出两张券）。
   */
  async claim(input: {
    customerId: number;
    templateId: number;
    actorId: number | null;
  }): Promise<CustomerCouponRow> {
    const { timezone } = await this.config.booking();
    const now = new Date();

    return this.database.db.transaction(async (tx) => {
      // 锁模板行：这是串行化点，必须在「查已领」之前
      const [template] = await tx
        .select()
        .from(bizCouponTemplates)
        .where(
          and(
            eq(bizCouponTemplates.id, input.templateId),
            isNull(bizCouponTemplates.deletedAt),
          ),
        )
        .for('update')
        .limit(1);
      if (!template) throw new NotFoundException('优惠券不存在');
      if (template.status !== 'active')
        throw new ConflictException('该优惠券已停止发放');

      const [existing] = await tx
        .select({ id: bizCustomerCoupons.id })
        .from(bizCustomerCoupons)
        .where(
          and(
            eq(bizCustomerCoupons.customerId, input.customerId),
            eq(bizCustomerCoupons.templateId, input.templateId),
            eq(bizCustomerCoupons.status, 'usable'),
            isNull(bizCustomerCoupons.deletedAt),
          ),
        )
        .limit(1);
      if (existing) throw new ConflictException('你已经领过这张券了');

      const expireAt = this.resolveExpireAt(template, now);
      const inserted = await tx.insert(bizCustomerCoupons).values({
        couponNo: `TMP${Date.now()}${Math.floor(Math.random() * 1e6)}`,
        customerId: input.customerId,
        templateId: template.id,
        discountAmount: template.discountAmount,
        thresholdAmount: template.thresholdAmount,
        status: 'usable',
        expireAt,
        source: 'claim',
        createdBy: input.actorId ?? undefined,
      });
      const id = Number(inserted[0].insertId);
      await tx
        .update(bizCustomerCoupons)
        .set({ couponNo: buildDocNo('X', id, timezone, now) })
        .where(eq(bizCustomerCoupons.id, id));

      const [row] = await tx
        .select()
        .from(bizCustomerCoupons)
        .where(eq(bizCustomerCoupons.id, id))
        .limit(1);
      if (!row) throw new NotFoundException('领券失败，请重试');
      return row;
    });
  }


  /* ------------------------------------------------------------------ *
   * 券模板维护（后台）
   * ------------------------------------------------------------------ */

  async listTemplates(
    page: number,
    pageSize: number,
    filter: {
      status?: 'active' | 'disabled' | undefined;
      keyword?: string | undefined;
    } = {},
  ): Promise<{
    items: (CouponTemplateRow & { claimedCount: number })[];
    page: number;
    pageSize: number;
  }> {
    const {
      page: safePage,
      pageSize: safePageSize,
      offset,
    } = parsePagination(page, pageSize);
    const conditions = [isNull(bizCouponTemplates.deletedAt)];
    if (filter.status) conditions.push(eq(bizCouponTemplates.status, filter.status));
    const keyword = keywordLike(bizCouponTemplates.name, filter.keyword);
    if (keyword) conditions.push(keyword);

    const rows = await this.database.db
      .select()
      .from(bizCouponTemplates)
      .where(and(...conditions))
      .orderBy(bizCouponTemplates.sort, desc(bizCouponTemplates.id))
      .limit(safePageSize)
      .offset(offset);

    // 已发出多少张：列表上要看得见，否则运营不知道停用会不会影响在用的券
    const counts = await Promise.all(
      rows.map(async (row) => {
        const [agg] = await this.database.db
          .select({ total: count() })
          .from(bizCustomerCoupons)
          .where(
            and(
              eq(bizCustomerCoupons.templateId, row.id),
              isNull(bizCustomerCoupons.deletedAt),
            ),
          );
        return Number(agg?.total ?? 0);
      }),
    );

    return {
      items: rows.map((row, index) => ({
        ...row,
        claimedCount: counts[index] ?? 0,
      })),
      page: safePage,
      pageSize: safePageSize,
    };
  }

  /** 某位顾客持有的券（后台用：发券后要能核对，会员详情也要看） */
  async listByCustomer(
    customerId: number,
    page = 1,
    pageSize = 20,
  ): Promise<{ items: CustomerCouponRow[]; page: number; pageSize: number }> {
    const {
      page: safePage,
      pageSize: safePageSize,
      offset,
    } = parsePagination(page, pageSize);
    const rows = await this.database.db
      .select()
      .from(bizCustomerCoupons)
      .where(
        and(
          eq(bizCustomerCoupons.customerId, customerId),
          isNull(bizCustomerCoupons.deletedAt),
        ),
      )
      .orderBy(desc(bizCustomerCoupons.id))
      .limit(safePageSize)
      .offset(offset);
    return { items: rows, page: safePage, pageSize: safePageSize };
  }

  async findTemplate(id: number): Promise<CouponTemplateRow> {
    const [row] = await this.database.db
      .select()
      .from(bizCouponTemplates)
      .where(
        and(eq(bizCouponTemplates.id, id), isNull(bizCouponTemplates.deletedAt)),
      )
      .limit(1);
    if (!row) throw new NotFoundException('优惠券模板不存在');
    return row;
  }

  async createTemplate(
    input: {
      name: string;
      thresholdAmount?: number | undefined;
      discountAmount: number;
      validDays?: number | undefined;
      validFrom?: string | null | undefined;
      validTo?: string | null | undefined;
      status?: 'active' | 'disabled' | undefined;
      sort?: number | undefined;
      remark?: string | null | undefined;
    },
    actorId: number,
  ): Promise<CouponTemplateRow> {
    const values = {
      name: input.name.trim(),
      thresholdAmount: input.thresholdAmount ?? 0,
      discountAmount: input.discountAmount,
      validDays: input.validDays ?? 0,
      validFrom: input.validFrom ? new Date(input.validFrom) : null,
      validTo: input.validTo ? new Date(input.validTo) : null,
      status: input.status ?? ('active' as const),
      sort: input.sort ?? 0,
      remark: input.remark ?? null,
      createdBy: actorId,
      updatedBy: actorId,
    };
    this.assertTemplateInput(values);
    try {
      const inserted = await this.database.db
        .insert(bizCouponTemplates)
        .values(values);
      return this.findTemplate(Number(inserted[0].insertId));
    } catch (error) {
      throw this.mapTemplateWriteError(error);
    }
  }

  async updateTemplate(
    id: number,
    input: {
      name?: string | undefined;
      thresholdAmount?: number | undefined;
      discountAmount?: number | undefined;
      validDays?: number | undefined;
      validFrom?: string | null | undefined;
      validTo?: string | null | undefined;
      status?: 'active' | 'disabled' | undefined;
      sort?: number | undefined;
      remark?: string | null | undefined;
    },
    actorId: number,
  ): Promise<CouponTemplateRow> {
    const current = await this.findTemplate(id);
    const merged = {
      name: input.name?.trim() ?? current.name,
      thresholdAmount: input.thresholdAmount ?? current.thresholdAmount,
      discountAmount: input.discountAmount ?? current.discountAmount,
      validDays: input.validDays ?? current.validDays,
      validFrom:
        input.validFrom === undefined
          ? current.validFrom
          : input.validFrom
            ? new Date(input.validFrom)
            : null,
      validTo:
        input.validTo === undefined
          ? current.validTo
          : input.validTo
            ? new Date(input.validTo)
            : null,
    };
    this.assertTemplateInput(merged);
    try {
      await this.database.db
        .update(bizCouponTemplates)
        .set({ ...merged, updatedBy: actorId })
        .where(eq(bizCouponTemplates.id, id));
    } catch (error) {
      throw this.mapTemplateWriteError(error);
    }
    return this.findTemplate(id);
  }

  /**
   * 停用（软删）模板。
   *
   * **已经发出去的券不受影响** —— 面额与门槛在发券时就快照到持有行了，
   * 模板只是一个「以后还发不发」的开关。所以停用是安全的，
   * 不需要连带处理在用的券（这一点在列表里用 `claimedCount` 让运营看得见）。
   */
  async removeTemplate(id: number, actorId: number): Promise<void> {
    await this.findTemplate(id);
    await this.database.db
      .update(bizCouponTemplates)
      .set({ deletedAt: new Date(), updatedBy: actorId })
      .where(eq(bizCouponTemplates.id, id));
  }

  /** 模板的字段级校验（新增与修改共用，避免两处规则分叉） */
  private assertTemplateInput(input: {
    name: string;
    thresholdAmount: number;
    discountAmount: number;
    validDays: number;
    validFrom: Date | null;
    validTo: Date | null;
  }): void {
    if (!input.name) throw new BadRequestException('名称不能为空');
    if (input.discountAmount <= 0) throw new BadRequestException('面额必须大于 0');
    if (input.thresholdAmount < 0)
      throw new BadRequestException('门槛不能为负');
    if (input.discountAmount > input.thresholdAmount && input.thresholdAmount > 0) {
      throw new BadRequestException('面额不应大于使用门槛');
    }
    if (
      input.validFrom &&
      input.validTo &&
      input.validFrom.getTime() > input.validTo.getTime()
    ) {
      throw new BadRequestException('生效时间不能晚于失效时间');
    }
  }

  /**
   * 名称撞唯一索引（`uq_coupon_template_name`）→ 409，而不是把 1062 抛给前端。
   *
   * **必须沿 `cause` 链找**：drizzle 把底层 mysql2 错误包成了 `DrizzleQueryError`，
   * 顶层 message 只有 "Failed query: insert into ..."，约束名与 errno 在 cause 里。
   * （第一版只看顶层 message，结果重复名称返回了 500 —— 测试当场抓出来。）
   */
  private mapTemplateWriteError(error: unknown): unknown {
    const parts: string[] = [];
    let cursor: unknown = error;
    for (let depth = 0; depth < 5 && cursor; depth += 1) {
      const current = cursor as {
        message?: string;
        code?: string;
        cause?: unknown;
      };
      if (current.message) parts.push(current.message);
      if (current.code) parts.push(String(current.code));
      cursor = current.cause;
    }
    const text = parts.join(' | ');
    if (
      text.includes('uq_coupon_template_name') ||
      text.includes('ER_DUP_ENTRY') ||
      text.includes('1062')
    ) {
      return new ConflictException('同名优惠券已存在');
    }
    return error;
  }
}