import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { DatabaseService } from '../../../../database/database.service';
import {
  bizCouponTemplates,
  bizCustomerCoupons,
} from '../../../../database/schema/index.js';
import { BizConfigService } from '../../common/biz-config.service.js';
import { buildDocNo } from '../../common/doc-no.js';
import { parsePagination } from '../../common/query.js';
import type { BizDatabase } from '../../common/tx.js';

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

    // 单号「主键回填」：先插占位号，拿到自增 id 再回填正式号。
    // 不能「查当日最大号 +1」—— 并发下必然重号（单号有唯一索引，会直接 1062）。
    const inserted = await this.database.db.insert(bizCustomerCoupons).values({
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

    await this.database.db
      .update(bizCustomerCoupons)
      .set({ couponNo: buildDocNo('X', id, timezone, now) })
      .where(eq(bizCustomerCoupons.id, id));

    const [row] = await this.database.db
      .select()
      .from(bizCustomerCoupons)
      .where(eq(bizCustomerCoupons.id, id))
      .limit(1);
    if (!row) throw new NotFoundException('发券失败，请重试');
    return row;
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
    items: (CustomerCouponRow & { displayStatus: CustomerCouponStatus })[];
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
      .select()
      .from(bizCustomerCoupons)
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
  async redeemForBooking(
    tx: BizDatabase,
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
    const [row] = await tx
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

    const discountAmount = Math.min(
      row.discountAmount,
      Math.max(input.baseAmount, 0),
    );

    const result = await tx
      .update(bizCustomerCoupons)
      .set({
        status: 'used',
        usedBookingId: input.bookingId ?? null,
        usedAt: now,
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
}