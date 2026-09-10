import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, getTableColumns, isNull } from 'drizzle-orm';
import { DatabaseService } from '../../../../database/database.service.js';
import {
  bizBookings,
  bizCustomers,
  bizReviews,
  bizStaffs,
} from '../../../../database/schema/index.js';
import { BizConfigService } from '../../common/biz-config.service.js';
import { StaffPort } from '../../common/ports.js';
import {
  andConditions,
  localDateRange,
  parsePagination,
} from '../../common/query.js';
import { withoutUndefined } from '../../common/tx.js';

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
export class ReviewsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: BizConfigService,
    private readonly staffs: StaffPort,
  ) {}

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
      filter.score !== undefined ? eq(bizReviews.score, filter.score) : undefined,
      filter.status ? eq(bizReviews.status, filter.status) : undefined,
      localDateRange(
        bizReviews.createdAt,
        filter.dateFrom,
        filter.dateTo,
        timeZone,
      ),
    ]);
    const items = await this.database.db
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
      .offset(paging.offset);
    return { items, page: paging.page, pageSize: paging.pageSize };
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
  async create(
    input: CreateReviewInput,
    actorId: number,
  ): Promise<{ id: number }> {
    const [booking] = await this.database.db
      .select({
        id: bizBookings.id,
        customerId: bizBookings.customerId,
        staffId: bizBookings.staffId,
        status: bizBookings.status,
      })
      .from(bizBookings)
      .where(
        and(eq(bizBookings.id, input.bookingId), isNull(bizBookings.deletedAt)),
      )
      .limit(1);
    if (!booking) throw new NotFoundException('预约不存在');
    if (booking.status !== 'completed')
      throw new BadRequestException('只能对状态为 completed 的预约评价');
    await this.assertBookingNotReviewed(input.bookingId);

    try {
      const [result] = await this.database.db.insert(bizReviews).values({
        bookingId: input.bookingId,
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
      return { id: Number(result.insertId) };
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
    input: { status?: 'published' | 'hidden'; isPublic?: boolean },
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
