import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  asc,
  count,
  eq,
  exists,
  inArray,
  isNull,
  ne,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { DatabaseService } from '../../../../database/database.service.js';
import {
  bizBookings,
  bizServiceItems,
  bizStaffStores,
  bizStaffs,
  bizStaffServiceItems,
  sysStores,
} from '../../../../database/schema/index.js';
import type { RequestActor } from '../../../../common/data-scope/data-scope.js';
import {
  resolveStoreScope,
  storeFilterIds,
} from '../../../../common/data-scope/store-scope.js';
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
  /**
   * 门店筛选：只看**能服务这家店**的美甲师（含未配门店的 —— 空集合 = 全部门店）。
   * 不传则按操作人的可见范围（店长限本店 / 超管全部）。
   */
  storeId?: number;
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
    actor?: RequestActor | null,
  ): Promise<PageResult<StaffRow & { stores: { id: number; name: string }[] }>> {
    const conditions = [isNull(bizStaffs.deletedAt)];
    const nickname = keywordLike(bizStaffs.nickname, filter.keyword);
    const phone = keywordLike(bizStaffs.phone, filter.keyword);
    if (nickname && phone) {
      const clause = or(nickname, phone);
      if (clause) conditions.push(clause);
    }
    if (filter.status) conditions.push(eq(bizStaffs.status, filter.status));

    // 门店维度：显式 `?storeId=` → 切换器的 `x-store-id` 头 → 可见范围（店长限本店）
    const store = await resolveStoreScope(
      this.database.db,
      actor ?? null,
      filter.storeId,
    );
    const storeFilter = this.staffStoreCondition(storeFilterIds(store));
    if (storeFilter) conditions.push(storeFilter);

    const rows = await this.database.db
      .select()
      .from(bizStaffs)
      .where(and(...conditions))
      .orderBy(asc(bizStaffs.sort), asc(bizStaffs.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const items = await this.withStores(rows);
    return { items, page, pageSize };
  }

  /**
   * 「这些店能用的人」条件（`null` = 不筛）。
   *
   * `biz_staff_store` 的约定是**空集合 = 可服务全部门店**（与「可做项目」同款），
   * 所以查某家店时必须把「没配过门店的人」也留下 —— 他们恰恰是默认全店可用的那批，
   * 漏掉就等于「新上的美甲师在哪家店都约不到」。
   */
  private staffStoreCondition(storeIds: number[] | null): SQL | undefined {
    if (!storeIds || !storeIds.length) return undefined;
    return or(
      notExists(
        this.database.db
          .select({ one: sql`1` })
          .from(bizStaffStores)
          .where(eq(bizStaffStores.staffId, bizStaffs.id)),
      ),
      exists(
        this.database.db
          .select({ one: sql`1` })
          .from(bizStaffStores)
          .where(
            and(
              eq(bizStaffStores.staffId, bizStaffs.id),
              inArray(bizStaffStores.storeId, storeIds),
            ),
          ),
      ),
    );
  }

  /** 批量补「服务门店」（一次查询，避免列表 N+1）；空数组 = 全部门店 */
  private async withStores<T extends { id: number }>(
    rows: T[],
  ): Promise<(T & { stores: { id: number; name: string }[] })[]> {
    if (!rows.length) return [];
    const links = await this.database.db
      .select({
        staffId: bizStaffStores.staffId,
        id: sysStores.id,
        name: sysStores.name,
      })
      .from(bizStaffStores)
      .innerJoin(sysStores, eq(sysStores.id, bizStaffStores.storeId))
      .where(
        and(
          inArray(
            bizStaffStores.staffId,
            rows.map((row) => row.id),
          ),
          isNull(sysStores.deletedAt),
        ),
      )
      .orderBy(asc(sysStores.sort), asc(sysStores.id));
    const grouped = new Map<number, { id: number; name: string }[]>();
    for (const link of links) {
      const list = grouped.get(link.staffId) ?? [];
      list.push({ id: link.id, name: link.name });
      grouped.set(link.staffId, list);
    }
    return rows.map((row) => ({ ...row, stores: grouped.get(row.id) ?? [] }));
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
      throw new ConflictException(
        `美甲师「${staff.nickname}」已停用，不可被预约`,
      );
    return staff;
  }

  /**
   * 启用中的美甲师（后台预约弹窗 / 小程序目录用）。
   *
   * `storeId` 传了 → 只回**能服务这家店**的人（含未配门店的，空集合 = 全部门店），
   * 不传 → 不过滤（保持旧调用语义）。
   */
  async listActive(storeId?: number): Promise<StaffRow[]> {
    const conditions = [
      eq(bizStaffs.status, 'active'),
      isNull(bizStaffs.deletedAt),
    ];
    const storeFilter =
      storeId === undefined ? undefined : this.staffStoreCondition([storeId]);
    if (storeFilter) conditions.push(storeFilter);
    return this.database.db
      .select()
      .from(bizStaffs)
      .where(and(...conditions))
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

  /** 手机号匹配：**不过滤软删与停用**，由调用方判断（见 ports.ts 的说明） */
  async findByPhone(phone: string): Promise<StaffRow | null> {
    const [staff] = await this.database.db
      .select()
      .from(bizStaffs)
      .where(eq(bizStaffs.phone, phone))
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

  /* ---------------- 可服务门店（连锁直营，阶段 1.9） ---------------- */

  /** 整体替换（物理删表，§3 豁免）：空数组 = 恢复「可服务全部门店」 */
  async setStores(
    staffId: number,
    storeIds: number[],
    actorId: number,
  ): Promise<void> {
    await this.findOne(staffId);
    const unique = [
      ...new Set(storeIds.filter((id) => Number.isInteger(id) && id > 0)),
    ];
    if (unique.length) {
      const rows = await this.database.db
        .select({
          id: sysStores.id,
          name: sysStores.name,
          status: sysStores.status,
        })
        .from(sysStores)
        .where(
          and(inArray(sysStores.id, unique), isNull(sysStores.deletedAt)),
        );
      const found = new Map(rows.map((row) => [row.id, row]));
      const missing = unique.filter((id) => !found.has(id));
      if (missing.length)
        throw new BadRequestException(
          `门店不存在或已删除：#${missing.join('、#')}`,
        );
      const disabled = unique
        .map((id) => found.get(id))
        .filter((row) => row !== undefined && row.status !== 'active');
      if (disabled.length)
        throw new BadRequestException(
          `门店已停用，不能配置给美甲师：${disabled
            .map((row) => row?.name)
            .join('、')}`,
        );
    }
    await this.database.db.transaction(async (tx) => {
      await tx
        .delete(bizStaffStores)
        .where(eq(bizStaffStores.staffId, staffId));
      if (unique.length) {
        await tx
          .insert(bizStaffStores)
          .values(unique.map((storeId) => ({ staffId, storeId })));
      }
    });
    void actorId;
  }

  /** 详情 / 授权弹窗回填：该美甲师的服务门店（含名称）；空数组 = 全部门店 */
  async getStores(staffId: number): Promise<{ id: number; name: string }[]> {
    await this.findOne(staffId);
    const [row] = await this.withStores([{ id: staffId }]);
    return row?.stores ?? [];
  }

  /** 一个后台账号只能绑定一位美甲师，否则 §8.2 的数据权限无法判定 */
  private async assertUserNotBound(
    userId: number,
    excludeStaffId?: number,
  ): Promise<void> {
    const conditions = [
      eq(bizStaffs.userId, userId),
      isNull(bizStaffs.deletedAt),
    ];
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
