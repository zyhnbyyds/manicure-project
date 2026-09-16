import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { DatabaseService } from '../../../../database/database.service';
import {
  bizCreditAccounts,
  bizReceivables,
} from '../../../../database/schema/index';
import { BizConfigService } from '../../common/biz-config.service';
import { andConditions, keywordLike, readCount } from '../../common/query';
import type { PageResult } from '../../common/ports';
import { CustomerPort, type CreditAccountRow } from '../../common/ports';
import { withoutUndefined } from '../../common/tx';
import { OUTSTANDING_RECEIVABLE_STATUSES } from '../receivables/receivables.service';

export type CreditAccountType = 'customer' | 'company' | 'staff';

export type CreateCreditAccountInput = {
  name: string;
  type: CreditAccountType;
  customerId?: number | null | undefined;
  contact?: string | null | undefined;
  phone?: string | null | undefined;
  /** 分；0 = 不限（缺省取配置 `biz.credit.defaultLimit`） */
  creditLimit?: number | undefined;
  /** 月结日 1..28；0 = 不定期（缺省取配置 `biz.credit.defaultSettleDay`） */
  settleDay?: number | undefined;
  status?: 'active' | 'disabled' | undefined;
  remark?: string | null | undefined;
};

export type UpdateCreditAccountInput = {
  name?: string | undefined;
  type?: CreditAccountType | undefined;
  customerId?: number | null | undefined;
  contact?: string | null | undefined;
  phone?: string | null | undefined;
  creditLimit?: number | undefined;
  settleDay?: number | undefined;
  status?: 'active' | 'disabled' | undefined;
  remark?: string | null | undefined;
};

export type CreditAccountListFilter = {
  keyword?: string | undefined;
  type?: CreditAccountType | undefined;
  status?: 'active' | 'disabled' | undefined;
};

/** 列表项：主体行 + 「已挂未结金额」（§9.9） */
export type CreditAccountListItem = CreditAccountRow & {
  outstandingAmount: number;
};

/**
 * 挂账主体（§18.1）。
 *
 * 只负责主体档案（额度 / 账期 / 启停），额度占用与回减由
 * `ReceivablesService` 在应收单事务内用条件更新完成；本服务不碰 `used_amount`。
 */
@Injectable()
export class CreditAccountsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: BizConfigService,
    private readonly customers: CustomerPort,
  ) {}

  async list(
    page: number,
    pageSize: number,
    filter: CreditAccountListFilter,
  ): Promise<PageResult<CreditAccountListItem>> {
    const where = andConditions([
      isNull(bizCreditAccounts.deletedAt),
      filter.type ? eq(bizCreditAccounts.type, filter.type) : undefined,
      filter.status ? eq(bizCreditAccounts.status, filter.status) : undefined,
      this.keywordCondition(filter.keyword),
    ]);
    const [rows, counted] = await Promise.all([
      this.database.db
        .select()
        .from(bizCreditAccounts)
        .where(where)
        .orderBy(asc(bizCreditAccounts.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.database.db
        .select({ value: count() })
        .from(bizCreditAccounts)
        .where(where),
    ]);
    const outstanding = await this.outstandingByAccount(
      rows.map((row) => row.id),
    );
    return {
      items: rows.map((row) => ({
        ...row,
        outstandingAmount: outstanding.get(row.id) ?? 0,
      })),
      total: readCount(counted),
      page,
      pageSize,
    };
  }

  async findOne(id: number): Promise<CreditAccountRow> {
    const [row] = await this.database.db
      .select()
      .from(bizCreditAccounts)
      .where(
        and(eq(bizCreditAccounts.id, id), isNull(bizCreditAccounts.deletedAt)),
      )
      .limit(1);
    if (!row) throw new NotFoundException('挂账主体不存在');
    return row;
  }

  async create(
    input: CreateCreditAccountInput,
    actorId: number,
  ): Promise<{ id: number }> {
    await this.assertNameUnique(input.name);
    const credit = await this.config.credit();
    const customerId = input.customerId ?? null;
    if (customerId !== null) await this.customers.requireById(customerId);
    const result = await this.database.db.insert(bizCreditAccounts).values({
      ...withoutUndefined({ ...input, customerId }),
      creditLimit: normalizeCreditLimit(
        input.creditLimit ?? credit.defaultLimit,
      ),
      settleDay: normalizeSettleDay(input.settleDay ?? credit.defaultSettleDay),
      createdBy: actorId,
      updatedBy: actorId,
    });
    return { id: Number(result[0].insertId) };
  }

  async update(
    id: number,
    input: UpdateCreditAccountInput,
    actorId: number,
  ): Promise<void> {
    const row = await this.findOne(id);
    if (input.name !== undefined) await this.assertNameUnique(input.name, id);
    if (input.customerId !== undefined && input.customerId !== null) {
      await this.customers.requireById(input.customerId);
    }
    const patch = withoutUndefined(input);
    if (patch.creditLimit !== undefined) {
      const limit = normalizeCreditLimit(patch.creditLimit);
      if (limit !== 0 && limit < row.usedAmount) {
        throw new ConflictException(
          `挂账额度不能小于已挂账金额 ¥${formatYuan(row.usedAmount)}`,
        );
      }
      patch.creditLimit = limit;
    }
    if (patch.settleDay !== undefined) {
      patch.settleDay = normalizeSettleDay(patch.settleDay);
    }
    if (!Object.keys(patch).length) return;
    await this.database.db
      .update(bizCreditAccounts)
      .set({ ...patch, updatedBy: actorId })
      .where(
        and(eq(bizCreditAccounts.id, id), isNull(bizCreditAccounts.deletedAt)),
      );
  }

  /** 软删；有未结应收时拒绝（§9.9） */
  async remove(id: number, actorId: number): Promise<void> {
    await this.findOne(id);
    await this.database.db.transaction(async (tx) => {
      const [unsettled] = await tx
        .select({ id: bizReceivables.id })
        .from(bizReceivables)
        .where(
          and(
            eq(bizReceivables.creditAccountId, id),
            inArray(bizReceivables.status, OUTSTANDING_RECEIVABLE_STATUSES),
            isNull(bizReceivables.deletedAt),
          ),
        )
        .limit(1);
      if (unsettled)
        throw new ConflictException('该主体存在未结应收，不能删除');
      await tx
        .update(bizCreditAccounts)
        .set({ deletedAt: new Date(), updatedBy: actorId })
        .where(
          and(
            eq(bizCreditAccounts.id, id),
            isNull(bizCreditAccounts.deletedAt),
          ),
        );
    });
  }

  /** 主体名称全局唯一（`uq_credit_account_name` 不过滤软删，这里按库约束的口径校验） */
  private async assertNameUnique(
    name: string,
    excludeId?: number,
  ): Promise<void> {
    const conditions = [eq(bizCreditAccounts.name, name)];
    if (excludeId !== undefined) {
      conditions.push(ne(bizCreditAccounts.id, excludeId));
    }
    const [duplicate] = await this.database.db
      .select({ id: bizCreditAccounts.id })
      .from(bizCreditAccounts)
      .where(and(...conditions))
      .limit(1);
    if (duplicate) throw new ConflictException('挂账主体名称已存在');
  }

  private keywordCondition(keyword?: string): SQL | undefined {
    const name = keywordLike(bizCreditAccounts.name, keyword);
    if (!name) return undefined;
    return or(name, keywordLike(bizCreditAccounts.phone, keyword));
  }

  /** 已挂未结金额 = Σ(amount − settled_amount)，只统计未结状态（§18.4） */
  private async outstandingByAccount(
    accountIds: number[],
  ): Promise<Map<number, number>> {
    const result = new Map<number, number>();
    if (!accountIds.length) return result;
    const rows = await this.database.db
      .select({
        creditAccountId: bizReceivables.creditAccountId,
        outstanding: sql<string>`COALESCE(SUM(CAST(${bizReceivables.amount} AS SIGNED) - CAST(${bizReceivables.settledAmount} AS SIGNED)), 0)`,
      })
      .from(bizReceivables)
      .where(
        and(
          inArray(bizReceivables.creditAccountId, accountIds),
          inArray(bizReceivables.status, OUTSTANDING_RECEIVABLE_STATUSES),
          isNull(bizReceivables.deletedAt),
        ),
      )
      .groupBy(bizReceivables.creditAccountId);
    for (const row of rows) {
      result.set(row.creditAccountId, Number(row.outstanding));
    }
    return result;
  }
}

/** 额度：0 = 不限；非法值回落 0（与配置回落口径一致） */
export function normalizeCreditLimit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(Math.trunc(value), 0);
}

/** 月结日：0 = 不定期，1..28 为月结日（§18.1） */
export function normalizeSettleDay(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), 28);
}

function formatYuan(cents: number): string {
  return (cents / 100).toFixed(2);
}
