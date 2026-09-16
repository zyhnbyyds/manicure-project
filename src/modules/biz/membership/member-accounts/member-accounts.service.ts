import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNull,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { RequestActor } from '../../../../common/data-scope/data-scope';
import { requireCurrentStoreId } from '../../../../common/data-scope/store-scope';
import { DatabaseService } from '../../../../database/database.service';
import {
  bizBookings,
  bizCustomers,
  bizMemberTransactions,
  bizRechargePlans,
  sysStores,
} from '../../../../database/schema/index';
import { BizConfigService } from '../../common/biz-config.service';
import {
  CENTS_PER_YUAN,
  pointsToCents,
  splitBalanceDeduction,
} from '../../common/money';
import {
  CustomerPort,
  MemberAccountPort,
  type PayChannel,
  type PricingContext,
} from '../../common/ports';
import {
  andConditions,
  localDateRange,
  parsePagination,
  readCount,
} from '../../common/query';
import { withoutUndefined } from '../../common/tx';
import type { BizDatabase, BizTx } from '../../common/tx';
import {
  MemberLevelsService,
  pickLowestLevel,
  pickUpgradeLevel,
} from '../member-levels/member-levels.service';

export type CustomerRow = typeof bizCustomers.$inferSelect;
export type MemberTransactionRow = typeof bizMemberTransactions.$inferSelect;
export type MemberTransactionListRow = MemberTransactionRow & {
  storeName: string | null;
};

/** 流水类型（`biz_member_transaction.type`） */
export type LedgerType = MemberTransactionRow['type'];
/** 流水收款方式（`biz_member_transaction.pay_channel`，比支付单的口径窄） */
export type LedgerPayChannel = NonNullable<MemberTransactionRow['payChannel']>;

/**
 * `amount` 的语义（`recount` 的累计消费口径依赖它，改这里必须同步改 `recount`）：
 *
 * | type                                                 | amount 含义                    | 对 total_spent |
 * | ---------------------------------------------------- | ------------------------------ | -------------- |
 * | `consume` / `card_buy`                               | 本次消费实收（分）             | +              |
 * | `refund`                                             | 冲减金额（正数存放）           | −              |
 * | `recharge` / `points_*` / `card_use` / `card_revert` / `level_change` / `adjust` | 金额或积分折算金额 | 不影响         |
 */
export type RechargeChannel =
  | 'cash'
  | 'wechat'
  | 'wechat_offline'
  | 'alipay'
  | 'alipay_offline';

export type RechargeInput = {
  /** 充值方案 id；与 `payAmount` 二选一 */
  planId?: number | undefined;
  /** 自定义充值金额（分）；方案充值时不看这个值，服务端按方案重算 */
  payAmount?: number | undefined;
  payChannel: RechargeChannel;
  remark?: string | null | undefined;
};

export type MemberRefundInput = {
  /** balance = 从储值余额退回（回减余额）；cash = 现金退回（只写流水，不动余额） */
  mode: 'balance' | 'cash';
  amount: number;
  reason?: string | null | undefined;
  /** 被冲正的原流水 id（写进反向流水的 `reversal_of`，原流水不动） */
  reversalOf?: number | null | undefined;
};

export type MemberAdjustInput = {
  /** 手工调级（唯一允许降级的入口之一，§15.2） */
  levelId?: number | null | undefined;
  pointsDelta?: number | undefined;
  balancePrincipalDelta?: number | undefined;
  balanceBonusDelta?: number | undefined;
  reason: string;
};

export type MemberListFilter = {
  keyword?: string | undefined;
  levelId?: number | undefined;
  hasBalance?: boolean | undefined;
};

export type TransactionListFilter = {
  type?: LedgerType | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
};

type LedgerInput = {
  customerId: number;
  type: LedgerType;
  amount?: number | undefined;
  balanceDeltaPrincipal?: number | undefined;
  balanceDeltaBonus?: number | undefined;
  pointsDelta?: number | undefined;
  balancePrincipalAfter: number;
  balanceBonusAfter: number;
  pointsAfter: number;
  payChannel?: LedgerPayChannel | null | undefined;
  bookingId?: number | null | undefined;
  cardId?: number | null | undefined;
  planId?: number | null | undefined;
  reversalOf?: number | null | undefined;
  remark?: string | null | undefined;
  actorId?: number | null | undefined;
  /**
   * 门店（阶段 1.12「资产通兑、流水归店」）。
   *
   * **传了就用**；没传但带了 `bookingId`，落库时从预约行顺带出门店；
   * 两样都没有 = 不归属任何店（NULL）。
   */
  storeId?: number | null | undefined;
};

type EarningInput = {
  customerId: number;
  amount: number;
  type: 'consume' | 'card_buy';
  bookingId?: number | null | undefined;
  cardId?: number | null | undefined;
  storeId?: number | null | undefined;
  payChannel?: PayChannel | null | undefined;
  remark?: string | null | undefined;
  actorId?: number | null | undefined;
};

/**
 * 会员账务（§15.2 / §15.3 / §15.4 / §15.7，端口实现见 `MemberAccountPort`）。
 *
 * 资金红线（改代码前先读 `money-invariants`）：
 * 1. 余额 / 积分扣减**一律条件更新** + 检查 `affectedRows`，应用层不做减法，绝不部分扣减；
 * 2. 流水**只追加**，纠错一律反向流水（`reversal_of`），原流水不动；
 * 3. 对账等式 `SUM(balance_delta_principal)=balance_principal`、
 *    `SUM(balance_delta_bonus)=balance_bonus`、`SUM(points_delta)=points` 必须随时成立：
 *    每次写流水都在**同一事务**里更新会员统计字段，并落 `*_after` 快照；
 * 4. 锁顺序 `biz_staff → biz_customer → biz_payment → biz_member_card`，事务内一律用 `tx`。
 */
@Injectable()
export class MemberAccountsService extends MemberAccountPort {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: BizConfigService,
    private readonly levels: MemberLevelsService,
    private readonly customers: CustomerPort,
  ) {
    super();
  }

  /* ------------------------------------------------------------------ *
   * 端口：算价上下文
   * ------------------------------------------------------------------ */

  override async getPricingContext(
    customerId: number,
  ): Promise<PricingContext> {
    const [row] = await this.database.db
      .select({
        id: bizCustomers.id,
        levelId: bizCustomers.levelId,
        points: bizCustomers.points,
        balancePrincipal: bizCustomers.balancePrincipal,
        balanceBonus: bizCustomers.balanceBonus,
      })
      .from(bizCustomers)
      .where(
        and(eq(bizCustomers.id, customerId), isNull(bizCustomers.deletedAt)),
      )
      .limit(1);
    if (!row) throw new NotFoundException('会员不存在');
    const memberConfig = await this.config.member();
    return {
      customerId: row.id,
      levelId: row.levelId,
      levelDiscountPermille: await this.levels.discountPermilleOf(row.levelId),
      points: row.points,
      balancePrincipal: row.balancePrincipal,
      balanceBonus: row.balanceBonus,
      maxPointsPermille: memberConfig.maxPointsPermille,
    };
  }

  /** 事务内锁会员行（锁顺序第二位）并返回最新账务快照 */
  override async lockAccount(
    tx: BizTx,
    customerId: number,
  ): Promise<PricingContext> {
    const row = await this.lockCustomerRow(tx, customerId);
    const memberConfig = await this.config.member();
    return {
      customerId: row.id,
      levelId: row.levelId,
      levelDiscountPermille: await this.levels.discountPermilleOf(
        row.levelId,
        tx,
      ),
      points: row.points,
      balancePrincipal: row.balancePrincipal,
      balanceBonus: row.balanceBonus,
      maxPointsPermille: memberConfig.maxPointsPermille,
    };
  }

  /** 事务内校验并锁会员行：次卡路径先锁 customer 再动 card（§6.6 锁顺序） */
  async lockCustomer(tx: BizTx, customerId: number): Promise<void> {
    await this.lockCustomerRow(tx, customerId);
  }

  /* ------------------------------------------------------------------ *
   * 端口：余额 / 积分
   * ------------------------------------------------------------------ */

  /**
   * 储值余额扣减：条件更新当闸门，不足直接 409，绝不部分扣减（§6.5 第 2 条）。
   *
   * `paymentId` 只做签名兼容（实施计划 §2.1 带这个参数）：`biz_member_transaction` 没有
   * `payment_id` 列（schema 已冻结），因此这里不落库，支付单关联走 `booking_id` 与流水 id。
   */
  override async applyBalancePayment(
    tx: BizTx,
    input: {
      customerId: number;
      amount: number;
      bookingId?: number | null;
      paymentId?: number | null;
      storeId?: number | null;
      remark?: string | null;
      actorId?: number | null;
    },
  ): Promise<{ transactionId: number; bonus: number; principal: number }> {
    const amount = Math.trunc(input.amount);
    if (amount <= 0) throw new BadRequestException('扣减金额必须大于 0');

    const mode = await this.resolveDeductMode();
    const before = await this.lockCustomerRow(tx, input.customerId);
    const { bonus, principal } =
      mode === 'principal_first'
        ? {
            bonus: Math.max(amount - before.balancePrincipal, 0),
            principal: Math.min(amount, before.balancePrincipal),
          }
        : splitBalanceDeduction(
            amount,
            before.balancePrincipal,
            before.balanceBonus,
            mode,
          );

    const result = await tx
      .update(bizCustomers)
      .set({
        balanceBonus: sql`${bizCustomers.balanceBonus} - ${bonus}`,
        balancePrincipal: sql`${bizCustomers.balancePrincipal} - ${principal}`,
        updatedBy: input.actorId ?? null,
      })
      .where(
        and(
          eq(bizCustomers.id, input.customerId),
          isNull(bizCustomers.deletedAt),
          gte(bizCustomers.balanceBonus, bonus),
          gte(bizCustomers.balancePrincipal, principal),
        ),
      );
    if (!result[0].affectedRows) throw new ConflictException('储值余额不足');

    const after = await this.readCustomerRow(tx, input.customerId);
    const transactionId = await this.writeLedger(tx, {
      customerId: input.customerId,
      type: 'adjust',
      amount,
      balanceDeltaPrincipal: -principal,
      balanceDeltaBonus: -bonus,
      balancePrincipalAfter: after.balancePrincipal,
      balanceBonusAfter: after.balanceBonus,
      pointsAfter: after.points,
      payChannel: 'balance',
      bookingId: input.bookingId ?? null,
      storeId: input.storeId ?? null,
      remark: input.remark ?? '储值余额支付',
      actorId: input.actorId ?? null,
    });
    return { transactionId, bonus, principal };
  }

  /** 积分抵扣 / 兑换扣分：条件更新，不足抛 Conflict（§6.6 第 7 条） */
  override async deductPoints(
    tx: BizTx,
    input: {
      customerId: number;
      points: number;
      bookingId?: number | null;
      type?: 'points_spend' | 'points_redeem';
      remark?: string | null;
      actorId?: number | null;
    },
  ): Promise<{ transactionId: number; amount: number }> {
    const points = Math.trunc(input.points);
    if (points <= 0) throw new BadRequestException('扣减积分必须大于 0');

    await this.lockCustomerRow(tx, input.customerId);
    const result = await tx
      .update(bizCustomers)
      .set({
        points: sql`${bizCustomers.points} - ${points}`,
        updatedBy: input.actorId ?? null,
      })
      .where(
        and(
          eq(bizCustomers.id, input.customerId),
          isNull(bizCustomers.deletedAt),
          gte(bizCustomers.points, points),
        ),
      );
    if (!result[0].affectedRows) throw new ConflictException('积分不足');

    const after = await this.readCustomerRow(tx, input.customerId);
    const { pointsDiscountPerYuan } = await this.config.member();
    const amount = pointsToCents(points, pointsDiscountPerYuan);
    const transactionId = await this.writeLedger(tx, {
      customerId: input.customerId,
      type: input.type ?? 'points_spend',
      amount,
      pointsDelta: -points,
      balancePrincipalAfter: after.balancePrincipal,
      balanceBonusAfter: after.balanceBonus,
      pointsAfter: after.points,
      bookingId: input.bookingId ?? null,
      remark: input.remark ?? '积分抵扣',
      actorId: input.actorId ?? null,
    });
    return { transactionId, amount };
  }

  /** 积分回补（撤销兑换）：只增不减 */
  async creditPoints(
    tx: BizTx,
    input: {
      customerId: number;
      points: number;
      storeId?: number | null;
      remark?: string | null;
      actorId?: number | null;
    },
  ): Promise<{ transactionId: number }> {
    const points = Math.trunc(input.points);
    if (points <= 0) throw new BadRequestException('回补积分必须大于 0');

    await this.lockCustomerRow(tx, input.customerId);
    await tx
      .update(bizCustomers)
      .set({
        points: sql`${bizCustomers.points} + ${points}`,
        updatedBy: input.actorId ?? null,
      })
      .where(
        and(
          eq(bizCustomers.id, input.customerId),
          isNull(bizCustomers.deletedAt),
        ),
      );
    const after = await this.readCustomerRow(tx, input.customerId);
    const { pointsDiscountPerYuan } = await this.config.member();
    const transactionId = await this.writeLedger(tx, {
      customerId: input.customerId,
      type: 'points_redeem',
      amount: pointsToCents(points, pointsDiscountPerYuan),
      pointsDelta: points,
      balancePrincipalAfter: after.balancePrincipal,
      balanceBonusAfter: after.balanceBonus,
      pointsAfter: after.points,
      storeId: input.storeId ?? null,
      remark: input.remark ?? '积分回补',
      actorId: input.actorId ?? null,
    });
    return { transactionId };
  }

  /* ------------------------------------------------------------------ *
   * 端口：消费 / 退款 / 回补余额
   * ------------------------------------------------------------------ */

  /** 消费落账：`total_spent` + 积分（1 元 1 分）+ 流水 + 自动升级 */
  override async recordConsumption(
    tx: BizTx,
    input: {
      customerId: number;
      paidAmount: number;
      bookingId?: number | null;
      payChannel?: PayChannel | null;
      remark?: string | null;
      actorId?: number | null;
    },
  ): Promise<{
    transactionId: number;
    pointsEarned: number;
    levelId: number | null;
  }> {
    return this.applyEarning(tx, {
      customerId: input.customerId,
      amount: Math.trunc(input.paidAmount),
      type: 'consume',
      bookingId: input.bookingId ?? null,
      payChannel: input.payChannel ?? null,
      remark: input.remark ?? '消费累计',
      actorId: input.actorId ?? null,
    });
  }

  /**
   * 累计消费（购卡 / 消费共用）：`total_spent += amount`、`points += floor(amount/100)*pointsPerYuan`、
   * 写 `consume` / `card_buy` 流水、同步等级。同类操作只此一处。
   */
  async applyEarning(
    tx: BizTx,
    input: EarningInput,
  ): Promise<{
    transactionId: number;
    pointsEarned: number;
    levelId: number | null;
  }> {
    const amount = Math.trunc(input.amount);
    if (amount < 0) throw new BadRequestException('消费金额不能为负');
    const { pointsPerYuan } = await this.config.member();
    const pointsEarned = Math.floor(amount / CENTS_PER_YUAN) * pointsPerYuan;

    await this.lockCustomerRow(tx, input.customerId);
    await tx
      .update(bizCustomers)
      .set({
        totalSpent: sql`${bizCustomers.totalSpent} + ${amount}`,
        points: sql`${bizCustomers.points} + ${pointsEarned}`,
        pointsTotal: sql`${bizCustomers.pointsTotal} + ${pointsEarned}`,
        updatedBy: input.actorId ?? null,
      })
      .where(
        and(
          eq(bizCustomers.id, input.customerId),
          isNull(bizCustomers.deletedAt),
        ),
      );
    const after = await this.readCustomerRow(tx, input.customerId);
    const transactionId = await this.writeLedger(tx, {
      customerId: input.customerId,
      type: input.type,
      amount,
      pointsDelta: pointsEarned,
      balancePrincipalAfter: after.balancePrincipal,
      balanceBonusAfter: after.balanceBonus,
      pointsAfter: after.points,
      payChannel: toLedgerChannel(input.payChannel),
      bookingId: input.bookingId ?? null,
      cardId: input.cardId ?? null,
      storeId: input.storeId ?? null,
      remark: input.remark ?? null,
      actorId: input.actorId ?? null,
    });
    const levelId = await this.syncLevel(
      tx,
      input.customerId,
      input.actorId ?? null,
    );
    return { transactionId, pointsEarned, levelId };
  }

  /** 按金额冲减消费与积分（退款 / 退卡）：积分不足先扣至 0 并写 `adjust` 差额（§15.3） */
  override async reverseConsumption(
    tx: BizTx,
    input: {
      customerId: number;
      amount: number;
      bookingId?: number | null;
      reversalOf?: number | null;
      remark?: string | null;
      actorId?: number | null;
    },
  ): Promise<{ transactionId: number; pointsReversed: number }> {
    const result = await this.reverseEarning(tx, {
      customerId: input.customerId,
      amount: Math.trunc(input.amount),
      bookingId: input.bookingId ?? null,
      reversalOf: input.reversalOf ?? null,
      remark: input.remark ?? '退款冲减',
      actorId: input.actorId ?? null,
    });
    return {
      transactionId: result.transactionId,
      pointsReversed: result.pointsReversed,
    };
  }

  /** 冲减累计消费与积分（退卡 / 退款共用）；`refund` 流水 `amount` 为正数，对账时做减项 */
  async reverseEarning(
    tx: BizTx,
    input: {
      customerId: number;
      amount: number;
      bookingId?: number | null;
      cardId?: number | null;
      storeId?: number | null;
      reversalOf?: number | null;
      remark?: string | null;
      actorId?: number | null;
    },
  ): Promise<{ transactionId: number; pointsReversed: number }> {
    const amount = Math.trunc(input.amount);
    if (amount < 0) throw new BadRequestException('冲减金额不能为负');
    const { pointsPerYuan } = await this.config.member();
    const requiredPoints = Math.floor(amount / CENTS_PER_YUAN) * pointsPerYuan;

    const before = await this.lockCustomerRow(tx, input.customerId);
    await tx
      .update(bizCustomers)
      .set({
        totalSpent: sql`IF(${bizCustomers.totalSpent} >= ${amount}, ${bizCustomers.totalSpent} - ${amount}, 0)`,
        points: sql`IF(${bizCustomers.points} >= ${requiredPoints}, ${bizCustomers.points} - ${requiredPoints}, 0)`,
        updatedBy: input.actorId ?? null,
      })
      .where(
        and(
          eq(bizCustomers.id, input.customerId),
          isNull(bizCustomers.deletedAt),
        ),
      );
    const after = await this.readCustomerRow(tx, input.customerId);
    const pointsReversed = Math.max(before.points - after.points, 0);

    const transactionId = await this.writeLedger(tx, {
      customerId: input.customerId,
      type: 'refund',
      amount,
      pointsDelta: -requiredPoints,
      balancePrincipalAfter: after.balancePrincipal,
      balanceBonusAfter: after.balanceBonus,
      pointsAfter: after.points,
      bookingId: input.bookingId ?? null,
      cardId: input.cardId ?? null,
      storeId: input.storeId ?? null,
      reversalOf: input.reversalOf ?? null,
      remark: input.remark ?? '退款冲减',
      actorId: input.actorId ?? null,
    });

    // 积分不足：先把差额记在 adjust 上（流水和 = 实际积分余额），备注人工确认
    if (pointsReversed < requiredPoints)
      await this.writeLedger(tx, {
        customerId: input.customerId,
        type: 'adjust',
        pointsDelta: requiredPoints - pointsReversed,
        balancePrincipalAfter: after.balancePrincipal,
        balanceBonusAfter: after.balanceBonus,
        pointsAfter: after.points,
        bookingId: input.bookingId ?? null,
        remark: `积分不足，人工确认（应扣 ${requiredPoints}，实扣 ${pointsReversed}）`,
        actorId: input.actorId ?? null,
      });

    await this.syncLevel(tx, input.customerId, input.actorId ?? null);
    return { transactionId, pointsReversed };
  }

  /** 回补储值余额（退入储值 / 充正）：余额只增不减 */
  override async creditBalance(
    tx: BizTx,
    input: {
      customerId: number;
      principal?: number;
      bonus?: number;
      bookingId?: number | null;
      remark?: string | null;
      actorId?: number | null;
    },
  ): Promise<{ transactionId: number }> {
    const principal = Math.trunc(input.principal ?? 0);
    const bonus = Math.trunc(input.bonus ?? 0);
    if (principal < 0 || bonus < 0)
      throw new BadRequestException('回补金额不能为负');
    if (principal + bonus <= 0)
      throw new BadRequestException('回补金额必须大于 0');

    await this.lockCustomerRow(tx, input.customerId);
    await tx
      .update(bizCustomers)
      .set({
        balancePrincipal: sql`${bizCustomers.balancePrincipal} + ${principal}`,
        balanceBonus: sql`${bizCustomers.balanceBonus} + ${bonus}`,
        updatedBy: input.actorId ?? null,
      })
      .where(
        and(
          eq(bizCustomers.id, input.customerId),
          isNull(bizCustomers.deletedAt),
        ),
      );
    const after = await this.readCustomerRow(tx, input.customerId);
    const transactionId = await this.writeLedger(tx, {
      customerId: input.customerId,
      type: 'adjust',
      amount: principal + bonus,
      balanceDeltaPrincipal: principal,
      balanceDeltaBonus: bonus,
      balancePrincipalAfter: after.balancePrincipal,
      balanceBonusAfter: after.balanceBonus,
      pointsAfter: after.points,
      bookingId: input.bookingId ?? null,
      remark: input.remark ?? '余额回补',
      actorId: input.actorId ?? null,
    });
    return { transactionId };
  }

  /**
   * 零变动的流水（次卡核销 / 撤销核销 / 废卡）：只记录事实，不动余额与积分。
   * 调用方若在同一事务里已锁会员行（次卡路径会调 `lockCustomer`），`*_after` 快照即为准确值。
   */
  async recordLedgerOnly(
    tx: BizTx,
    input: {
      customerId: number;
      type: LedgerType;
      amount?: number | undefined;
      cardId?: number | null | undefined;
      bookingId?: number | null | undefined;
      storeId?: number | null | undefined;
      payChannel?: LedgerPayChannel | null | undefined;
      remark?: string | null | undefined;
      actorId?: number | null | undefined;
    },
  ): Promise<number> {
    const after = await this.readCustomerRow(tx, input.customerId);
    return this.writeLedger(tx, {
      customerId: input.customerId,
      type: input.type,
      amount: input.amount ?? 0,
      balancePrincipalAfter: after.balancePrincipal,
      balanceBonusAfter: after.balanceBonus,
      pointsAfter: after.points,
      cardId: input.cardId ?? null,
      bookingId: input.bookingId ?? null,
      storeId: input.storeId ?? null,
      payChannel: input.payChannel ?? null,
      remark: input.remark ?? null,
      actorId: input.actorId ?? null,
    });
  }

  /* ------------------------------------------------------------------ *
   * 端口：等级
   * ------------------------------------------------------------------ */

  /** 自动升级（幂等、只升不降）：取 `status='active'` 且 `upgrade_amount <= total_spent` 中 `sort` 最大者 */
  override async syncLevel(
    tx: BizTx,
    customerId: number,
    actorId?: number | null,
  ): Promise<number | null> {
    const row = await this.lockCustomerRow(tx, customerId);
    const levels = await this.levels.allLevels(tx);
    const target = pickUpgradeLevel(levels, row.totalSpent);
    if (!target) return row.levelId;

    const current =
      row.levelId === null
        ? null
        : (levels.find((level) => level.id === row.levelId) ?? null);
    // 只升不降：目标等级排序不高于当前等级时不动（降级只允许 recount / 手工调级）
    if (current && current.sort >= target.sort) return row.levelId;

    await tx
      .update(bizCustomers)
      .set({ levelId: target.id, updatedBy: actorId ?? null })
      .where(
        and(eq(bizCustomers.id, customerId), isNull(bizCustomers.deletedAt)),
      );
    if (actorId !== undefined && actorId !== null)
      await this.writeLedger(tx, {
        customerId,
        type: 'level_change',
        balancePrincipalAfter: row.balancePrincipal,
        balanceBonusAfter: row.balanceBonus,
        pointsAfter: row.points,
        remark: `自动升级：${current?.name ?? '无等级'} → ${target.name}`,
        actorId,
      });
    return target.id;
  }

  /** 按流水重算余额 / 积分 / 累计消费 / 等级（对账修复，幂等，§15.7 第 7 条） */
  override async recount(
    customerId: number,
    actorId?: number | null,
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      await this.lockCustomerRow(tx, customerId);
      const totals = await this.sumLedger(tx, customerId);
      const target = pickUpgradeLevel(
        await this.levels.allLevels(tx),
        totals.totalSpent,
      );
      await tx
        .update(bizCustomers)
        .set({
          balancePrincipal: Math.max(totals.balancePrincipal, 0),
          balanceBonus: Math.max(totals.balanceBonus, 0),
          points: Math.max(totals.points, 0),
          pointsTotal: Math.max(totals.pointsEarned, 0),
          totalSpent: Math.max(totals.totalSpent, 0),
          levelId: target ? target.id : null,
          updatedBy: actorId ?? null,
        })
        .where(eq(bizCustomers.id, customerId));
    });
  }

  /** 全量等级重算（定时任务 `recountMemberLevels`，幂等；唯一允许降级的入口之一） */
  override async recountAllLevels(): Promise<{ updated: number }> {
    const levels = await this.levels.allLevels();
    const rows = await this.database.db
      .select({
        id: bizCustomers.id,
        levelId: bizCustomers.levelId,
        totalSpent: bizCustomers.totalSpent,
      })
      .from(bizCustomers)
      .where(isNull(bizCustomers.deletedAt));

    const groups = new Map<number | null, number[]>();
    for (const row of rows) {
      const target = pickUpgradeLevel(levels, row.totalSpent);
      const targetId = target ? target.id : null;
      if (targetId === row.levelId) continue;
      const ids = groups.get(targetId) ?? [];
      ids.push(row.id);
      groups.set(targetId, ids);
    }

    let updated = 0;
    for (const [levelId, ids] of groups) {
      if (!ids.length) continue;
      const result = await this.database.db
        .update(bizCustomers)
        .set({ levelId })
        .where(inArray(bizCustomers.id, ids));
      updated += result[0].affectedRows;
    }
    return { updated };
  }

  /* ------------------------------------------------------------------ *
   * 会员列表 / 详情 / 流水
   * ------------------------------------------------------------------ */

  /** 会员列表（顾客即会员，筛选口径见 `CustomerPort.list`） */
  async listMembers(
    page: number,
    pageSize: number,
    filter: MemberListFilter,
  ): Promise<{
    items: (CustomerRow & {
      levelName: string | null;
      levelDiscountPermille: number;
    })[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const result = await this.customers.list(
      page,
      pageSize,
      withoutUndefined({
        keyword: filter.keyword,
        levelId: filter.levelId,
        hasBalance: filter.hasBalance,
      }),
    );
    const levels = await this.levels.allLevels();
    const levelMap = new Map(levels.map((level) => [level.id, level]));
    return {
      items: result.items.map((row) => {
        const level = row.levelId === null ? null : levelMap.get(row.levelId);
        return {
          ...row,
          levelName: level?.name ?? null,
          levelDiscountPermille: level?.discountPermille ?? 1000,
        };
      }),
      // total 直接透传顾客列表的（它就是同一套过滤条件的 COUNT(*)）
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    };
  }

  /** 会员详情：档案 + 等级（次卡由 controller 组装） */
  async memberDetail(id: number): Promise<
    CustomerRow & {
      level: {
        id: number;
        name: string;
        discountPermille: number;
        upgradeAmount: number;
      } | null;
    }
  > {
    const customer = await this.customers.findOne(id);
    const levels = await this.levels.allLevels();
    const level =
      customer.levelId === null
        ? null
        : (levels.find((item) => item.id === customer.levelId) ?? null);
    return {
      ...customer,
      level: level
        ? {
            id: level.id,
            name: level.name,
            discountPermille: level.discountPermille,
            upgradeAmount: level.upgradeAmount,
          }
        : null,
    };
  }

  /** 账务流水（只读、分页，倒序） */
  async listTransactions(
    customerId: number,
    page: number,
    pageSize: number,
    filter: TransactionListFilter = {},
  ): Promise<{
    items: MemberTransactionListRow[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const {
      page: safePage,
      pageSize: safePageSize,
      offset,
    } = parsePagination(page, pageSize);
    const conditions = [eq(bizMemberTransactions.customerId, customerId)];
    if (filter.type)
      conditions.push(eq(bizMemberTransactions.type, filter.type));
    const range = localDateRange(
      bizMemberTransactions.createdAt,
      filter.dateFrom,
      filter.dateTo,
    );
    if (range) conditions.push(range);
    const where = andConditions(conditions);
    const [items, counted] = await Promise.all([
      this.database.db
        .select({
          ...getTableColumns(bizMemberTransactions),
          storeName: sysStores.name,
        })
        .from(bizMemberTransactions)
        .leftJoin(sysStores, eq(bizMemberTransactions.storeId, sysStores.id))
        .where(where)
        .orderBy(desc(bizMemberTransactions.id))
        .limit(safePageSize)
        .offset(offset),
      // count 带上同一个 leftJoin
      this.database.db
        .select({ value: count() })
        .from(bizMemberTransactions)
        .leftJoin(sysStores, eq(bizMemberTransactions.storeId, sysStores.id))
        .where(where),
    ]);
    return {
      items,
      total: readCount(counted),
      page: safePage,
      pageSize: safePageSize,
    };
  }

  /* ------------------------------------------------------------------ *
   * 充值 / 冲正 / 调整 / 入会
   * ------------------------------------------------------------------ */

  /** 充值：方案或自定义金额；服务端重算赠送与本金，绝不信任前端金额（§15.4） */
  async recharge(
    customerId: number,
    input: RechargeInput,
    actor: RequestActor,
  ): Promise<{
    transactionId: number;
    payAmount: number;
    bonusAmount: number;
    balancePrincipal: number;
    balanceBonus: number;
    memberNo: string | null;
  }> {
    const { minRechargeAmount } = await this.config.member();
    const customer = await this.lockCustomerRowReadOnly(customerId);
    if (!customer.phone)
      throw new BadRequestException('会员必须有手机号，请先补全手机号再充值');

    let payAmount = 0;
    let bonusAmount = 0;
    let planId: number | null = null;
    if (input.planId !== undefined && input.planId !== null) {
      const plan = await this.requirePlan(input.planId);
      payAmount = plan.payAmount;
      bonusAmount = plan.bonusAmount;
      planId = plan.id;
      await this.assertBonusRatio(payAmount, bonusAmount);
    } else {
      if (input.payAmount === undefined)
        throw new BadRequestException('请选择充值方案或填写充值金额');
      payAmount = Math.trunc(input.payAmount);
      bonusAmount = 0;
      if (payAmount <= 0) throw new BadRequestException('充值金额必须大于 0');
    }
    if (payAmount < minRechargeAmount)
      throw new BadRequestException(
        `单次充值不得低于 ${(minRechargeAmount / CENTS_PER_YUAN).toFixed(2)} 元`,
      );

    const storeId = await requireCurrentStoreId(this.database.db, actor);
    const actorId = actor.id;
    return this.database.db.transaction(async (tx) => {
      const before = await this.lockCustomerRow(tx, customerId);
      await tx
        .update(bizCustomers)
        .set({
          balancePrincipal: sql`${bizCustomers.balancePrincipal} + ${payAmount}`,
          balanceBonus: sql`${bizCustomers.balanceBonus} + ${bonusAmount}`,
          updatedBy: actorId,
        })
        .where(
          and(eq(bizCustomers.id, customerId), isNull(bizCustomers.deletedAt)),
        );
      const after = await this.readCustomerRow(tx, customerId);
      const transactionId = await this.writeLedger(tx, {
        customerId,
        type: 'recharge',
        amount: payAmount + bonusAmount,
        balanceDeltaPrincipal: payAmount,
        balanceDeltaBonus: bonusAmount,
        balancePrincipalAfter: after.balancePrincipal,
        balanceBonusAfter: after.balanceBonus,
        pointsAfter: after.points,
        payChannel: toLedgerChannel(input.payChannel),
        planId,
        storeId,
        remark:
          input.remark ??
          `充值 ${(payAmount / CENTS_PER_YUAN).toFixed(2)} 元${
            bonusAmount > 0
              ? `，赠送 ${(bonusAmount / CENTS_PER_YUAN).toFixed(2)} 元`
              : ''
          }`,
        actorId,
      });

      // 首次充值入会（§15.1）：建会员号 / 入会时间 / 最低启用等级
      let memberNo = before.memberNo;
      if (before.levelId === null || before.memberNo === null) {
        const membership = await this.customers.ensureMembership(
          tx,
          customerId,
          actorId,
        );
        memberNo = membership.memberNo;
        if (before.levelId === null) {
          const lowest = pickLowestLevel(await this.levels.allLevels(tx));
          if (lowest)
            await tx
              .update(bizCustomers)
              .set({ levelId: lowest.id, updatedBy: actorId })
              .where(eq(bizCustomers.id, customerId));
        }
      }

      const latest = await this.readCustomerRow(tx, customerId);
      return {
        transactionId,
        payAmount,
        bonusAmount,
        balancePrincipal: latest.balancePrincipal,
        balanceBonus: latest.balanceBonus,
        memberNo: latest.memberNo ?? memberNo,
      };
    });
  }

  /**
   * 冲正 / 退款（§9.6）：写**反向流水**（`reversal_of` 指向原流水），原流水不改。
   * - `mode='balance'`：从储值余额退回 → 条件更新回减余额；
   * - `mode='cash'`：现金退回 → 只写流水，不动余额。
   *
   * 说明：冲正不冲减 `total_spent` / 积分（那是 `reverseConsumption` 的口径），
   * 因此流水类型用 `adjust`、金额为正数，`recount` 不会把它算进累计消费。
   */
  async refundMember(
    customerId: number,
    input: MemberRefundInput,
    actor: RequestActor,
  ): Promise<{
    transactionId: number;
    mode: 'balance' | 'cash';
    amount: number;
  }> {
    const amount = Math.trunc(input.amount);
    if (amount <= 0) throw new BadRequestException('冲正金额必须大于 0');
    const { refundNeedReason } = await this.config.member();
    if (refundNeedReason && !input.reason?.trim())
      throw new BadRequestException('按当前配置，冲正必须填写原因');

    const reversalOf = input.reversalOf ?? null;
    const reasonText = input.reason?.trim() || '未填写原因';
    const storeId = await requireCurrentStoreId(this.database.db, actor);
    const actorId = actor.id;
    return this.database.db.transaction(async (tx) => {
      if (reversalOf !== null)
        await this.requireTransaction(tx, customerId, reversalOf);

      if (input.mode === 'cash') {
        const row = await this.lockCustomerRow(tx, customerId);
        const transactionId = await this.writeLedger(tx, {
          customerId,
          type: 'adjust',
          amount,
          balancePrincipalAfter: row.balancePrincipal,
          balanceBonusAfter: row.balanceBonus,
          pointsAfter: row.points,
          reversalOf,
          storeId,
          remark: `现金冲正：${reasonText}`,
          actorId,
        });
        return { transactionId, mode: input.mode, amount };
      }

      const mode = await this.resolveDeductMode();
      const before = await this.lockCustomerRow(tx, customerId);
      const { bonus, principal } =
        mode === 'principal_first'
          ? {
              bonus: Math.max(amount - before.balancePrincipal, 0),
              principal: Math.min(amount, before.balancePrincipal),
            }
          : splitBalanceDeduction(
              amount,
              before.balancePrincipal,
              before.balanceBonus,
              mode,
            );
      const result = await tx
        .update(bizCustomers)
        .set({
          balanceBonus: sql`${bizCustomers.balanceBonus} - ${bonus}`,
          balancePrincipal: sql`${bizCustomers.balancePrincipal} - ${principal}`,
          updatedBy: actorId,
        })
        .where(
          and(
            eq(bizCustomers.id, customerId),
            isNull(bizCustomers.deletedAt),
            gte(bizCustomers.balanceBonus, bonus),
            gte(bizCustomers.balancePrincipal, principal),
          ),
        );
      if (!result[0].affectedRows)
        throw new ConflictException('储值余额不足，无法冲正');

      const after = await this.readCustomerRow(tx, customerId);
      const transactionId = await this.writeLedger(tx, {
        customerId,
        type: 'adjust',
        amount,
        balanceDeltaPrincipal: -principal,
        balanceDeltaBonus: -bonus,
        balancePrincipalAfter: after.balancePrincipal,
        balanceBonusAfter: after.balanceBonus,
        pointsAfter: after.points,
        reversalOf,
        storeId,
        remark: `储值冲正：${reasonText}`,
        actorId,
      });
      return { transactionId, mode: input.mode, amount };
    });
  }

  /** 手工调级 / 调积分 / 调余额：必须填原因并写流水（§9.6 / §15.2） */
  async adjustMember(
    customerId: number,
    input: MemberAdjustInput,
    actor: RequestActor,
  ): Promise<{ transactionId: number | null; levelChanged: boolean }> {
    const reason = input.reason?.trim();
    if (!reason) throw new BadRequestException('手工调整必须填写原因');
    const pointsDelta = Math.trunc(input.pointsDelta ?? 0);
    const principalDelta = Math.trunc(input.balancePrincipalDelta ?? 0);
    const bonusDelta = Math.trunc(input.balanceBonusDelta ?? 0);
    const hasDelta =
      pointsDelta !== 0 || principalDelta !== 0 || bonusDelta !== 0;
    const hasLevel = input.levelId !== undefined;
    if (!hasDelta && !hasLevel)
      throw new BadRequestException('请至少填写一项调整内容');

    const storeId = await requireCurrentStoreId(this.database.db, actor);
    const actorId = actor.id;
    return this.database.db.transaction(async (tx) => {
      await this.lockCustomerRow(tx, customerId);
      let transactionId: number | null = null;

      if (hasDelta) {
        const patch: {
          points?: SQL;
          balancePrincipal?: SQL;
          balanceBonus?: SQL;
        } = {};
        const conditions: SQL[] = [
          eq(bizCustomers.id, customerId),
          isNull(bizCustomers.deletedAt),
        ];
        if (pointsDelta !== 0) {
          patch.points = sql`${bizCustomers.points} + ${pointsDelta}`;
          if (pointsDelta < 0)
            conditions.push(gte(bizCustomers.points, -pointsDelta));
        }
        if (principalDelta !== 0) {
          patch.balancePrincipal = sql`${bizCustomers.balancePrincipal} + ${principalDelta}`;
          if (principalDelta < 0)
            conditions.push(
              gte(bizCustomers.balancePrincipal, -principalDelta),
            );
        }
        if (bonusDelta !== 0) {
          patch.balanceBonus = sql`${bizCustomers.balanceBonus} + ${bonusDelta}`;
          if (bonusDelta < 0)
            conditions.push(gte(bizCustomers.balanceBonus, -bonusDelta));
        }

        const result = await tx
          .update(bizCustomers)
          .set({ ...patch, updatedBy: actorId })
          .where(and(...conditions));
        if (!result[0].affectedRows)
          throw new ConflictException(
            '积分或余额不足，调整失败（不做部分调整）',
          );

        const after = await this.readCustomerRow(tx, customerId);
        transactionId = await this.writeLedger(tx, {
          customerId,
          type: 'adjust',
          amount: Math.abs(principalDelta) + Math.abs(bonusDelta),
          balanceDeltaPrincipal: principalDelta,
          balanceDeltaBonus: bonusDelta,
          pointsDelta,
          balancePrincipalAfter: after.balancePrincipal,
          balanceBonusAfter: after.balanceBonus,
          pointsAfter: after.points,
          storeId,
          remark: `手工调整：${reason}`,
          actorId,
        });
      }

      let levelChanged = false;
      if (hasLevel) {
        const levelId = input.levelId ?? null;
        if (levelId !== null) await this.levels.findOne(levelId);
        const before = await this.readCustomerRow(tx, customerId);
        if (before.levelId !== levelId) {
          await tx
            .update(bizCustomers)
            .set({ levelId, updatedBy: actorId })
            .where(eq(bizCustomers.id, customerId));
          levelChanged = true;
          const after = await this.readCustomerRow(tx, customerId);
          await this.writeLedger(tx, {
            customerId,
            type: 'level_change',
            balancePrincipalAfter: after.balancePrincipal,
            balanceBonusAfter: after.balanceBonus,
            pointsAfter: after.points,
            storeId,
            remark: `手工调级：${reason}`,
            actorId,
          });
        }
      }
      return { transactionId, levelChanged };
    });
  }

  /** 把已有顾客纳为会员（§9.6 `POST /biz/members`）：建会员号 / 入会时间 / 最低启用等级 */
  async ensureMember(
    customerId: number,
    actorId: number,
  ): Promise<{ memberNo: string; memberSince: Date; levelId: number | null }> {
    const before = await this.lockCustomerRowReadOnly(customerId);
    if (!before.phone)
      throw new BadRequestException('会员必须有手机号，请先补全手机号');
    return this.database.db.transaction(async (tx) => {
      await this.lockCustomerRow(tx, customerId);
      const membership = await this.customers.ensureMembership(
        tx,
        customerId,
        actorId,
      );
      let levelId = before.levelId;
      if (levelId === null) {
        const lowest = pickLowestLevel(await this.levels.allLevels(tx));
        levelId = lowest ? lowest.id : null;
        await tx
          .update(bizCustomers)
          .set({ levelId, updatedBy: actorId })
          .where(eq(bizCustomers.id, customerId));
      }
      return {
        memberNo: membership.memberNo,
        memberSince: membership.memberSince,
        levelId,
      };
    });
  }

  /* ------------------------------------------------------------------ *
   * 内部工具
   * ------------------------------------------------------------------ */

  /** 写流水（唯一入口）：只 INSERT，`*_after` 快照由调用方保证准确性 */
  private async writeLedger(tx: BizTx, input: LedgerInput): Promise<number> {
    /*
     * 门店归属：显式传了直接用；否则若有预约，顺带出「这笔钱发生在哪家店」——
     * 消费 / 余额支付 / 积分抵扣 / 退款冲减全都天然归店，调用方不用每个都记着传。
     * 注意：这**只是追溯**，不拆资产池（余额/积分仍全店通兑）。
     */
    let storeId = input.storeId ?? null;
    if (
      storeId === null &&
      input.bookingId !== undefined &&
      input.bookingId !== null
    ) {
      const [booking] = await tx
        .select({ storeId: bizBookings.storeId })
        .from(bizBookings)
        .where(eq(bizBookings.id, input.bookingId))
        .limit(1);
      if (booking) storeId = booking.storeId;
    }
    const result = await tx.insert(bizMemberTransactions).values({
      customerId: input.customerId,
      type: input.type,
      amount: input.amount ?? 0,
      balanceDeltaPrincipal: input.balanceDeltaPrincipal ?? 0,
      balanceDeltaBonus: input.balanceDeltaBonus ?? 0,
      balancePrincipalAfter: Math.max(input.balancePrincipalAfter, 0),
      balanceBonusAfter: Math.max(input.balanceBonusAfter, 0),
      pointsDelta: input.pointsDelta ?? 0,
      pointsAfter: Math.max(input.pointsAfter, 0),
      payChannel: input.payChannel ?? null,
      bookingId: input.bookingId ?? null,
      cardId: input.cardId ?? null,
      planId: input.planId ?? null,
      reversalOf: input.reversalOf ?? null,
      storeId,
      remark: input.remark ? input.remark.slice(0, 200) : null,
      createdBy: input.actorId ?? null,
    });
    return Number(result[0].insertId);
  }

  /** 事务内锁会员行（`FOR UPDATE`） */
  private async lockCustomerRow(
    tx: BizTx,
    customerId: number,
  ): Promise<CustomerRow> {
    const [row] = await tx
      .select()
      .from(bizCustomers)
      .where(
        and(eq(bizCustomers.id, customerId), isNull(bizCustomers.deletedAt)),
      )
      .limit(1)
      .for('update');
    if (!row) throw new NotFoundException('会员不存在');
    return row;
  }

  private async readCustomerRow(
    executor: BizDatabase,
    customerId: number,
  ): Promise<CustomerRow> {
    const [row] = await executor
      .select()
      .from(bizCustomers)
      .where(
        and(eq(bizCustomers.id, customerId), isNull(bizCustomers.deletedAt)),
      )
      .limit(1);
    if (!row) throw new NotFoundException('会员不存在');
    return row;
  }

  /** 充值 / 入会前的只读校验（真正加余额在事务内重新锁行） */
  private async lockCustomerRowReadOnly(
    customerId: number,
  ): Promise<CustomerRow> {
    return this.readCustomerRow(this.database.db, customerId);
  }

  /** 按流水聚合：对账等式的三个和 + 累计消费 / 累计获得积分 */
  private async sumLedger(
    executor: BizDatabase,
    customerId: number,
  ): Promise<{
    balancePrincipal: number;
    balanceBonus: number;
    points: number;
    pointsEarned: number;
    totalSpent: number;
  }> {
    const [row] = await executor
      .select({
        balancePrincipal: sql<string>`COALESCE(SUM(${bizMemberTransactions.balanceDeltaPrincipal}), 0)`,
        balanceBonus: sql<string>`COALESCE(SUM(${bizMemberTransactions.balanceDeltaBonus}), 0)`,
        points: sql<string>`COALESCE(SUM(${bizMemberTransactions.pointsDelta}), 0)`,
        pointsEarned: sql<string>`COALESCE(SUM(CASE WHEN ${bizMemberTransactions.pointsDelta} > 0 THEN ${bizMemberTransactions.pointsDelta} ELSE 0 END), 0)`,
        totalSpent: sql<string>`COALESCE(SUM(CASE
            WHEN ${bizMemberTransactions.type} IN ('consume', 'card_buy') THEN ${bizMemberTransactions.amount}
            WHEN ${bizMemberTransactions.type} = 'refund' THEN -${bizMemberTransactions.amount}
            ELSE 0 END), 0)`,
      })
      .from(bizMemberTransactions)
      .where(eq(bizMemberTransactions.customerId, customerId));
    return {
      balancePrincipal: Number(row?.balancePrincipal ?? 0),
      balanceBonus: Number(row?.balanceBonus ?? 0),
      points: Number(row?.points ?? 0),
      pointsEarned: Number(row?.pointsEarned ?? 0),
      totalSpent: Number(row?.totalSpent ?? 0),
    };
  }

  private async requirePlan(
    planId: number,
  ): Promise<{ id: number; payAmount: number; bonusAmount: number }> {
    const [plan] = await this.database.db
      .select({
        id: bizRechargePlans.id,
        payAmount: bizRechargePlans.payAmount,
        bonusAmount: bizRechargePlans.bonusAmount,
        status: bizRechargePlans.status,
        deletedAt: bizRechargePlans.deletedAt,
      })
      .from(bizRechargePlans)
      .where(eq(bizRechargePlans.id, planId))
      .limit(1);
    if (!plan || plan.deletedAt !== null)
      throw new NotFoundException('充值方案不存在');
    if (plan.status !== 'active') throw new ConflictException('充值方案已停用');
    return {
      id: plan.id,
      payAmount: plan.payAmount,
      bonusAmount: plan.bonusAmount,
    };
  }

  private async assertBonusRatio(
    payAmount: number,
    bonusAmount: number,
  ): Promise<void> {
    const { maxBonusPermille } = await this.config.member();
    if (bonusAmount * 1000 > payAmount * maxBonusPermille)
      throw new BadRequestException('赠送金额超过配置上限');
  }

  private async requireTransaction(
    tx: BizTx,
    customerId: number,
    transactionId: number,
  ): Promise<void> {
    const [row] = await tx
      .select({ id: bizMemberTransactions.id })
      .from(bizMemberTransactions)
      .where(
        and(
          eq(bizMemberTransactions.id, transactionId),
          eq(bizMemberTransactions.customerId, customerId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('被冲正的原流水不存在');
  }

  private async resolveDeductMode(): Promise<
    'bonus_first' | 'principal_first' | 'proportional'
  > {
    const raw = await this.config.getString(
      'biz.member.bonusDeductMode',
      'bonus_first',
    );
    if (raw === 'principal_first') return 'principal_first';
    return raw === 'proportional' ? 'proportional' : 'bonus_first';
  }
}

/** 支付单口径 → 流水口径（流水表枚举更窄：现金 / 微信 / 支付宝 / 储值 / 次卡） */
export function toLedgerChannel(
  channel: PayChannel | null | undefined,
): LedgerPayChannel | null {
  switch (channel) {
    case 'cash':
      return 'cash';
    case 'wechat':
    case 'wechat_offline':
    case 'wxpay_native':
    case 'wxpay_jsapi':
      return 'wechat';
    case 'alipay':
    case 'alipay_offline':
    case 'alipay_qr':
      return 'alipay';
    case 'balance':
      return 'balance';
    case 'card':
      return 'card';
    default:
      return null;
  }
}
