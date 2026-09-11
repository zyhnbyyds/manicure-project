import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  sql,
} from 'drizzle-orm';
import { DatabaseService } from '../../../../database/database.service';
import {
  bizCustomers,
  bizMemberCardLogs,
  bizMemberCards,
} from '../../../../database/schema/index.js';
import { BizConfigService } from '../../common/biz-config.service.js';
import { buildDocNo } from '../../common/doc-no.js';
import { MemberCardPort } from '../../common/ports.js';
import type { MemberCardRow, PageResult } from '../../common/ports.js';
import {
  andConditions,
  keywordLike,
  parsePagination,
} from '../../common/query.js';
import type { BizDatabase, BizTx } from '../../common/tx.js';
import { CardTypesService } from '../card-types/card-types.service.js';
import { MemberAccountsService } from '../member-accounts/member-accounts.service.js';

export type MemberCardRecord = typeof bizMemberCards.$inferSelect;
export type MemberCardLogRow = typeof bizMemberCardLogs.$inferSelect;
export type CardPayChannel = MemberCardRecord['payChannel'];

export type IssueCardInput = {
  customerId: number;
  cardTypeId: number;
  payChannel: CardPayChannel;
  /** 可改价；缺省用卡种售价 */
  price?: number | undefined;
  remark?: string | null | undefined;
  actorId?: number | null | undefined;
  /**
   * 只建卡、不写 `card_buy` 流水、不计累计消费与积分。
   *
   * 积分兑换发出的卡（§15.3）必须传 `true`：兑换的「钱」是积分，购卡流水与消费口径都不该产生，
   * 兑换记录写 `points_redeem` 流水即可。
   */
  skipLedger?: boolean | undefined;
};

export type UseCardInput = {
  cardId: number;
  serviceItemId: number;
  bookingId?: number | null | undefined;
  actorId?: number | null | undefined;
  remark?: string | null | undefined;
};

export type RevertUseInput = {
  cardId: number;
  bookingId?: number | null | undefined;
  actorId?: number | null | undefined;
  /** 撤销原因（接口层必填，§9.6） */
  remark?: string | null | undefined;
};

export type MemberCardListFilter = {
  customerId?: number | undefined;
  cardTypeId?: number | undefined;
  status?: 'active' | 'used_up' | 'expired' | 'refunded' | undefined;
  keyword?: string | undefined;
};

/**
 * 会员次卡（§15.5，端口实现见 `MemberCardPort`）。
 *
 * - `used_times` / `status` 只能由本 service 条件更新（`affectedRows` 是唯一闸门）；
 * - 核销顺序写 `biz_member_card_log(type='use')`，撤销写 `type='revert'`（只追加）；
 * - 核销不叠加等级折扣（`payable = 0`），项目必须在卡种适用集合内；
 * - 锁顺序：先锁 `biz_customer` 再动 `biz_member_card`（§6.6）。
 */
@Injectable()
export class MemberCardsService extends MemberCardPort {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: BizConfigService,
    private readonly accounts: MemberAccountsService,
    private readonly cardTypes: CardTypesService,
  ) {
    super();
  }

  /* ------------------------------------------------------------------ *
   * 端口：发卡 / 核销 / 撤销 / 校验 / 到期
   * ------------------------------------------------------------------ */

  /** 发卡：INSERT 后回填 `card_no = C{yyyyMMdd}{id}`（主键回填，§4.4） */
  override async issueCard(
    tx: BizTx,
    input: IssueCardInput,
  ): Promise<{ id: number; cardNo: string; expireAt: Date | null }> {
    const cardType = await this.cardTypes.requireActiveCardType(
      tx,
      input.cardTypeId,
    );
    const price = Math.trunc(input.price ?? cardType.price);
    if (price < 0) throw new BadRequestException('卡价不能为负');
    await this.accounts.lockCustomer(tx, input.customerId);

    const purchasedAt = new Date();
    const expireAt =
      cardType.validDays > 0
        ? new Date(purchasedAt.getTime() + cardType.validDays * 86_400_000)
        : null;

    const inserted = await tx.insert(bizMemberCards).values({
      // card_no NOT NULL + UNIQUE：先落临时号，拿到 id 后回填正式单号
      cardNo: tempCardNo(),
      customerId: input.customerId,
      cardTypeId: cardType.id,
      cardName: cardType.name,
      totalTimes: cardType.totalTimes,
      usedTimes: 0,
      price,
      payChannel: input.payChannel,
      purchasedAt,
      expireAt,
      status: 'active',
      remark: input.remark ?? null,
      createdBy: input.actorId ?? null,
      updatedBy: input.actorId ?? null,
    });
    const id = Number(inserted[0].insertId);
    const { timezone } = await this.config.booking();
    const cardNo = buildDocNo('C', id, timezone, purchasedAt);
    await tx
      .update(bizMemberCards)
      .set({ cardNo })
      .where(eq(bizMemberCards.id, id));

    if (input.skipLedger !== true)
      await this.accounts.applyEarning(tx, {
        customerId: input.customerId,
        amount: price,
        type: 'card_buy',
        cardId: id,
        payChannel: input.payChannel,
        remark: input.remark ?? `购卡：${cardType.name}`,
        actorId: input.actorId ?? null,
      });

    return { id, cardNo, expireAt };
  }

  /** 核销一次：条件更新当闸门（状态 / 次数 / 有效期），成功后写核销日志 + 流水 */
  override async useCard(
    tx: BizTx,
    input: UseCardInput,
  ): Promise<{
    cardId: number;
    usedTimes: number;
    totalTimes: number;
    status: string;
  }> {
    const card = await this.assertUsable(tx, input.cardId, [
      input.serviceItemId,
    ]);
    await this.accounts.lockCustomer(tx, card.customerId);

    // 用原生 SQL 控制 SET 赋值顺序：MySQL 的 UPDATE 从左到右赋值，后置表达式会读到前面刚赋的新值，
    // 所以 status 必须写在 used_times 之前（drizzle 的 .set() 按表列顺序重排，做不到，见 smoke 验证）。
    const result = await tx.execute(sql`
      UPDATE biz_member_card
         SET status = IF(used_times + 1 >= total_times, 'used_up', 'active'),
             used_times = used_times + 1,
             updated_by = ${input.actorId ?? null}
       WHERE id = ${input.cardId}
         AND deleted_at IS NULL
         AND status = 'active'
         AND used_times < total_times
         AND (expire_at IS NULL OR expire_at > NOW())
    `);
    if (!result[0].affectedRows)
      throw new ConflictException('次卡不可核销（状态已变或次数已用完）');

    const after = await this.readCard(tx, input.cardId);
    await tx.insert(bizMemberCardLogs).values({
      cardId: input.cardId,
      bookingId: input.bookingId ?? null,
      serviceItemId: input.serviceItemId,
      type: 'use',
      times: 1,
      remark: input.remark ?? null,
      createdBy: input.actorId ?? null,
    });
    await this.accounts.recordLedgerOnly(tx, {
      customerId: card.customerId,
      type: 'card_use',
      cardId: input.cardId,
      bookingId: input.bookingId ?? null,
      payChannel: 'card',
      remark: input.remark ?? `次卡核销：${card.cardName}`,
      actorId: input.actorId ?? null,
    });

    return {
      cardId: after.id,
      usedTimes: after.usedTimes,
      totalTimes: after.totalTimes,
      status: after.status,
    };
  }

  /** 撤销一次核销：写 `type='revert'` 日志 + 条件更新回补次数（已退卡不允许撤销） */
  override async revertUse(tx: BizTx, input: RevertUseInput): Promise<void> {
    const card = await this.requireCard(tx, input.cardId);
    if (card.status === 'refunded')
      throw new ConflictException('已退卡的核销记录不能撤销');

    const bookingId = input.bookingId ?? null;
    const useLog = await this.findLastUseLog(tx, card.id, bookingId);
    if (!useLog) throw new ConflictException('没有可撤销的核销记录');

    await this.accounts.lockCustomer(tx, card.customerId);
    // 同上：status 必须先于 used_times 赋值（used_up / expired 回补后恢复 active；refunded 排除）
    const result = await tx.execute(sql`
      UPDATE biz_member_card
         SET status = IF(status IN ('used_up', 'expired'), 'active', status),
             used_times = used_times - 1,
             updated_by = ${input.actorId ?? null}
       WHERE id = ${card.id}
         AND deleted_at IS NULL
         AND status <> 'refunded'
         AND used_times > 0
    `);
    if (!result[0].affectedRows)
      throw new ConflictException('没有可撤销的核销记录');

    const reason = input.remark?.trim() || '未填写原因';
    const logBookingId = useLog.bookingId ?? bookingId;
    await tx.insert(bizMemberCardLogs).values({
      cardId: card.id,
      bookingId: logBookingId,
      serviceItemId: useLog.serviceItemId,
      type: 'revert',
      times: 1,
      remark: `撤销核销：${reason}`.slice(0, 200),
      createdBy: input.actorId ?? null,
    });
    await this.accounts.recordLedgerOnly(tx, {
      customerId: card.customerId,
      type: 'card_revert',
      cardId: card.id,
      bookingId: logBookingId,
      payChannel: 'card',
      remark: `撤销次卡核销：${reason}`,
      actorId: input.actorId ?? null,
    });
  }

  /** 可用性校验：卡存在 / 未退 / 未过期 / 有剩余次数 / 项目在卡种适用集合内 */
  override async assertUsable(
    tx: BizTx,
    cardId: number,
    serviceItemIds: number[],
  ): Promise<MemberCardRow> {
    const card = await this.requireCard(tx, cardId);
    if (card.status === 'refunded') throw new ConflictException('次卡已退卡');
    if (card.status === 'expired') throw new ConflictException('次卡已过期');
    if (card.status === 'used_up' || card.usedTimes >= card.totalTimes)
      throw new ConflictException('次卡次数已用完');
    if (card.expireAt !== null && card.expireAt.getTime() <= Date.now())
      throw new ConflictException('次卡已过期');

    const wanted = [...new Set(serviceItemIds.map((id) => Math.trunc(id)))];
    if (wanted.length) {
      const allowed = new Set(
        await this.cardTypes.applicableServiceItemIds(tx, card.cardTypeId),
      );
      if (!allowed.size) throw new ConflictException('卡种未配置适用项目');
      const invalid = wanted.filter((id) => !allowed.has(id));
      if (invalid.length)
        throw new ConflictException(
          `次卡不适用于所选项目（项目 id：${invalid.join(', ')}）`,
        );
    }
    return card;
  }

  /** 到期置 `expired`（定时任务 `expireMemberCards`，幂等，不碰钱） */
  override async expireCards(): Promise<{ expired: number }> {
    const result = await this.database.db
      .update(bizMemberCards)
      .set({ status: 'expired' })
      .where(
        and(
          isNull(bizMemberCards.deletedAt),
          eq(bizMemberCards.status, 'active'),
          isNotNull(bizMemberCards.expireAt),
          lte(bizMemberCards.expireAt, new Date()),
        ),
      );
    return { expired: result[0].affectedRows };
  }

  /* ------------------------------------------------------------------ *
   * 列表 / 详情 / 退卡
   * ------------------------------------------------------------------ */

  /**
   * 后台发卡入口（§9.6 `POST /biz/member-cards`）：自己开事务。
   *
   * 储值支付（`payChannel='balance'`）时用 `applyBalancePayment` 条件扣款（不足 409、不部分扣），
   * 再在同事务里发卡；其余渠道由收银台落支付单（`purpose=card_buy`），本方法只负责发卡与记账。
   */
  async issue(
    input: {
      customerId: number;
      cardTypeId: number;
      payChannel: CardPayChannel;
      price?: number | undefined;
      remark?: string | null | undefined;
    },
    actorId: number,
  ): Promise<{ id: number; cardNo: string; expireAt: Date | null }> {
    return this.database.db.transaction(async (tx) => {
      const cardType = await this.cardTypes.requireActiveCardType(
        tx,
        input.cardTypeId,
      );
      const price = Math.trunc(input.price ?? cardType.price);
      if (price < 0) throw new BadRequestException('卡价不能为负');
      if (input.payChannel === 'balance' && price > 0)
        await this.accounts.applyBalancePayment(tx, {
          customerId: input.customerId,
          amount: price,
          remark: `购卡：${cardType.name}`,
          actorId,
        });
      return this.issueCard(tx, {
        customerId: input.customerId,
        cardTypeId: input.cardTypeId,
        payChannel: input.payChannel,
        price,
        remark: input.remark ?? null,
        actorId,
      });
    });
  }

  /** 后台核销入口：自己开事务 */
  async use(
    input: {
      cardId: number;
      serviceItemId: number;
      bookingId?: number | null | undefined;
      remark?: string | null | undefined;
    },
    actorId: number,
  ): Promise<{
    cardId: number;
    usedTimes: number;
    totalTimes: number;
    status: string;
  }> {
    return this.database.db.transaction((tx) =>
      this.useCard(tx, {
        cardId: input.cardId,
        serviceItemId: input.serviceItemId,
        bookingId: input.bookingId ?? null,
        remark: input.remark ?? null,
        actorId,
      }),
    );
  }

  /** 后台撤销核销入口：自己开事务 */
  async revert(
    input: {
      cardId: number;
      bookingId?: number | null | undefined;
      reason: string;
    },
    actorId: number,
  ): Promise<void> {
    if (!input.reason?.trim())
      throw new BadRequestException('撤销核销必须填写原因');
    await this.database.db.transaction((tx) =>
      this.revertUse(tx, {
        cardId: input.cardId,
        bookingId: input.bookingId ?? null,
        remark: input.reason,
        actorId,
      }),
    );
  }

  async list(
    page: number,
    pageSize: number,
    filter: MemberCardListFilter = {},
  ): Promise<
    PageResult<
      MemberCardRecord & {
        customerName: string | null;
        customerPhone: string | null;
      }
    >
  > {
    const {
      page: safePage,
      pageSize: safePageSize,
      offset,
    } = parsePagination(page, pageSize);
    const conditions = [isNull(bizMemberCards.deletedAt)];
    if (filter.customerId !== undefined)
      conditions.push(eq(bizMemberCards.customerId, filter.customerId));
    if (filter.cardTypeId !== undefined)
      conditions.push(eq(bizMemberCards.cardTypeId, filter.cardTypeId));
    if (filter.status)
      conditions.push(eq(bizMemberCards.status, filter.status));
    const keyword = keywordLike(bizMemberCards.cardNo, filter.keyword);
    if (keyword) conditions.push(keyword);

    const items = await this.database.db
      .select({
        ...getTableColumns(bizMemberCards),
        customerName: bizCustomers.name,
        customerPhone: bizCustomers.phone,
      })
      .from(bizMemberCards)
      .leftJoin(bizCustomers, eq(bizMemberCards.customerId, bizCustomers.id))
      .where(andConditions(conditions))
      .orderBy(desc(bizMemberCards.id))
      .limit(safePageSize)
      .offset(offset);
    return { items, page: safePage, pageSize: safePageSize };
  }

  /** 会员详情用：某会员的全部次卡（按 id 倒序） */
  override async listByCustomer(
    customerId: number,
  ): Promise<MemberCardRecord[]> {
    return this.database.db
      .select()
      .from(bizMemberCards)
      .where(
        and(
          eq(bizMemberCards.customerId, customerId),
          isNull(bizMemberCards.deletedAt),
        ),
      )
      .orderBy(desc(bizMemberCards.id))
      .limit(200);
  }

  async findOne(id: number): Promise<
    MemberCardRecord & {
      customerName: string | null;
      customerPhone: string | null;
      cardTypeName: string | null;
      applicableItems: { serviceItemId: number; name: string; price: number }[];
      logs: MemberCardLogRow[];
    }
  > {
    const card = await this.requireCard(this.database.db, id);
    const [customer] = await this.database.db
      .select({
        name: bizCustomers.name,
        phone: bizCustomers.phone,
        levelId: bizCustomers.levelId,
      })
      .from(bizCustomers)
      .where(eq(bizCustomers.id, card.customerId))
      .limit(1);
    const cardType = await this.cardTypes
      .requireCardType(this.database.db, card.cardTypeId)
      .catch(() => null);
    const logs = await this.database.db
      .select()
      .from(bizMemberCardLogs)
      .where(eq(bizMemberCardLogs.cardId, id))
      .orderBy(desc(bizMemberCardLogs.id))
      .limit(50);
    return {
      ...card,
      customerName: customer?.name ?? null,
      customerPhone: customer?.phone ?? null,
      cardTypeName: cardType?.name ?? null,
      applicableItems: (
        await this.cardTypes.applicableItems(this.database.db, card.cardTypeId)
      ).map((item) => ({
        serviceItemId: item.serviceItemId,
        name: item.name,
        price: item.price,
      })),
      logs,
    };
  }

  /**
   * 退卡（§15.5 / §9.6）：人工填退款金额 → 置 `refunded`，写 `refund` 流水并冲减累计消费与积分。
   * 金额由店员填写（不做自动按次折算），审批流程在收银模块（§17.4）。
   */
  async refund(
    cardId: number,
    amount: number,
    reason: string,
    actorId: number,
  ): Promise<void> {
    const money = Math.trunc(amount);
    if (!Number.isFinite(money) || money < 0)
      throw new BadRequestException('退款金额必须是非负整数（分）');
    if (!reason?.trim()) throw new BadRequestException('退卡必须填写原因');

    await this.database.db.transaction(async (tx) => {
      const card = await this.requireCard(tx, cardId);
      if (card.status === 'refunded') throw new ConflictException('该卡已退');
      await this.accounts.lockCustomer(tx, card.customerId);

      const result = await tx
        .update(bizMemberCards)
        .set({ status: 'refunded', updatedBy: actorId })
        .where(
          and(
            eq(bizMemberCards.id, cardId),
            isNull(bizMemberCards.deletedAt),
            ne(bizMemberCards.status, 'refunded'),
          ),
        );
      if (!result[0].affectedRows) throw new ConflictException('该卡已退');

      if (money > 0)
        await this.accounts.reverseEarning(tx, {
          customerId: card.customerId,
          amount: money,
          cardId,
          remark: `退卡：${reason.trim()}`,
          actorId,
        });
      else
        await this.accounts.recordLedgerOnly(tx, {
          customerId: card.customerId,
          type: 'card_revert',
          cardId,
          remark: `退卡（退款 0 元）：${reason.trim()}`,
          actorId,
        });
    });
  }

  /** 废卡（撤销积分兑换时调用）：不退款、不冲消费，只作废并留痕 */
  async voidCard(
    tx: BizTx,
    cardId: number,
    reason: string,
    actorId: number,
  ): Promise<boolean> {
    const card = await this.requireCard(tx, cardId);
    if (card.status === 'refunded') return false;
    await this.accounts.lockCustomer(tx, card.customerId);
    const result = await tx
      .update(bizMemberCards)
      .set({ status: 'refunded', updatedBy: actorId })
      .where(
        and(
          eq(bizMemberCards.id, cardId),
          isNull(bizMemberCards.deletedAt),
          ne(bizMemberCards.status, 'refunded'),
        ),
      );
    if (!result[0].affectedRows) return false;
    await this.accounts.recordLedgerOnly(tx, {
      customerId: card.customerId,
      type: 'card_revert',
      cardId,
      remark: `废卡：${reason}`,
      actorId,
    });
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 内部工具
   * ------------------------------------------------------------------ */

  private async requireCard(
    executor: BizDatabase,
    id: number,
  ): Promise<MemberCardRecord> {
    const [card] = await executor
      .select()
      .from(bizMemberCards)
      .where(and(eq(bizMemberCards.id, id), isNull(bizMemberCards.deletedAt)))
      .limit(1);
    if (!card) throw new NotFoundException('次卡不存在');
    return card;
  }

  private async readCard(tx: BizTx, id: number): Promise<MemberCardRecord> {
    return this.requireCard(tx, id);
  }

  private async findLastUseLog(
    tx: BizTx,
    cardId: number,
    bookingId: number | null,
  ): Promise<MemberCardLogRow | null> {
    const conditions = [
      eq(bizMemberCardLogs.cardId, cardId),
      eq(bizMemberCardLogs.type, 'use'),
    ];
    if (bookingId !== null)
      conditions.push(eq(bizMemberCardLogs.bookingId, bookingId));
    const [log] = await tx
      .select()
      .from(bizMemberCardLogs)
      .where(and(...conditions))
      .orderBy(desc(bizMemberCardLogs.id))
      .limit(1);
    return log ?? null;
  }

  /** 批量按会员取卡（会员列表展开用，避免 N+1） */
  async listByCustomers(
    customerIds: number[],
  ): Promise<Map<number, MemberCardRecord[]>> {
    const map = new Map<number, MemberCardRecord[]>();
    const ids = [...new Set(customerIds)];
    if (!ids.length) return map;
    const rows = await this.database.db
      .select()
      .from(bizMemberCards)
      .where(
        and(
          inArray(bizMemberCards.customerId, ids),
          isNull(bizMemberCards.deletedAt),
        ),
      )
      .orderBy(desc(bizMemberCards.id));
    for (const row of rows) {
      const list = map.get(row.customerId) ?? [];
      list.push(row);
      map.set(row.customerId, list);
    }
    return map;
  }
}

/** `issueCard` 回填正式卡号前的占位号（UNIQUE，事务内随即被覆盖） */
function tempCardNo(): string {
  return `T${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
