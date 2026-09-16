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
  desc,
  eq,
  getTableColumns,
  isNull,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm';
import { DatabaseService } from '../../../../database/database.service';
import {
  bizCustomers,
  bizMemberCardTypes,
  bizPointsGoods,
  bizPointsRedeems,
} from '../../../../database/schema/index';
import { BizConfigService } from '../../common/biz-config.service';
import { buildDocNo } from '../../common/doc-no';
import { quoteBooking } from '../../common/money';
import { ServiceItemPort } from '../../common/ports';
import {
  andConditions,
  keywordLike,
  parsePagination,
  readCount,
} from '../../common/query';
import { withoutUndefined } from '../../common/tx';
import type { BizDatabase } from '../../common/tx';
import { CardTypesService } from '../card-types/card-types.service';
import { MemberAccountsService } from '../member-accounts/member-accounts.service';
import { MemberCardsService } from '../member-cards/member-cards.service';

export type PointsGoodsRow = typeof bizPointsGoods.$inferSelect;
export type PointsRedeemRow = typeof bizPointsRedeems.$inferSelect;

export type PointsGoodsInput = {
  name: string;
  cardTypeId: number;
  points: number;
  /** -1 = 不限库存 */
  stock?: number | undefined;
  /** 0 = 不限每人兑换次数 */
  perLimit?: number | undefined;
  status?: 'active' | 'disabled' | undefined;
  sort?: number | undefined;
  remark?: string | null | undefined;
};

export type PointsGoodsListFilter = {
  status?: 'active' | 'disabled' | undefined;
  keyword?: string | undefined;
  /** 分类（自由文本，与 `biz_points_goods.category` 精确匹配） */
  category?: string | undefined;
};

export type RedeemListFilter = {
  customerId?: number | undefined;
  goodsId?: number | undefined;
  status?: 'success' | 'reverted' | undefined;
};

/** 更新入参：每个字段都显式带 `undefined`，便于直接透传 zod 结果 */
export type UpdatePointsGoodsInput = {
  name?: string | undefined;
  cardTypeId?: number | undefined;
  points?: number | undefined;
  stock?: number | undefined;
  perLimit?: number | undefined;
  status?: 'active' | 'disabled' | undefined;
  sort?: number | undefined;
  remark?: string | null | undefined;
};

/**
 * 积分兑换与抵扣试算（§15.3 / §9.10）。
 *
 * 兑换品直接指向**卡种**（换项目 = 发一张 1 次卡，不引入券体系）：
 * 同一事务内「扣积分（条件更新）→ 发卡（`skipLedger`，不写购卡流水）→ 写兑换记录」，
 * 任一步失败整体回滚。
 */
@Injectable()
export class PointsGoodsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: BizConfigService,
    private readonly accounts: MemberAccountsService,
    private readonly cards: MemberCardsService,
    private readonly cardTypes: CardTypesService,
    private readonly serviceItems: ServiceItemPort,
  ) {}

  async list(
    page: number,
    pageSize: number,
    filter: PointsGoodsListFilter = {},
  ): Promise<{
    items: (PointsGoodsRow & { cardTypeName: string | null })[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const {
      page: safePage,
      pageSize: safePageSize,
      offset,
    } = parsePagination(page, pageSize);
    const conditions = [isNull(bizPointsGoods.deletedAt)];
    if (filter.status)
      conditions.push(eq(bizPointsGoods.status, filter.status));
    if (filter.category)
      conditions.push(eq(bizPointsGoods.category, filter.category));
    const keyword = keywordLike(bizPointsGoods.name, filter.keyword);
    if (keyword) conditions.push(keyword);

    const where = andConditions(conditions);
    const [items, counted] = await Promise.all([
      this.database.db
        .select({
          ...getTableColumns(bizPointsGoods),
          cardTypeName: bizMemberCardTypes.name,
        })
        .from(bizPointsGoods)
        .leftJoin(
          bizMemberCardTypes,
          eq(bizPointsGoods.cardTypeId, bizMemberCardTypes.id),
        )
        .where(where)
        .orderBy(asc(bizPointsGoods.sort), asc(bizPointsGoods.id))
        .limit(safePageSize)
        .offset(offset),
      // count 带上同一个 leftJoin（select 里用到了 join 表的列）
      this.database.db
        .select({ value: count() })
        .from(bizPointsGoods)
        .leftJoin(
          bizMemberCardTypes,
          eq(bizPointsGoods.cardTypeId, bizMemberCardTypes.id),
        )
        .where(where),
    ]);
    return {
      items,
      total: readCount(counted),
      page: safePage,
      pageSize: safePageSize,
    };
  }

  /**
   * 兑换品的分类清单（去重）。
   *
   * 给 C 端的筛选胶囊用：**分类选项必须来自数据**，不能在前端硬编码一份清单 ——
   * 门店把「周边好物」改成「护手周边」时，硬编码的胶囊就会点出一片空列表。
   * 没设分类的商品不进清单（它们在 C 端归到「全部」里）。
   */
  async listCategories(): Promise<string[]> {
    const rows = await this.database.db
      .selectDistinct({ category: bizPointsGoods.category })
      .from(bizPointsGoods)
      .where(
        andConditions([
          isNull(bizPointsGoods.deletedAt),
          eq(bizPointsGoods.status, 'active'),
          sql`${bizPointsGoods.category} IS NOT NULL`,
          ne(bizPointsGoods.category, ''),
        ]),
      )
      .orderBy(asc(bizPointsGoods.category));
    return rows
      .map((row) => row.category)
      .filter((category): category is string => Boolean(category));
  }

  async findOne(
    id: number,
  ): Promise<PointsGoodsRow & { cardTypeName: string | null }> {
    const [row] = await this.database.db
      .select({
        ...getTableColumns(bizPointsGoods),
        cardTypeName: bizMemberCardTypes.name,
      })
      .from(bizPointsGoods)
      .leftJoin(
        bizMemberCardTypes,
        eq(bizPointsGoods.cardTypeId, bizMemberCardTypes.id),
      )
      .where(and(eq(bizPointsGoods.id, id), isNull(bizPointsGoods.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundException('积分兑换品不存在');
    return row;
  }

  async create(
    input: PointsGoodsInput,
    actorId: number,
  ): Promise<{ id: number }> {
    await this.assertNameUnique(input.name);
    await this.cardTypes.requireActiveCardType(
      this.database.db,
      input.cardTypeId,
    );
    const points = Math.trunc(input.points);
    const stock = Math.trunc(input.stock ?? -1);
    const perLimit = Math.trunc(input.perLimit ?? 0);
    assertPoints(points);
    assertStockAndLimit(stock, perLimit);

    const result = await this.database.db.insert(bizPointsGoods).values({
      ...withoutUndefined({
        name: input.name,
        cardTypeId: input.cardTypeId,
        points,
        stock,
        perLimit,
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
    input: UpdatePointsGoodsInput,
    actorId: number,
  ): Promise<void> {
    const current = await this.findOne(id);
    if (input.name !== undefined) await this.assertNameUnique(input.name, id);
    if (input.cardTypeId !== undefined)
      await this.cardTypes.requireActiveCardType(
        this.database.db,
        input.cardTypeId,
      );
    const points = Math.trunc(input.points ?? current.points);
    const stock = Math.trunc(input.stock ?? current.stock);
    const perLimit = Math.trunc(input.perLimit ?? current.perLimit);
    if (input.points !== undefined) assertPoints(points);
    if (input.stock !== undefined || input.perLimit !== undefined)
      assertStockAndLimit(stock, perLimit);

    const result = await this.database.db
      .update(bizPointsGoods)
      .set({
        ...withoutUndefined({
          name: input.name,
          cardTypeId: input.cardTypeId,
          points: input.points === undefined ? undefined : points,
          stock: input.stock === undefined ? undefined : stock,
          perLimit: input.perLimit === undefined ? undefined : perLimit,
          status: input.status,
          sort: input.sort === undefined ? undefined : Math.trunc(input.sort),
          remark: input.remark,
        }),
        updatedBy: actorId,
      })
      .where(and(eq(bizPointsGoods.id, id), isNull(bizPointsGoods.deletedAt)));
    if (!result[0].affectedRows)
      throw new NotFoundException('积分兑换品不存在');
  }

  async remove(id: number, actorId: number): Promise<void> {
    const result = await this.database.db
      .update(bizPointsGoods)
      .set({ deletedAt: new Date(), updatedBy: actorId })
      .where(and(eq(bizPointsGoods.id, id), isNull(bizPointsGoods.deletedAt)));
    if (!result[0].affectedRows)
      throw new NotFoundException('积分兑换品不存在');
  }

  /**
   * 抵扣试算（§9.10）：服务端按 §5.7 复算，返回本单最多可用积分与最大抵扣金额。
   * 只读，不改数据。
   */
  async preview(
    customerId: number,
    serviceItemIds: number[],
  ): Promise<{
    customerId: number;
    points: number;
    originalPrice: number;
    levelDiscountPermille: number;
    levelDiscountAmount: number;
    maxPoints: number;
    maxDiscountAmount: number;
    capPoints: number;
    capDiscountAmount: number;
    pointsDiscountPerYuan: number;
    maxPointsPermille: number;
    payableAmount: number;
  }> {
    const context = await this.accounts.getPricingContext(customerId);
    const items = await this.serviceItems.requireActiveItems(serviceItemIds);
    const { pointsDiscountPerYuan, maxPointsPermille } =
      await this.config.member();
    const quote = quoteBooking({
      items: items.map((item) => ({
        serviceItemId: item.id,
        name: item.name,
        durationMinutes: item.durationMinutes,
        bufferMinutes: item.bufferMinutes,
        price: item.price,
      })),
      levelDiscountPermille: context.levelDiscountPermille,
      pointsUsed: context.points,
      pointsDiscountPerYuan,
      maxPointsPermille,
    });
    return {
      customerId,
      points: context.points,
      originalPrice: quote.originalPrice,
      levelDiscountPermille: quote.levelDiscountPermille,
      levelDiscountAmount: quote.levelDiscountAmount,
      // 实际可用 = min(顾客积分, 比例上限)
      maxPoints: quote.pointsUsed,
      maxDiscountAmount: quote.pointsDiscountAmount,
      // 上限本身（前端提示「本单最多可抵」）
      capPoints: quote.maxPoints,
      capDiscountAmount: quote.maxPointsDiscountAmount,
      pointsDiscountPerYuan,
      maxPointsPermille,
      payableAmount: quote.payableAmount,
    };
  }

  /** 兑换（§15.3）：同事务扣积分 + 发卡 + 写兑换记录与 `points_redeem` 流水 */
  async redeem(
    customerId: number,
    goodsId: number,
    actorId: number,
  ): Promise<{
    redeemId: number;
    redeemNo: string;
    transactionId: number;
    cardId: number;
    cardNo: string;
    points: number;
  }> {
    const goods = await this.requireActiveGoods(this.database.db, goodsId);
    const { timezone } = await this.config.booking();
    return this.database.db.transaction(async (tx) => {
      // 1) 库存：条件更新当闸门（-1 = 不限，保持 -1 不递减）
      const stockResult = await tx
        .update(bizPointsGoods)
        .set({
          stock: sql`IF(${bizPointsGoods.stock} = -1, -1, ${bizPointsGoods.stock} - 1)`,
        })
        .where(
          and(
            eq(bizPointsGoods.id, goodsId),
            isNull(bizPointsGoods.deletedAt),
            eq(bizPointsGoods.status, 'active'),
            sql`(${bizPointsGoods.stock} = -1 OR ${bizPointsGoods.stock} > 0)`,
          ),
        );
      if (!stockResult[0].affectedRows)
        throw new ConflictException('积分兑换品已下架或已兑完');

      // 2) 每人限兑（按历史成功兑换次数）
      if (goods.perLimit > 0) {
        const [row] = await tx
          .select({ total: count() })
          .from(bizPointsRedeems)
          .where(
            and(
              eq(bizPointsRedeems.customerId, customerId),
              eq(bizPointsRedeems.goodsId, goodsId),
              eq(bizPointsRedeems.status, 'success'),
            ),
          );
        if (Number(row?.total ?? 0) >= goods.perLimit)
          throw new ConflictException('已达每人限兑次数');
      }

      // 3) 扣积分（条件更新，不足 409）
      const { transactionId } = await this.accounts.deductPoints(tx, {
        customerId,
        points: goods.points,
        type: 'points_redeem',
        remark: `积分兑换：${goods.name}`,
        actorId,
      });

      // 4) 发卡：兑换发的卡与售出的卡同构，但 price=0 且不写购卡流水
      const card = await this.cards.issueCard(tx, {
        customerId,
        cardTypeId: goods.cardTypeId,
        payChannel: 'cash',
        price: 0,
        skipLedger: true,
        remark: `积分兑换：${goods.name}`,
        actorId,
      });

      // 5) 兑换记录（只追加；redeem_no 主键回填）
      const inserted = await tx.insert(bizPointsRedeems).values({
        redeemNo: tempRedeemNo(),
        customerId,
        goodsId,
        points: goods.points,
        memberCardId: card.id,
        status: 'success',
        remark: `积分兑换：${goods.name}`,
        createdBy: actorId,
      });
      const redeemId = Number(inserted[0].insertId);
      const redeemNo = buildDocNo('X', redeemId, timezone);
      await tx
        .update(bizPointsRedeems)
        .set({ redeemNo })
        .where(eq(bizPointsRedeems.id, redeemId));

      return {
        redeemId,
        redeemNo,
        transactionId,
        cardId: card.id,
        cardNo: card.cardNo,
        points: goods.points,
      };
    });
  }

  async listRedeems(
    page: number,
    pageSize: number,
    filter: RedeemListFilter = {},
  ): Promise<{
    items: (PointsRedeemRow & {
      customerName: string | null;
      customerPhone: string | null;
      goodsName: string | null;
    })[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const {
      page: safePage,
      pageSize: safePageSize,
      offset,
    } = parsePagination(page, pageSize);
    const conditions: SQL[] = [];
    if (filter.customerId !== undefined)
      conditions.push(eq(bizPointsRedeems.customerId, filter.customerId));
    if (filter.goodsId !== undefined)
      conditions.push(eq(bizPointsRedeems.goodsId, filter.goodsId));
    if (filter.status)
      conditions.push(eq(bizPointsRedeems.status, filter.status));

    const where = andConditions(conditions);
    const [items, counted] = await Promise.all([
      this.database.db
        .select({
          ...getTableColumns(bizPointsRedeems),
          customerName: bizCustomers.name,
          customerPhone: bizCustomers.phone,
          goodsName: bizPointsGoods.name,
        })
        .from(bizPointsRedeems)
        .leftJoin(
          bizCustomers,
          eq(bizPointsRedeems.customerId, bizCustomers.id),
        )
        .leftJoin(
          bizPointsGoods,
          eq(bizPointsRedeems.goodsId, bizPointsGoods.id),
        )
        .where(where)
        .orderBy(desc(bizPointsRedeems.id))
        .limit(safePageSize)
        .offset(offset),
      // count 带上同一组 leftJoin
      this.database.db
        .select({ value: count() })
        .from(bizPointsRedeems)
        .leftJoin(
          bizCustomers,
          eq(bizPointsRedeems.customerId, bizCustomers.id),
        )
        .leftJoin(
          bizPointsGoods,
          eq(bizPointsRedeems.goodsId, bizPointsGoods.id),
        )
        .where(where),
    ]);
    return {
      items,
      total: readCount(counted),
      page: safePage,
      pageSize: safePageSize,
    };
  }

  /** 撤销兑换（§15.3）：回补积分 + 废卡 + 置 `reverted` + 回补库存；必填原因 */
  async revertRedeem(
    redeemId: number,
    reason: string,
    actorId: number,
  ): Promise<{ redeemId: number; points: number; cardId: number | null }> {
    if (!reason?.trim()) throw new BadRequestException('撤销兑换必须填写原因');
    return this.database.db.transaction(async (tx) => {
      const [redeem] = await tx
        .select()
        .from(bizPointsRedeems)
        .where(eq(bizPointsRedeems.id, redeemId))
        .limit(1);
      if (!redeem) throw new NotFoundException('兑换记录不存在');
      if (redeem.status === 'reverted')
        throw new ConflictException('该兑换已撤销');

      const result = await tx
        .update(bizPointsRedeems)
        .set({
          status: 'reverted',
          remark: `${redeem.remark ?? ''}｜撤销原因：${reason.trim()}`.slice(
            0,
            200,
          ),
        })
        .where(
          and(
            eq(bizPointsRedeems.id, redeemId),
            eq(bizPointsRedeems.status, 'success'),
          ),
        );
      if (!result[0].affectedRows) throw new ConflictException('该兑换已撤销');

      // 回补积分（条件更新增）
      await this.accounts.creditPoints(tx, {
        customerId: redeem.customerId,
        points: redeem.points,
        remark: `撤销兑换回补积分：${reason.trim()}`,
        actorId,
      });

      // 废卡（status='refunded'）
      if (redeem.memberCardId !== null)
        await this.cards.voidCard(
          tx,
          redeem.memberCardId,
          `撤销兑换：${reason.trim()}`,
          actorId,
        );

      // 回补库存（不限库存保持 -1）
      await tx
        .update(bizPointsGoods)
        .set({
          stock: sql`IF(${bizPointsGoods.stock} = -1, -1, ${bizPointsGoods.stock} + 1)`,
        })
        .where(eq(bizPointsGoods.id, redeem.goodsId));

      return {
        redeemId,
        points: redeem.points,
        cardId: redeem.memberCardId,
      };
    });
  }

  private async requireActiveGoods(
    executor: BizDatabase,
    id: number,
  ): Promise<PointsGoodsRow> {
    const [goods] = await executor
      .select()
      .from(bizPointsGoods)
      .where(and(eq(bizPointsGoods.id, id), isNull(bizPointsGoods.deletedAt)))
      .limit(1);
    if (!goods) throw new NotFoundException('积分兑换品不存在');
    if (goods.status !== 'active')
      throw new ConflictException('积分兑换品已下架');
    return goods;
  }

  private async assertNameUnique(
    name: string,
    excludeId?: number,
  ): Promise<void> {
    const conditions = [eq(bizPointsGoods.name, name)];
    if (excludeId !== undefined)
      conditions.push(ne(bizPointsGoods.id, excludeId));
    const [duplicate] = await this.database.db
      .select({ id: bizPointsGoods.id })
      .from(bizPointsGoods)
      .where(and(...conditions))
      .limit(1);
    if (duplicate) throw new ConflictException('兑换品名称已存在');
  }
}

function assertPoints(points: number): void {
  if (!Number.isInteger(points) || points <= 0)
    throw new BadRequestException('所需积分必须是大于 0 的整数');
}

function assertStockAndLimit(stock: number, perLimit: number): void {
  if (!Number.isInteger(stock) || stock < -1)
    throw new BadRequestException('库存必须是 -1（不限）或非负整数');
  if (!Number.isInteger(perLimit) || perLimit < 0)
    throw new BadRequestException('每人限兑必须是 0（不限）或正整数');
}

/** `redeem_no` 回填前的占位号（UNIQUE，事务内随即被覆盖） */
function tempRedeemNo(): string {
  return `TX${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
