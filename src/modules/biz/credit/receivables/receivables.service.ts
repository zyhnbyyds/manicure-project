import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  sql,
} from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../../../database/database.service.js';
import {
  bizCreditAccounts,
  bizReceivablePayments,
  bizReceivables,
} from '../../../../database/schema/index.js';
import { BizConfigService } from '../../common/biz-config.service.js';
import { buildDocNo } from '../../common/doc-no.js';
import { andConditions } from '../../common/query.js';
import {
  daysBetween,
  shopDateOf,
  shopToday,
} from '../../common/shop-time.js';
import {
  CreditPort,
  CustomerPort,
  MemberAccountPort,
  PaymentPort,
  SettlementPort,
  type CreditAccountRow,
  type PageResult,
  type ReceivableRow,
} from '../../common/ports.js';
import type { BizTx } from '../../common/tx.js';

export type ReceivableStatus =
  | 'open'
  | 'partial'
  | 'settled'
  | 'overdue'
  | 'cancelled';

/** 未结状态（应收余额口径，§18.4） */
export type OutstandingReceivableStatus = Extract<
  ReceivableStatus,
  'open' | 'partial' | 'overdue'
>;

export const OUTSTANDING_RECEIVABLE_STATUSES: OutstandingReceivableStatus[] = [
  'open',
  'partial',
  'overdue',
];

/** 销账渠道：与 `biz_receivable_payment.pay_channel` 的枚举一致 */
export const SETTLE_CHANNELS = [
  'cash',
  'wechat_offline',
  'alipay_offline',
  'balance',
  'wxpay_native',
  'alipay_qr',
] as const;

export type SettleChannel = (typeof SETTLE_CHANNELS)[number];

export type SettlePaymentInput = {
  channel: SettleChannel;
  /** 分，正整数 */
  amount: number;
  remark?: string | null | undefined;
};

export type SettleInput = {
  payments: SettlePaymentInput[];
  remark?: string | undefined;
  actorId: number;
};

/** 销账落地的支付单摘要（在线渠道带 `codeUrl`） */
export type SettlePaymentResult = {
  paymentId: number;
  paymentNo: string;
  channel: SettleChannel;
  amount: number;
  status: 'pending' | 'success';
  codeUrl: string | null;
  expireAt: Date | null;
};

export type SettleResult = {
  settledAmount: number;
  status: string;
  payments: SettlePaymentResult[];
};

export type ReceivableListFilter = {
  creditAccountId?: number | undefined;
  status?: ReceivableStatus | undefined;
  dueDateFrom?: string | undefined;
  dueDateTo?: string | undefined;
  /** true → `due_date < today AND status in (open,partial,overdue)` */
  overdue?: boolean | undefined;
};

export type ReceivableListItem = ReceivableRow & {
  accountName: string | null;
  remainingAmount: number;
};

export type ReceivableDetail = ReceivableListItem & {
  payments: (typeof bizReceivablePayments.$inferSelect)[];
};

/** 账龄汇总行（§18.3 / §9.9） */
export type ReceivableSummaryRow = {
  creditAccountId: number;
  name: string;
  type: 'customer' | 'company' | 'staff';
  creditLimit: number;
  usedAmount: number;
  totalAmount: number;
  settledAmount: number;
  balance: number;
  age0to30: number;
  age31to60: number;
  age60plus: number;
  overdueAmount: number;
  openCount: number;
};

type Bucket = {
  totalAmount: number;
  settledAmount: number;
  balance: number;
  age0to30: number;
  age31to60: number;
  age60plus: number;
  overdueAmount: number;
  openCount: number;
};

type NormalizedSettlePayment = {
  channel: SettleChannel;
  amount: number;
  remark: string | null;
};

/**
 * 应收台账：挂账下单、销账、作废、逾期标记与账龄汇总（§18）。
 *
 * 两条红线：
 * 1. **挂账不写支付单**（挂账不是收付动作），下单时也不计营收与积分；
 * 2. **销账是唯一闸门**：`settled_amount + x <= amount` 的条件更新决定成败，
 *    `affectedRows = 0` 一律抛 409，绝不「读出来判断剩余」（§6.6 第 6 条）。
 */
@Injectable()
export class ReceivablesService extends CreditPort {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: BizConfigService,
    private readonly payments: PaymentPort,
    private readonly settlements: SettlementPort,
    private readonly members: MemberAccountPort,
    private readonly customers: CustomerPort,
  ) {
    super();
  }

  /**
   * 下单挂账：校验主体与额度 → 建应收单 → 占用额度（同一 `tx`，不写支付单）。
   *
   * 预约 `pay_status='credit'` / `credit_account_id` 由预约模块在同一事务内回写。
   */
  override async createFromBooking(
    tx: BizTx,
    input: {
      creditAccountId: number;
      bookingId: number;
      customerId: number;
      amount: number;
      actorId?: number | null;
    },
  ): Promise<{
    receivableId: number;
    receivableNo: string;
    dueDate: string | null;
  }> {
    const amount = normalizeAmount(input.amount);
    const account = await this.assertCreditAvailable(
      tx,
      input.creditAccountId,
      amount,
    );
    // 顾客挂账校验：主体绑定了顾客时，只能给该顾客挂账；且顾客必须存在
    if (account.customerId !== null && account.customerId !== input.customerId) {
      throw new ConflictException('该挂账主体不属于此顾客');
    }
    await this.customers.requireById(input.customerId, tx);

    const timeZone = await this.timeZone();
    const dueDate = resolveDueDate(account.settleDay, shopToday(timeZone));
    const [inserted] = await tx.insert(bizReceivables).values({
      // 主键回填模式：先占位，拿到 insertId 后回填 `A{yyyyMMdd}{id}`（§4.3）
      receivableNo: temporaryDocNo(),
      creditAccountId: account.id,
      bookingId: input.bookingId,
      customerId: input.customerId,
      amount,
      settledAmount: 0,
      dueDate,
      status: 'open',
      createdBy: input.actorId ?? null,
      updatedBy: input.actorId ?? null,
    });
    const receivableId = Number(inserted.insertId);
    const receivableNo = buildDocNo('A', receivableId, timeZone);
    await tx
      .update(bizReceivables)
      .set({ receivableNo })
      .where(eq(bizReceivables.id, receivableId));

    // 占用额度：条件更新是并发闸门（超额时 affectedRows = 0）
    const claimed = await tx
      .update(bizCreditAccounts)
      .set({
        usedAmount: sql`${bizCreditAccounts.usedAmount} + ${amount}`,
      })
      .where(
        and(
          eq(bizCreditAccounts.id, account.id),
          eq(bizCreditAccounts.status, 'active'),
          isNull(bizCreditAccounts.deletedAt),
          sql`(${bizCreditAccounts.creditLimit} = 0 OR ${bizCreditAccounts.usedAmount} + ${amount} <= ${bizCreditAccounts.creditLimit})`,
        ),
      );
    if (!claimed[0].affectedRows) {
      throw new ConflictException('挂账额度不足或已被其它单据占用，请刷新后重试');
    }
    return { receivableId, receivableNo, dueDate };
  }

  /** 额度校验（不锁行：真正的闸门是 `createFromBooking` 里的条件更新） */
  override async assertCreditAvailable(
    tx: BizTx,
    creditAccountId: number,
    amount: number,
  ): Promise<CreditAccountRow> {
    const requested = normalizeAmount(amount);
    const [row] = await tx
      .select()
      .from(bizCreditAccounts)
      .where(
        and(
          eq(bizCreditAccounts.id, creditAccountId),
          isNull(bizCreditAccounts.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('挂账主体不存在');
    if (row.status !== 'active') {
      throw new ConflictException('挂账主体已停用，不能挂账');
    }
    if (row.creditLimit !== 0 && row.usedAmount + requested > row.creditLimit) {
      const remaining = Math.max(row.creditLimit - row.usedAmount, 0);
      throw new ConflictException(`超出挂账额度，剩余 ¥${formatYuan(remaining)}`);
    }
    return row;
  }

  /**
   * 销账（§18.3）：逐笔落支付单 + 销账记录 → 条件更新（不得超额）→
   * 回减主体占用额度 → **结清时**才回写预约资金状态并累计消费与积分。
   */
  async settle(
    receivableId: number,
    input: SettleInput,
  ): Promise<SettleResult> {
    const payments = normalizeSettlePayments(input.payments);
    const total = payments.reduce((sum, item) => sum + item.amount, 0);
    return this.database.db.transaction(async (tx) => {
      const [receivable] = await tx
        .select()
        .from(bizReceivables)
        .where(
          and(
            eq(bizReceivables.id, receivableId),
            isNull(bizReceivables.deletedAt),
          ),
        )
        .limit(1);
      if (!receivable) throw new NotFoundException('应收单不存在');
      if (!isOutstanding(receivable.status)) {
        throw new ConflictException(
          `应收单当前状态（${receivable.status}）不可销账`,
        );
      }
      const remaining = Math.max(
        receivable.amount - receivable.settledAmount,
        0,
      );
      if (total > remaining) {
        throw new ConflictException(
          `销账金额超出未结金额，剩余 ¥${formatYuan(remaining)}`,
        );
      }
      const customerId = await this.resolveCustomerId(tx, receivable);
      if (customerId === null) {
        throw new BadRequestException('应收单未关联顾客，无法生成销账支付单');
      }

      const settled: SettlePaymentResult[] = [];
      for (const payment of payments) {
        // 金额事实来自支付单：线下/储值渠道直接 success，在线渠道落 pending + code_url
        const outcome = await this.payments.createInTx(
          tx,
          {
            customerId,
            bookingId: receivable.bookingId,
            purpose: 'credit_settle',
            channel: payment.channel,
            amount: payment.amount,
            receivedAmount: payment.amount,
            remark:
              payment.remark ??
              input.remark ??
              `应收单 ${receivable.receivableNo} 销账`,
          },
          input.actorId,
        );
        await tx.insert(bizReceivablePayments).values({
          receivableId,
          amount: payment.amount,
          payChannel: payment.channel,
          paymentId: outcome.paymentId,
          paidAt: new Date(),
          remark: payment.remark ?? input.remark ?? null,
          createdBy: input.actorId,
        });
        settled.push({
          paymentId: outcome.paymentId,
          paymentNo: outcome.paymentNo,
          channel: payment.channel,
          amount: payment.amount,
          status: outcome.status,
          codeUrl: outcome.codeUrl,
          expireAt: outcome.expireAt,
        });
      }

      /*
       * 销账闸门（§6.6 第 6 条）：`settled_amount + x <= amount` 不满足时不改任何行。
       *
       * `status` / `settled_at` 必须读**加完之后**的 `settled_amount`：
       * MySQL 的 SET 从左到右求值、且后面的赋值能看到前面已更新的列值，
       * 而 drizzle 按表定义顺序生成 SET（`settled_amount` 在 `status` 之前），
       * 所以这里写 `settled_amount >= amount`（而非 `settled_amount + x >= amount`，
       * 后者会重复累加 x 导致提前置 settled）。已按真实 MySQL 验证。
       */
      const updated = await tx
        .update(bizReceivables)
        .set({
          settledAmount: sql`${bizReceivables.settledAmount} + ${total}`,
          status: sql`IF(${bizReceivables.settledAmount} >= ${bizReceivables.amount}, 'settled', 'partial')`,
          settledAt: sql`IF(${bizReceivables.settledAmount} >= ${bizReceivables.amount}, NOW(), ${bizReceivables.settledAt})`,
          updatedBy: input.actorId,
        })
        .where(
          and(
            eq(bizReceivables.id, receivableId),
            inArray(bizReceivables.status, OUTSTANDING_RECEIVABLE_STATUSES),
            isNull(bizReceivables.deletedAt),
            sql`${bizReceivables.settledAmount} + ${total} <= ${bizReceivables.amount}`,
          ),
        );
      if (!updated[0].affectedRows) {
        // 并发双销账：另一笔已把余额销完或状态已变
        throw new ConflictException('应收单已被其它销账操作更新，请刷新后重试');
      }

      // 回减主体占用额度（GREATEST 兜底，无符号列绝不出现负数）
      await tx
        .update(bizCreditAccounts)
        .set({
          usedAmount: sql`GREATEST(CAST(${bizCreditAccounts.usedAmount} AS SIGNED) - ${total}, 0)`,
        })
        .where(eq(bizCreditAccounts.id, receivable.creditAccountId));

      const [after] = await tx
        .select({
          settledAmount: bizReceivables.settledAmount,
          status: bizReceivables.status,
        })
        .from(bizReceivables)
        .where(eq(bizReceivables.id, receivableId))
        .limit(1);
      const settledAmount = after?.settledAmount ?? receivable.settledAmount + total;
      const status = after?.status ?? 'partial';

      if (status === 'settled') {
        // 预约资金状态由唯一重算入口回写（§15.7 不变量 4）
        if (receivable.bookingId !== null) {
          await this.settlements.recalc(tx, receivable.bookingId);
        }
        // 销账才计消费与积分（§18.4）
        await this.members.recordConsumption(tx, {
          customerId,
          paidAmount: total,
          bookingId: receivable.bookingId,
          payChannel:
            payments.length === 1 ? (payments[0]?.channel ?? null) : null,
          remark: `挂账销账 ${receivable.receivableNo}`,
          actorId: input.actorId,
        });
      }
      return { settledAmount, status, payments: settled };
    });
  }

  /** 作废：仅未销账（`settled_amount = 0` 且未结）可作废，必填原因（§18.3） */
  async cancel(
    receivableId: number,
    reason: string,
    actorId: number,
  ): Promise<void> {
    const text = typeof reason === 'string' ? reason.trim() : '';
    if (!text) throw new BadRequestException('作废原因必填');
    await this.database.db.transaction(async (tx) => {
      const [receivable] = await tx
        .select()
        .from(bizReceivables)
        .where(
          and(
            eq(bizReceivables.id, receivableId),
            isNull(bizReceivables.deletedAt),
          ),
        )
        .limit(1);
      if (!receivable) throw new NotFoundException('应收单不存在');
      if (
        receivable.settledAmount !== 0 ||
        (receivable.status !== 'open' && receivable.status !== 'overdue')
      ) {
        throw new ConflictException('仅未销账的应收单可以作废');
      }
      const result = await tx
        .update(bizReceivables)
        .set({
          status: 'cancelled',
          remark: buildCancelRemark(receivable.remark, text),
          updatedBy: actorId,
        })
        .where(
          and(
            eq(bizReceivables.id, receivableId),
            eq(bizReceivables.settledAmount, 0),
            inArray(bizReceivables.status, ['open', 'overdue']),
            isNull(bizReceivables.deletedAt),
          ),
        );
      if (!result[0].affectedRows) {
        throw new ConflictException('应收单状态已变更，请刷新后重试');
      }
      await tx
        .update(bizCreditAccounts)
        .set({
          usedAmount: sql`GREATEST(CAST(${bizCreditAccounts.usedAmount} AS SIGNED) - ${receivable.amount}, 0)`,
        })
        .where(eq(bizCreditAccounts.id, receivable.creditAccountId));
    });
  }

  /** 定时任务用（每日 01:10）：置逾期，幂等且不碰钱（§11 / §15.7 不变量 5） */
  override async markOverdue(): Promise<{ overdue: number }> {
    const today = shopToday(await this.timeZone());
    const result = await this.database.db
      .update(bizReceivables)
      .set({ status: 'overdue' })
      .where(
        and(
          inArray(bizReceivables.status, ['open', 'partial']),
          isNotNull(bizReceivables.dueDate),
          lt(bizReceivables.dueDate, today),
          isNull(bizReceivables.deletedAt),
        ),
      );
    return { overdue: result[0].affectedRows };
  }

  async list(
    page: number,
    pageSize: number,
    filter: ReceivableListFilter,
  ): Promise<PageResult<ReceivableListItem>> {
    const today = shopToday(await this.timeZone());
    const where = andConditions([
      isNull(bizReceivables.deletedAt),
      filter.creditAccountId !== undefined
        ? eq(bizReceivables.creditAccountId, filter.creditAccountId)
        : undefined,
      filter.status ? eq(bizReceivables.status, filter.status) : undefined,
      filter.dueDateFrom
        ? gte(bizReceivables.dueDate, filter.dueDateFrom)
        : undefined,
      filter.dueDateTo
        ? lte(bizReceivables.dueDate, filter.dueDateTo)
        : undefined,
      filter.overdue
        ? and(
            lt(bizReceivables.dueDate, today),
            inArray(bizReceivables.status, OUTSTANDING_RECEIVABLE_STATUSES),
          )
        : undefined,
    ]);
    const rows = await this.database.db
      .select()
      .from(bizReceivables)
      .where(where)
      .orderBy(desc(bizReceivables.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const names = await this.accountNames(
      rows.map((row) => row.creditAccountId),
    );
    return {
      items: rows.map((row) => ({
        ...row,
        accountName: names.get(row.creditAccountId) ?? null,
        remainingAmount: Math.max(row.amount - row.settledAmount, 0),
      })),
      page,
      pageSize,
    };
  }

  async findOne(id: number): Promise<ReceivableDetail> {
    const [row] = await this.database.db
      .select()
      .from(bizReceivables)
      .where(and(eq(bizReceivables.id, id), isNull(bizReceivables.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundException('应收单不存在');
    const [payments, names] = await Promise.all([
      this.database.db
        .select()
        .from(bizReceivablePayments)
        .where(eq(bizReceivablePayments.receivableId, id))
        .orderBy(asc(bizReceivablePayments.id)),
      this.accountNames([row.creditAccountId]),
    ]);
    return {
      ...row,
      accountName: names.get(row.creditAccountId) ?? null,
      remainingAmount: Math.max(row.amount - row.settledAmount, 0),
      payments,
    };
  }

  /**
   * 按主体汇总挂账余额与账龄（§18.3）。
   *
   * 账龄 = `today − (due_date ?? created_at 的店内日)`，按 0-30 / 31-60 / 60+ 分档；
   * 未到期（差值为负）归入 0-30 档。数据量小，直接内存聚合（口径与明细一致）。
   */
  async summary(): Promise<ReceivableSummaryRow[]> {
    const timeZone = await this.timeZone();
    const today = shopToday(timeZone);
    const [accounts, rows] = await Promise.all([
      this.database.db
        .select({
          id: bizCreditAccounts.id,
          name: bizCreditAccounts.name,
          type: bizCreditAccounts.type,
          creditLimit: bizCreditAccounts.creditLimit,
          usedAmount: bizCreditAccounts.usedAmount,
        })
        .from(bizCreditAccounts)
        .where(isNull(bizCreditAccounts.deletedAt))
        .orderBy(asc(bizCreditAccounts.id)),
      this.database.db
        .select({
          creditAccountId: bizReceivables.creditAccountId,
          amount: bizReceivables.amount,
          settledAmount: bizReceivables.settledAmount,
          dueDate: bizReceivables.dueDate,
          createdAt: bizReceivables.createdAt,
        })
        .from(bizReceivables)
        .where(
          and(
            inArray(bizReceivables.status, OUTSTANDING_RECEIVABLE_STATUSES),
            isNull(bizReceivables.deletedAt),
          ),
        ),
    ]);

    const buckets = new Map<number, Bucket>();
    for (const row of rows) {
      const bucket = ensureBucket(buckets, row.creditAccountId);
      const outstanding = Math.max(row.amount - row.settledAmount, 0);
      const baseDate = row.dueDate ?? shopDateOf(row.createdAt, timeZone);
      const age = Math.max(daysBetween(baseDate, today), 0);
      bucket.totalAmount += row.amount;
      bucket.settledAmount += row.settledAmount;
      bucket.balance += outstanding;
      bucket.openCount += 1;
      if (age <= 30) bucket.age0to30 += outstanding;
      else if (age <= 60) bucket.age31to60 += outstanding;
      else bucket.age60plus += outstanding;
      // 逾期金额：已过到期日且未结（与列表 `overdue=true` 同一口径）
      if (row.dueDate !== null && row.dueDate < today) {
        bucket.overdueAmount += outstanding;
      }
    }

    return accounts.map((account) => {
      const bucket = buckets.get(account.id) ?? emptyBucket();
      return {
        creditAccountId: account.id,
        name: account.name,
        type: account.type,
        creditLimit: account.creditLimit,
        usedAmount: account.usedAmount,
        ...bucket,
      };
    });
  }

  /** 销账支付单挂在谁是顾客：应收单优先，其次取主体绑定的顾客 */
  private async resolveCustomerId(
    tx: BizTx,
    receivable: ReceivableRow,
  ): Promise<number | null> {
    if (receivable.customerId !== null) return receivable.customerId;
    const [account] = await tx
      .select({ customerId: bizCreditAccounts.customerId })
      .from(bizCreditAccounts)
      .where(eq(bizCreditAccounts.id, receivable.creditAccountId))
      .limit(1);
    return account?.customerId ?? null;
  }

  private async accountNames(
    accountIds: number[],
  ): Promise<Map<number, string>> {
    const result = new Map<number, string>();
    const ids = [...new Set(accountIds)];
    if (!ids.length) return result;
    const rows = await this.database.db
      .select({ id: bizCreditAccounts.id, name: bizCreditAccounts.name })
      .from(bizCreditAccounts)
      .where(inArray(bizCreditAccounts.id, ids));
    for (const row of rows) result.set(row.id, row.name);
    return result;
  }

  private async timeZone(): Promise<string> {
    return (await this.config.booking()).timezone;
  }
}

/** 账期：`settle_day` 1..28 → 挂账日之后第一个结算日；0 → 不定期（NULL） */
export function resolveDueDate(
  settleDay: number,
  today: string,
): string | null {
  if (!Number.isFinite(settleDay) || settleDay <= 0) return null;
  const day = Math.min(Math.max(Math.trunc(settleDay), 1), 28);
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const dayOfMonth = Number(today.slice(8, 10));
  // 「之后第一个」：当月结算日还没到才取当月，否则顺延次月
  const sameMonth = day > dayOfMonth;
  const targetYear = sameMonth || month < 12 ? year : year + 1;
  const targetMonth = sameMonth ? month : (month % 12) + 1;
  return `${targetYear}-${pad2(targetMonth)}-${pad2(day)}`;
}

function isOutstanding(status: string): boolean {
  return (OUTSTANDING_RECEIVABLE_STATUSES as string[]).includes(status);
}

function normalizeAmount(value: number): number {
  if (!Number.isFinite(value) || Math.trunc(value) <= 0) {
    throw new BadRequestException('金额必须为正整数（分）');
  }
  return Math.trunc(value);
}

function normalizeSettlePayments(
  payments: SettlePaymentInput[],
): NormalizedSettlePayment[] {
  if (!Array.isArray(payments) || !payments.length) {
    throw new BadRequestException('销账明细不能为空');
  }
  return payments.map((payment) => ({
    channel: payment.channel,
    amount: normalizeAmount(payment.amount),
    remark: payment.remark ?? null,
  }));
}

/** 主键回填前的占位单号（`receivable_no` 有唯一索引，不能留空） */
function temporaryDocNo(): string {
  return `T${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

function buildCancelRemark(
  current: string | null,
  reason: string,
): string {
  const text = current ? `${current} | 作废：${reason}` : `作废：${reason}`;
  return text.slice(0, 200);
}

function ensureBucket(buckets: Map<number, Bucket>, key: number): Bucket {
  const existing = buckets.get(key);
  if (existing) return existing;
  const created = emptyBucket();
  buckets.set(key, created);
  return created;
}

function emptyBucket(): Bucket {
  return {
    totalAmount: 0,
    settledAmount: 0,
    balance: 0,
    age0to30: 0,
    age31to60: 0,
    age60plus: 0,
    overdueAmount: 0,
    openCount: 0,
  };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatYuan(cents: number): string {
  return (cents / 100).toFixed(2);
}
