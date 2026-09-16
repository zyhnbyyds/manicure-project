import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, eq, isNull, ne } from 'drizzle-orm';
import { readCount } from '../../common/query';
import { DatabaseService } from '../../../../database/database.service';
import {
  bizCustomers,
  bizMemberLevels,
} from '../../../../database/schema/index';
import { withoutUndefined } from '../../common/tx';
import type { BizDatabase } from '../../common/tx';

export type MemberLevelRow = typeof bizMemberLevels.$inferSelect;

export type MemberLevelInput = {
  name: string;
  discountPermille?: number | undefined;
  upgradeAmount?: number | undefined;
  sort?: number | undefined;
  status?: 'active' | 'disabled' | undefined;
  remark?: string | null | undefined;
};

export type MemberLevelListFilter = {
  status?: 'active' | 'disabled' | undefined;
};

/** 更新入参：每个字段都显式带 `undefined`（`exactOptionalPropertyTypes` 下才能直接透传 zod 结果） */
export type UpdateMemberLevelInput = {
  name?: string | undefined;
  discountPermille?: number | undefined;
  upgradeAmount?: number | undefined;
  sort?: number | undefined;
  status?: 'active' | 'disabled' | undefined;
  remark?: string | null | undefined;
};

/**
 * 取「能升级到的等级」：`status='active'` 且 `upgrade_amount <= totalSpent` 中 `sort` 最大的一个。
 *
 * 单调不减的门槛保证了这个结果与遍历顺序无关（§15.2），因此这里只做纯函数计算，
 * `syncLevel` / `recount` / `recountAllLevels` 共用同一口径。
 */
export function pickUpgradeLevel<
  T extends {
    id: number;
    sort: number;
    status: string;
    upgradeAmount: number;
  },
>(levels: T[], totalSpent: number): T | null {
  let best: T | null = null;
  for (const level of levels) {
    if (level.status !== 'active') continue;
    if (level.upgradeAmount > totalSpent) continue;
    if (
      best === null ||
      level.sort > best.sort ||
      (level.sort === best.sort && level.id > best.id)
    ) {
      best = level;
    }
  }
  return best;
}

/** 最低启用等级（入会默认等级，§15.1） */
export function pickLowestLevel<
  T extends { id: number; sort: number; status: string },
>(levels: T[]): T | null {
  let best: T | null = null;
  for (const level of levels) {
    if (level.status !== 'active') continue;
    if (
      best === null ||
      level.sort < best.sort ||
      (level.sort === best.sort && level.id < best.id)
    ) {
      best = level;
    }
  }
  return best;
}

/**
 * 会员等级维护（§15.2）。
 *
 * 红线：`upgrade_amount` 必须随 `sort` 单调不减，否则「取 sort 最大的达标等级」会依赖遍历顺序；
 * 保存时校验，历史数据请用 `POST /biz/members/:id/recount` 或 `recountMemberLevels` 纠正。
 */
@Injectable()
export class MemberLevelsService {
  constructor(private readonly database: DatabaseService) {}

  async list(
    page: number,
    pageSize: number,
    filter: MemberLevelListFilter = {},
  ): Promise<{
    items: MemberLevelRow[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const conditions = [isNull(bizMemberLevels.deletedAt)];
    if (filter.status)
      conditions.push(eq(bizMemberLevels.status, filter.status));
    const where = and(...conditions);
    const [items, counted] = await Promise.all([
      this.database.db
        .select()
        .from(bizMemberLevels)
        .where(where)
        .orderBy(asc(bizMemberLevels.sort), asc(bizMemberLevels.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.database.db
        .select({ value: count() })
        .from(bizMemberLevels)
        .where(where),
    ]);
    return { items, total: readCount(counted), page, pageSize };
  }

  /** 全量等级（含停用）：算价、升级判定、列表补名共用一次查询 */
  async allLevels(
    executor: BizDatabase = this.database.db,
  ): Promise<MemberLevelRow[]> {
    return executor
      .select()
      .from(bizMemberLevels)
      .where(isNull(bizMemberLevels.deletedAt))
      .orderBy(asc(bizMemberLevels.sort), asc(bizMemberLevels.id));
  }

  async findOne(id: number): Promise<MemberLevelRow> {
    const [level] = await this.database.db
      .select()
      .from(bizMemberLevels)
      .where(and(eq(bizMemberLevels.id, id), isNull(bizMemberLevels.deletedAt)))
      .limit(1);
    if (!level) throw new NotFoundException('会员等级不存在');
    return level;
  }

  /** 折扣率千分比（无等级 = 1000） */
  async discountPermilleOf(
    levelId: number | null,
    executor: BizDatabase = this.database.db,
  ): Promise<number> {
    if (levelId === null) return 1000;
    const [level] = await executor
      .select({ discountPermille: bizMemberLevels.discountPermille })
      .from(bizMemberLevels)
      .where(
        and(eq(bizMemberLevels.id, levelId), isNull(bizMemberLevels.deletedAt)),
      )
      .limit(1);
    return level?.discountPermille ?? 1000;
  }

  async create(
    input: MemberLevelInput,
    actorId: number,
  ): Promise<{ id: number }> {
    await this.assertNameUnique(input.name);
    const sort = Math.trunc(input.sort ?? 0);
    const upgradeAmount = Math.trunc(input.upgradeAmount ?? 0);
    const discountPermille = Math.trunc(input.discountPermille ?? 1000);
    assertDiscountPermille(discountPermille);
    assertUpgradeAmount(upgradeAmount);
    await this.assertMonotonic(sort, upgradeAmount);

    const result = await this.database.db.insert(bizMemberLevels).values({
      ...withoutUndefined({
        name: input.name,
        discountPermille,
        upgradeAmount,
        sort,
        status: input.status,
        remark: input.remark,
      }),
      createdBy: actorId,
      updatedBy: actorId,
    });
    return { id: Number(result[0].insertId) };
  }

  async update(
    id: number,
    input: UpdateMemberLevelInput,
    actorId: number,
  ): Promise<void> {
    const current = await this.findOne(id);
    if (input.name !== undefined) await this.assertNameUnique(input.name, id);

    const sort = Math.trunc(input.sort ?? current.sort);
    const upgradeAmount = Math.trunc(
      input.upgradeAmount ?? current.upgradeAmount,
    );
    const discountPermille = Math.trunc(
      input.discountPermille ?? current.discountPermille,
    );
    assertDiscountPermille(discountPermille);
    assertUpgradeAmount(upgradeAmount);
    if (input.sort !== undefined || input.upgradeAmount !== undefined)
      await this.assertMonotonic(sort, upgradeAmount, id);

    const result = await this.database.db
      .update(bizMemberLevels)
      .set({
        ...withoutUndefined({
          name: input.name,
          discountPermille,
          upgradeAmount,
          sort,
          status: input.status,
          remark: input.remark,
        }),
        updatedBy: actorId,
      })
      .where(
        and(eq(bizMemberLevels.id, id), isNull(bizMemberLevels.deletedAt)),
      );
    if (!result[0].affectedRows) throw new NotFoundException('会员等级不存在');
  }

  /** 软删；有会员挂在该等级时拒绝（§9.6） */
  async remove(id: number, actorId: number): Promise<void> {
    await this.findOne(id);
    const [used] = await this.database.db
      .select({ id: bizCustomers.id })
      .from(bizCustomers)
      .where(and(eq(bizCustomers.levelId, id), isNull(bizCustomers.deletedAt)))
      .limit(1);
    if (used) throw new ConflictException('有会员处于该等级，不能删除');

    const result = await this.database.db
      .update(bizMemberLevels)
      .set({ deletedAt: new Date(), updatedBy: actorId })
      .where(
        and(eq(bizMemberLevels.id, id), isNull(bizMemberLevels.deletedAt)),
      );
    if (!result[0].affectedRows) throw new NotFoundException('会员等级不存在');
  }

  /** 名称唯一：不过滤软删（软删行仍占用唯一键，§4.3 坑 1） */
  private async assertNameUnique(
    name: string,
    excludeId?: number,
  ): Promise<void> {
    const conditions = [eq(bizMemberLevels.name, name)];
    if (excludeId !== undefined)
      conditions.push(ne(bizMemberLevels.id, excludeId));
    const [duplicate] = await this.database.db
      .select({ id: bizMemberLevels.id })
      .from(bizMemberLevels)
      .where(and(...conditions))
      .limit(1);
    if (duplicate) throw new ConflictException('等级名称已存在');
  }

  /** 门槛必须随 sort 单调不减（§15.2） */
  private async assertMonotonic(
    sort: number,
    upgradeAmount: number,
    excludeId?: number,
  ): Promise<void> {
    const levels = await this.allLevels();
    for (const level of levels) {
      if (excludeId !== undefined && level.id === excludeId) continue;
      if (level.sort < sort && level.upgradeAmount > upgradeAmount)
        throw new BadRequestException(
          `等级门槛必须随排序单调不减：「${level.name}」排序更小但门槛更高`,
        );
      if (level.sort > sort && level.upgradeAmount < upgradeAmount)
        throw new BadRequestException(
          `等级门槛必须随排序单调不减：「${level.name}」排序更大但门槛更低`,
        );
    }
  }
}

function assertDiscountPermille(permille: number): void {
  if (!Number.isInteger(permille) || permille < 0 || permille > 1000)
    throw new BadRequestException('折扣率必须是 0~1000 的整数千分比');
}

function assertUpgradeAmount(upgradeAmount: number): void {
  if (!Number.isInteger(upgradeAmount) || upgradeAmount < 0)
    throw new BadRequestException('升级门槛必须是非负整数（分）');
}
