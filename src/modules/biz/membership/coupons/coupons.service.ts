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
}