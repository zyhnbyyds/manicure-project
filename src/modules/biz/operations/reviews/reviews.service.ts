import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, getTableColumns, isNull, sql } from 'drizzle-orm';
import { DatabaseService } from '../../../../database/database.service';
import {
  bizBookings,
  bizCustomers,
  bizReviews,
  bizStaffs,
} from '../../../../database/schema/index';
import { BizConfigService } from '../../common/biz-config.service';
import {
  type PageResult,
  ReviewPort,
  StaffPort,
  type StaffReviewItem,
} from '../../common/ports';
import {
  andConditions,
  localDateRange,
  parsePagination,
  readCount,
} from '../../common/query';
import { withoutUndefined } from '../../common/tx';

export type CreateReviewInput = {
  bookingId: number;
  score: number;
  content?: string | null | undefined;
  images?: string[] | null | undefined;
  isPublic?: boolean | undefined;
};

export type ReviewFilter = {
  staffId?: number | undefined;
  customerId?: number | undefined;
  score?: number | undefined;
  status?: 'published' | 'hidden' | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
};

/** 当前登录人：用于「美甲师只能看自己的评价」（§20.1） */
export type ReviewViewer = { userId: number; permissions: string[] };

/**
 * 服务评价（§20.1）。
 *
 * - 一单一评：`uq_review_booking` 唯一索引 + 插入前显式查重（软删记录同样占位）；
 * - 只能评价 `status='completed'` 的预约；
 * - 隐藏（`published`/`hidden`）用于处理恶意评价，删除一律软删。
 */
@Injectable()
export class ReviewsService extends ReviewPort {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: BizConfigService,
    private readonly staffs: StaffPort,
  ) {
    super();
  }

  /* ---------------- app 域端口（S3：本人评价） ---------------- */

  override async listByStaff(
    staffId: number,
    page: number,
    pageSize: number,
  ): Promise<PageResult<StaffReviewItem>> {
    const paging = parsePagination(page, pageSize);
    const where = and(
      eq(bizReviews.staffId, staffId),
      isNull(bizReviews.deletedAt),
      // 被隐藏的评价不给本人看（§20.1：隐藏就是按下不表）
      eq(bizReviews.status, 'published'),
    );
    const [items, counted] = await Promise.all([
      this.database.db
        .select({
          id: bizReviews.id,
          bookingId: bizReviews.bookingId,
          score: bizReviews.score,
          content: bizReviews.content,
          reply: bizReviews.reply,
          createdAt: bizReviews.createdAt,
          bookingNo: bizBookings.bookingNo,
        })
        .from(bizReviews)
        .leftJoin(bizBookings, eq(bizBookings.id, bizReviews.bookingId))
        .where(where)
        .orderBy(desc(bizReviews.id))
        .limit(paging.pageSize)
        .offset(paging.offset),
      // 同文件下的另一个 `count` 局部量在 averageScore 里（函数作用域），这里用 sql 避开同名遮蔽
      this.database.db
        .select({ value: sql<number>`COUNT(*)` })
        .from(bizReviews)
        .leftJoin(bizBookings, eq(bizBookings.id, bizReviews.bookingId))
        .where(where),
    ]);
    return {
      items,
      total: readCount(counted),
      page: paging.page,
      pageSize: paging.pageSize,
    };
  }

  override async averageScore(
    staffId: number,
  ): Promise<{ count: number; average: number | null }> {
    const [row] = await this.database.db
      .select({
        count: sql<number>`COUNT(*)`,
        total: sql<number>`COALESCE(SUM(${bizReviews.score}), 0)`,
      })
      .from(bizReviews)
      .where(
        and(
          eq(bizReviews.staffId, staffId),
          isNull(bizReviews.deletedAt),
          eq(bizReviews.status, 'published'),
        ),
      );
    const count = Number(row?.count ?? 0);
    if (!count) return { count: 0, average: null };
    return {
      count,
      // 保留一位小数：4.75 分显示成 4.8，比 4.7500000 好看
      average: Math.round((Number(row?.total ?? 0) / count) * 10) / 10,
    };
  }

  async list(
    page: number,
    pageSize: number,
    filter: ReviewFilter,
    viewer: ReviewViewer,
  ) {
    const paging = parsePagination(page, pageSize);
    const timeZone = (await this.config.booking()).timezone;
    const staffScope = await this.resolveStaffScope(viewer);
    const conditions = andConditions([
      isNull(bizReviews.deletedAt),
      filter.staffId !== undefined
        ? eq(bizReviews.staffId, filter.staffId)
        : undefined,
      staffScope !== undefined ? eq(bizReviews.staffId, staffScope) : undefined,
      filter.customerId !== undefined
        ? eq(bizReviews.customerId, filter.customerId)
        : undefined,
      filter.score !== undefined
        ? eq(bizReviews.score, filter.score)
        : undefined,
      filter.status ? eq(bizReviews.status, filter.status) : undefined,
      localDateRange(
        bizReviews.createdAt,
        filter.dateFrom,
        filter.dateTo,
        timeZone,
      ),
    ]);
    const [items, counted] = await Promise.all([
      this.database.db
        .select({
          ...getTableColumns(bizReviews),
          customerName: bizCustomers.name,
          staffName: bizStaffs.nickname,
          bookingNo: bizBookings.bookingNo,
        })
        .from(bizReviews)
        .leftJoin(bizCustomers, eq(bizCustomers.id, bizReviews.customerId))
        .leftJoin(bizStaffs, eq(bizStaffs.id, bizReviews.staffId))
        .leftJoin(bizBookings, eq(bizBookings.id, bizReviews.bookingId))
        .where(conditions)
        .orderBy(desc(bizReviews.id))
        .limit(paging.pageSize)
        .offset(paging.offset),
      // 这里用 `sql` 而不是 drizzle 的 `count()`：同文件下有个名为 `count` 的局部量（平均分），
      // 避开同名遮蔽，读起来也不岐义
      this.database.db
        .select({ value: sql<number>`COUNT(*)` })
        .from(bizReviews)
        .leftJoin(bizCustomers, eq(bizCustomers.id, bizReviews.customerId))
        .leftJoin(bizStaffs, eq(bizStaffs.id, bizReviews.staffId))
        .leftJoin(bizBookings, eq(bizBookings.id, bizReviews.bookingId))
        .where(conditions),
    ]);
    return {
      items,
      total: readCount(counted),
      page: paging.page,
      pageSize: paging.pageSize,
    };
  }

  async findOne(id: number) {
    const [row] = await this.database.db
      .select()
      .from(bizReviews)
      .where(and(eq(bizReviews.id, id), isNull(bizReviews.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundException('评价不存在');
    return row;
  }

  /** 后台代录：仍受「一单一评」约束（§9.11） */
  /** 可评价的预约：存在 + 已完成（§20.1） */
  private async requireReviewableBooking(bookingId: number): Promise<{
    id: number;
    customerId: number;
    staffId: number;
    status: string;
  }> {
    const [booking] = await this.database.db
      .select({
        id: bizBookings.id,
        customerId: bizBookings.customerId,
        staffId: bizBookings.staffId,
        status: bizBookings.status,
      })
      .from(bizBookings)
      .where(and(eq(bizBookings.id, bookingId), isNull(bizBookings.deletedAt)))
      .limit(1);
    if (!booking) throw new NotFoundException('预约不存在');
    if (booking.status !== 'completed')
      throw new BadRequestException('只能对状态为 completed 的预约评价');
    return booking;
  }

  async create(
    input: CreateReviewInput,
    actorId: number,
  ): Promise<{ id: number }> {
    const booking = await this.requireReviewableBooking(input.bookingId);
    const { id } = await this.insertReview(booking, input, actorId);
    return { id };
  }

  override async createForCustomer(
    customerId: number,
    input: {
      bookingId: number;
      score: number;
      content?: string | undefined;
      images?: string[] | undefined;
    },
    actorId: number | null,
  ): Promise<{ id: number; createdAt: Date }> {
    const booking = await this.requireReviewableBooking(input.bookingId);
    // 归属在服务端按预约事实判定：`customer_id` 绝不取自客户端入参
    if (booking.customerId !== customerId)
      throw new ForbiddenException('只能评价自己的预约');
    return this.insertReview(
      booking,
      { ...input, isPublic: true },
      actorId ?? 0,
    );
  }

  /** 落库：一单一评由「显式查重 + 唯一索引」双保险（§20.1） */
  private async insertReview(
    booking: { id: number; customerId: number; staffId: number },
    input: CreateReviewInput,
    actorId: number | null,
  ): Promise<{ id: number; createdAt: Date }> {
    await this.assertBookingNotReviewed(booking.id);
    try {
      const [result] = await this.database.db.insert(bizReviews).values({
        bookingId: booking.id,
        customerId: booking.customerId,
        staffId: booking.staffId,
        score: input.score,
        content: input.content ?? null,
        images: input.images ?? null,
        isPublic: input.isPublic ?? true,
        status: 'published',
        createdBy: actorId,
        updatedBy: actorId,
      });
      const id = Number(result.insertId);
      // 回读 created_at 而不是用 JS 的 now：时间以库里那一份为准
      const [row] = await this.database.db
        .select({ createdAt: bizReviews.createdAt })
        .from(bizReviews)
        .where(eq(bizReviews.id, id))
        .limit(1);
      return { id, createdAt: row?.createdAt ?? new Date() };
    } catch (error) {
      // 并发下靠唯一索引兜底（§20.1 一单一评）
      if (isDuplicateKeyError(error))
        throw new ConflictException('该预约已评价（一单一评）');
      throw error;
    }
  }

  /** 店家回复 */
  async reply(id: number, reply: string, actorId: number): Promise<void> {
    await this.findOne(id);
    const result = await this.database.db
      .update(bizReviews)
      .set({ reply, repliedAt: new Date(), updatedBy: actorId })
      .where(and(eq(bizReviews.id, id), isNull(bizReviews.deletedAt)));
    if (!result[0].affectedRows) throw new NotFoundException('评价不存在');
  }

  /** `published` / `hidden` 切换 + 是否公开展示 */
  async updateVisibility(
    id: number,
    input: {
      status?: 'published' | 'hidden' | undefined;
      isPublic?: boolean | undefined;
    },
    actorId: number,
  ): Promise<void> {
    await this.findOne(id);
    const patch = withoutUndefined(input);
    if (!Object.keys(patch).length)
      throw new BadRequestException('请提供 status 或 isPublic');
    const result = await this.database.db
      .update(bizReviews)
      .set({ ...patch, updatedBy: actorId })
      .where(and(eq(bizReviews.id, id), isNull(bizReviews.deletedAt)));
    if (!result[0].affectedRows) throw new NotFoundException('评价不存在');
  }

  /** 软删（保留数据，§20.1） */
  async remove(id: number, actorId: number): Promise<void> {
    await this.findOne(id);
    await this.database.db
      .update(bizReviews)
      .set({ deletedAt: new Date(), updatedBy: actorId })
      .where(and(eq(bizReviews.id, id), isNull(bizReviews.deletedAt)));
  }

  /**
   * 一单一评查重：**不过滤软删**——软删记录仍占用 `uq_review_booking`，
   * 先查出来给 409，避免插入时撞唯一索引变成 500。
   */
  private async assertBookingNotReviewed(bookingId: number): Promise<void> {
    const [existing] = await this.database.db
      .select({ id: bizReviews.id })
      .from(bizReviews)
      .where(eq(bizReviews.bookingId, bookingId))
      .limit(1);
    if (existing) throw new ConflictException('该预约已评价（一单一评）');
  }

  /**
   * 美甲师只能看自己的评价（§20.1）；具备 `biz:booking:manageall` 或超管不受限。
   * 返回 `undefined` = 不加限制。
   */
  private async resolveStaffScope(
    viewer: ReviewViewer,
  ): Promise<number | undefined> {
    if (
      viewer.permissions.includes('*:*:*') ||
      viewer.permissions.includes('biz:booking:manageall')
    )
      return undefined;
    const staff = await this.staffs.findByUserId(viewer.userId);
    return staff?.id;
  }
}

/** MySQL 唯一键冲突（`ER_DUP_ENTRY` / errno 1062） */
function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { errno?: number; code?: string };
  return candidate.errno === 1062 || candidate.code === 'ER_DUP_ENTRY';
}
