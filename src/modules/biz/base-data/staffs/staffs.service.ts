import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { DatabaseService } from '../../../../database/database.service.js';
import {
  bizBookings,
  bizServiceItems,
  bizStaffs,
  bizStaffServiceItems,
} from '../../../../database/schema/index.js';
import {
  StaffPort,
  type PageResult,
  type StaffRow,
} from '../../common/ports.js';
import { keywordLike } from '../../common/query.js';
import { withoutUndefined } from '../../common/tx.js';
import type { BizTx } from '../../common/tx.js';

/** 未完成预约（§6.4）：存在即拒绝删除 / 停用美甲师 */
const UNFINISHED_BOOKING_STATUSES = [
  'pending',
  'confirmed',
  'arrived',
] as const;

const SAMPLE_BOOKING_LIMIT = 3;

export type CreateStaffInput = {
  userId?: number | null | undefined;
  nickname: string;
  avatar?: string | null | undefined;
  phone?: string | null | undefined;
  bio?: string | null | undefined;
  status?: 'active' | 'disabled' | undefined;
  sort?: number | undefined;
  remark?: string | null | undefined;
};

export type UpdateStaffInput = {
  [K in keyof CreateStaffInput]?: CreateStaffInput[K] | undefined;
};

export type StaffListFilter = {
  keyword?: string;
  status?: 'active' | 'disabled';
};

/**
 * 美甲师档案（§4.3 / §9.2 / §22）。
 *
 * `user_id` 可空（美甲师未必有后台账号）；「可做项目」空集合 = 可做全部。
 */
@Injectable()
export class StaffsService extends StaffPort {
  constructor(private readonly database: DatabaseService) {
    super();
  }

  async list(
    page: number,
    pageSize: number,
    filter: StaffListFilter,
  ): Promise<PageResult<StaffRow>> {
    const conditions = [isNull(bizStaffs.deletedAt)];
    const nickname = keywordLike(bizStaffs.nickname, filter.keyword);
    const phone = keywordLike(bizStaffs.phone, filter.keyword);
    if (nickname && phone) {
      const clause = or(nickname, phone);
      if (clause) conditions.push(clause);
    }
    if (filter.status) conditions.push(eq(bizStaffs.status, filter.status));
    const items = await this.database.db
      .select()
      .from(bizStaffs)
      .where(and(...conditions))
      .orderBy(asc(bizStaffs.sort), asc(bizStaffs.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return { items, page, pageSize };
  }

  async findOne(id: number): Promise<StaffRow> {
    const [staff] = await this.database.db
      .select()
      .from(bizStaffs)
      .where(and(eq(bizStaffs.id, id), isNull(bizStaffs.deletedAt)))
      .limit(1);
    if (!staff) throw new NotFoundException('美甲师不存在');
    return staff;
  }

  async create(
    input: CreateStaffInput,
    actorId: number,
  ): Promise<{ id: number }> {
    if (input.userId) await this.assertUserNotBound(input.userId);
    const result = await this.database.db.insert(bizStaffs).values({
      ...withoutUndefined(input),
      createdBy: actorId,
      updatedBy: actorId,
    });
    return { id: Number(result[0].insertId) };
  }

  async update(
    id: number,
    input: UpdateStaffInput,
    actorId: number,
  ): Promise<void> {
    const current = await this.findOne(id);
    if (input.userId) await this.assertUserNotBound(input.userId, id);
    if (input.status === 'disabled' && current.status !== 'disabled')
      await this.assertNoUnfinishedBookings(current, '停用');
    const result = await this.database.db
      .update(bizStaffs)
      .set({ ...withoutUndefined(input), updatedBy: actorId })
      .where(and(eq(bizStaffs.id, id), isNull(bizStaffs.deletedAt)));
    if (!result[0].affectedRows) throw new NotFoundException('美甲师不存在');
  }

  async remove(id: number, actorId: number): Promise<void> {
    const staff = await this.findOne(id);
    await this.assertNoUnfinishedBookings(staff, '删除');
    const result = await this.database.db
      .update(bizStaffs)
      .set({ deletedAt: new Date(), updatedBy: actorId })
      .where(and(eq(bizStaffs.id, id), isNull(bizStaffs.deletedAt)));
    if (!result[0].affectedRows) throw new NotFoundException('美甲师不存在');
  }

  async requireActive(id: number, tx?: BizTx): Promise<StaffRow> {
    const executor = tx ?? this.database.db;
    const [staff] = await executor
      .select()
      .from(bizStaffs)
      .where(and(eq(bizStaffs.id, id), isNull(bizStaffs.deletedAt)))
      .limit(1);
    if (!staff) throw new NotFoundException('美甲师不存在');
    if (staff.status !== 'active')
      throw new ConflictException(`美甲师「${staff.nickname}」已停用，不可被预约`);
    return staff;
  }

  async listActive(): Promise<StaffRow[]> {
    return this.database.db
      .select()
      .from(bizStaffs)
      .where(
        and(eq(bizStaffs.status, 'active'), isNull(bizStaffs.deletedAt)),
      )
      .orderBy(asc(bizStaffs.sort), asc(bizStaffs.id));
  }

  async findByUserId(userId: number): Promise<StaffRow | null> {
    const [staff] = await this.database.db
      .select()
      .from(bizStaffs)
      .where(and(eq(bizStaffs.userId, userId), isNull(bizStaffs.deletedAt)))
      .orderBy(asc(bizStaffs.id))
      .limit(1);
    return staff ?? null;
  }

  /** null = 可做全部项目；数组 = 白名单（§22） */
  async allowedServiceItemIds(
    staffId: number,
    tx?: BizTx,
  ): Promise<number[] | null> {
    const executor = tx ?? this.database.db;
    const rows = await executor
      .select({ serviceItemId: bizStaffServiceItems.serviceItemId })
      .from(bizStaffServiceItems)
      .where(eq(bizStaffServiceItems.staffId, staffId))
      .orderBy(asc(bizStaffServiceItems.sort), asc(bizStaffServiceItems.id));
    if (!rows.length) return null;
    return rows.map((row) => row.serviceItemId);
  }

  /** 整体替换（物理删表，§3 豁免）：空数组 = 恢复「可做全部」 */
  async setServiceItems(
    staffId: number,
    serviceItemIds: number[],
    actorId: number,
  ): Promise<void> {
    await this.findOne(staffId);
    const unique = [
      ...new Set(serviceItemIds.filter((id) => Number.isInteger(id) && id > 0)),
    ];
    if (unique.length) {
      const rows = await this.database.db
        .select({
          id: bizServiceItems.id,
          name: bizServiceItems.name,
          status: bizServiceItems.status,
        })
        .from(bizServiceItems)
        .where(
          and(
            inArray(bizServiceItems.id, unique),
            isNull(bizServiceItems.deletedAt),
          ),
        );
      const found = new Map(rows.map((row) => [row.id, row]));
      const missing = unique.filter((id) => !found.has(id));
      if (missing.length)
        throw new BadRequestException(
          `服务项目不存在或已删除：#${missing.join('、#')}`,
        );
      const ordered: { id: number; name: string; status: string }[] = [];
      for (const id of unique) {
        const row = found.get(id);
        if (row) ordered.push(row);
      }
      const disabled = ordered.filter((row) => row.status !== 'active');
      if (disabled.length)
        throw new BadRequestException(
          `服务项目已停用，不能配置给美甲师：${disabled
            .map((row) => row.name)
            .join('、')}`,
        );
    }
    await this.database.db.transaction(async (tx) => {
      await tx
        .delete(bizStaffServiceItems)
        .where(eq(bizStaffServiceItems.staffId, staffId));
      if (unique.length) {
        await tx.insert(bizStaffServiceItems).values(
          unique.map((serviceItemId, index) => ({
            staffId,
            serviceItemId,
            sort: index,
          })),
        );
      }
    });
    void actorId;
  }

  async getServiceItems(
    staffId: number,
  ): Promise<{ id: number; name: string }[]> {
    return this.database.db
      .select({ id: bizServiceItems.id, name: bizServiceItems.name })
      .from(bizStaffServiceItems)
      .innerJoin(
        bizServiceItems,
        eq(bizStaffServiceItems.serviceItemId, bizServiceItems.id),
      )
      .where(
        and(
          eq(bizStaffServiceItems.staffId, staffId),
          isNull(bizServiceItems.deletedAt),
        ),
      )
      .orderBy(asc(bizStaffServiceItems.sort), asc(bizServiceItems.id));
  }

  /** 一个后台账号只能绑定一位美甲师，否则 §8.2 的数据权限无法判定 */
  private async assertUserNotBound(
    userId: number,
    excludeStaffId?: number,
  ): Promise<void> {
    const conditions = [eq(bizStaffs.userId, userId), isNull(bizStaffs.deletedAt)];
    if (excludeStaffId !== undefined)
      conditions.push(ne(bizStaffs.id, excludeStaffId));
    const [bound] = await this.database.db
      .select({ id: bizStaffs.id, nickname: bizStaffs.nickname })
      .from(bizStaffs)
      .where(and(...conditions))
      .limit(1);
    if (bound)
      throw new ConflictException(
        `该后台账号已绑定美甲师「${bound.nickname}」(#${bound.id})`,
      );
  }

  private async assertNoUnfinishedBookings(
    staff: StaffRow,
    action: string,
  ): Promise<void> {
    const conditions = and(
      eq(bizBookings.staffId, staff.id),
      inArray(bizBookings.status, [...UNFINISHED_BOOKING_STATUSES]),
      isNull(bizBookings.deletedAt),
    );
    const [row] = await this.database.db
      .select({ value: count() })
      .from(bizBookings)
      .where(conditions);
    const total = Number(row?.value ?? 0);
    if (!total) return;
    const samples = await this.database.db
      .select({ bookingNo: bizBookings.bookingNo })
      .from(bizBookings)
      .where(conditions)
      .limit(SAMPLE_BOOKING_LIMIT);
    const nos = samples.map((sample) => sample.bookingNo).join('、');
    throw new ConflictException(
      `美甲师「${staff.nickname}」存在 ${total} 条未完成预约（${nos}），不能${action}；请先处理这些预约`,
    );
  }
}
