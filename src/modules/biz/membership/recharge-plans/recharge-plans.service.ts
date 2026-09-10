import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import { DatabaseService } from '../../../../database/database.service';
import { bizRechargePlans } from '../../../../database/schema/index.js';
import { BizConfigService } from '../../common/biz-config.service.js';
import { withoutUndefined } from '../../common/tx.js';
import type { BizDatabase } from '../../common/tx.js';

export type RechargePlanRow = typeof bizRechargePlans.$inferSelect;

export type RechargePlanInput = {
  name: string;
  payAmount: number;
  bonusAmount?: number | undefined;
  status?: 'active' | 'disabled' | undefined;
  sort?: number | undefined;
  remark?: string | null | undefined;
};

export type RechargePlanListFilter = {
  status?: 'active' | 'disabled' | undefined;
};

/**
 * 充值方案（§15.4）。
 *
 * 赠送比例上限 `biz.member.maxBonusPermille`（默认 200‰ = 20%）在**保存方案**与**实际充值**两处
 * 都校验（§15.4 / §15.8）：方案是模板，充值才是真正加余额的动作。
 */
@Injectable()
export class RechargePlansService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: BizConfigService,
  ) {}

  async list(
    page: number,
    pageSize: number,
    filter: RechargePlanListFilter = {},
  ): Promise<{ items: RechargePlanRow[]; page: number; pageSize: number }> {
    const conditions = [isNull(bizRechargePlans.deletedAt)];
    if (filter.status)
      conditions.push(eq(bizRechargePlans.status, filter.status));
    const items = await this.database.db
      .select()
      .from(bizRechargePlans)
      .where(and(...conditions))
      .orderBy(asc(bizRechargePlans.sort), asc(bizRechargePlans.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return { items, page, pageSize };
  }

  async findOne(id: number): Promise<RechargePlanRow> {
    const [plan] = await this.database.db
      .select()
      .from(bizRechargePlans)
      .where(and(eq(bizRechargePlans.id, id), isNull(bizRechargePlans.deletedAt)))
      .limit(1);
    if (!plan) throw new NotFoundException('充值方案不存在');
    return plan;
  }

  /** 启用中的方案（充值下拉用） */
  async listActive(
    executor: BizDatabase = this.database.db,
  ): Promise<RechargePlanRow[]> {
    return executor
      .select()
      .from(bizRechargePlans)
      .where(
        and(
          isNull(bizRechargePlans.deletedAt),
          eq(bizRechargePlans.status, 'active'),
        ),
      )
      .orderBy(asc(bizRechargePlans.sort), asc(bizRechargePlans.id));
  }

  async create(
    input: RechargePlanInput,
    actorId: number,
  ): Promise<{ id: number }> {
    await this.assertNameUnique(input.name);
    const payAmount = Math.trunc(input.payAmount);
    const bonusAmount = Math.trunc(input.bonusAmount ?? 0);
    await this.assertBonusWithinLimit(payAmount, bonusAmount);

    const result = await this.database.db.insert(bizRechargePlans).values({
      ...withoutUndefined({
        name: input.name,
        payAmount,
        bonusAmount,
        status: input.status,
        sort: input.sort === undefined ? undefined : Math.trunc(input.sort),
        remark: input.remark,
      }),
      createdBy: actorId,
      updatedBy: actorId,
    });
    return { id: Number(result[0].insertId) };
  }

  async update(
    id: number,
    input: Partial<RechargePlanInput>,
    actorId: number,
  ): Promise<void> {
    const current = await this.findOne(id);
    if (input.name !== undefined) await this.assertNameUnique(input.name, id);

    const payAmount = Math.trunc(input.payAmount ?? current.payAmount);
    const bonusAmount = Math.trunc(input.bonusAmount ?? current.bonusAmount);
    if (input.payAmount !== undefined || input.bonusAmount !== undefined)
      await this.assertBonusWithinLimit(payAmount, bonusAmount);

    const result = await this.database.db
      .update(bizRechargePlans)
      .set({
        ...withoutUndefined({
          name: input.name,
          payAmount,
          bonusAmount,
          status: input.status,
          sort: input.sort === undefined ? undefined : Math.trunc(input.sort),
          remark: input.remark,
        }),
        updatedBy: actorId,
      })
      .where(
        and(eq(bizRechargePlans.id, id), isNull(bizRechargePlans.deletedAt)),
      );
    if (!result[0].affectedRows) throw new NotFoundException('充值方案不存在');
  }

  async remove(id: number, actorId: number): Promise<void> {
    const result = await this.database.db
      .update(bizRechargePlans)
      .set({ deletedAt: new Date(), updatedBy: actorId })
      .where(and(eq(bizRechargePlans.id, id), isNull(bizRechargePlans.deletedAt)));
    if (!result[0].affectedRows) throw new NotFoundException('充值方案不存在');
  }

  /** 赠送比例上限校验：`bonus/pay*1000 > maxBonusPermille` → 400（用整数比较避免取整误差） */
  async assertBonusWithinLimit(
    payAmount: number,
    bonusAmount: number,
  ): Promise<void> {
    if (!Number.isInteger(payAmount) || payAmount <= 0)
      throw new BadRequestException('充值金额必须是大于 0 的整数（分）');
    if (!Number.isInteger(bonusAmount) || bonusAmount < 0)
      throw new BadRequestException('赠送金额必须是非负整数（分）');
    const { maxBonusPermille } = await this.config.member();
    if (bonusAmount * 1000 > payAmount * maxBonusPermille)
      throw new BadRequestException(
        `赠送金额超过上限（不超过充值金额的 ${(maxBonusPermille / 10).toFixed(1)}%）`,
      );
  }

  private async assertNameUnique(
    name: string,
    excludeId?: number,
  ): Promise<void> {
    const conditions = [eq(bizRechargePlans.name, name)];
    if (excludeId !== undefined)
      conditions.push(ne(bizRechargePlans.id, excludeId));
    const [duplicate] = await this.database.db
      .select({ id: bizRechargePlans.id })
      .from(bizRechargePlans)
      .where(and(...conditions))
      .limit(1);
    if (duplicate) throw new ConflictException('充值方案名称已存在');
  }
}
