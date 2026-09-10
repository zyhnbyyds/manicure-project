import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { DatabaseService } from '../../../../database/database.service';
import {
  bizMemberCardTypes,
  bizMemberCardTypeItems,
  bizServiceItems,
} from '../../../../database/schema/index.js';
import { withoutUndefined } from '../../common/tx.js';
import type { BizDatabase } from '../../common/tx.js';

export type CardTypeRow = typeof bizMemberCardTypes.$inferSelect;
export type CardTypeItemRow = typeof bizMemberCardTypeItems.$inferSelect;

export type ApplicableItem = {
  serviceItemId: number;
  name: string;
  price: number;
  status: 'active' | 'disabled';
};

export type CardTypeInput = {
  name: string;
  price: number;
  totalTimes: number;
  validDays?: number | undefined;
  status?: 'active' | 'disabled' | undefined;
  sort?: number | undefined;
  remark?: string | null | undefined;
  /** 适用项目（1..N，整体替换；物理删随卡种走，§4.4） */
  serviceItemIds?: number[] | undefined;
};

export type CardTypeListFilter = {
  status?: 'active' | 'disabled' | undefined;
};

/**
 * 次卡卡种（§15.5）。
 *
 * 卡种适用项目是 1..N 的子表（`biz_member_card_type_item`），保存时**整体替换**（物理删）；
 * 已发出的卡不受卡种后续修改影响（`biz_member_card` 上已快照 `card_name` / `total_times` / `price`）。
 */
@Injectable()
export class CardTypesService {
  constructor(private readonly database: DatabaseService) {}

  async list(
    page: number,
    pageSize: number,
    filter: CardTypeListFilter = {},
  ): Promise<{
    items: (CardTypeRow & { applicableItems: ApplicableItem[] })[];
    page: number;
    pageSize: number;
  }> {
    const conditions = [isNull(bizMemberCardTypes.deletedAt)];
    if (filter.status)
      conditions.push(eq(bizMemberCardTypes.status, filter.status));
    const rows = await this.database.db
      .select()
      .from(bizMemberCardTypes)
      .where(and(...conditions))
      .orderBy(asc(bizMemberCardTypes.sort), asc(bizMemberCardTypes.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const itemMap = await this.applicableItemsOfMany(rows.map((row) => row.id));
    const items = rows.map((row) => ({
      ...row,
      applicableItems: itemMap.get(row.id) ?? [],
    }));
    return { items, page, pageSize };
  }

  async findOne(
    id: number,
  ): Promise<CardTypeRow & { applicableItems: ApplicableItem[] }> {
    const cardType = await this.requireCardType(this.database.db, id);
    return {
      ...cardType,
      applicableItems: await this.applicableItems(this.database.db, id),
    };
  }

  /** 卡种必须存在（发卡 / 兑换 / 编辑共用） */
  async requireCardType(
    executor: BizDatabase,
    id: number,
  ): Promise<CardTypeRow> {
    const [cardType] = await executor
      .select()
      .from(bizMemberCardTypes)
      .where(
        and(eq(bizMemberCardTypes.id, id), isNull(bizMemberCardTypes.deletedAt)),
      )
      .limit(1);
    if (!cardType) throw new NotFoundException('卡种不存在');
    return cardType;
  }

  /** 发卡/兑换用：卡种必须启用 */
  async requireActiveCardType(
    executor: BizDatabase,
    id: number,
  ): Promise<CardTypeRow> {
    const cardType = await this.requireCardType(executor, id);
    if (cardType.status !== 'active')
      throw new ConflictException('卡种已停用，不能发卡');
    return cardType;
  }

  /** 卡种适用项目 id（核销时校验「项目在卡种适用集合内」） */
  async applicableServiceItemIds(
    executor: BizDatabase,
    cardTypeId: number,
  ): Promise<number[]> {
    const rows = await executor
      .select({ serviceItemId: bizMemberCardTypeItems.serviceItemId })
      .from(bizMemberCardTypeItems)
      .where(eq(bizMemberCardTypeItems.cardTypeId, cardTypeId))
      .orderBy(asc(bizMemberCardTypeItems.sort), asc(bizMemberCardTypeItems.id));
    return rows.map((row) => row.serviceItemId);
  }

  /** 卡种适用项目（含项目名与价格，列表 / 详情展示用） */
  async applicableItems(
    executor: BizDatabase,
    cardTypeId: number,
  ): Promise<ApplicableItem[]> {
    const rows = await executor
      .select({
        serviceItemId: bizMemberCardTypeItems.serviceItemId,
        name: bizServiceItems.name,
        price: bizServiceItems.price,
        status: bizServiceItems.status,
        deletedAt: bizServiceItems.deletedAt,
      })
      .from(bizMemberCardTypeItems)
      .leftJoin(
        bizServiceItems,
        eq(bizMemberCardTypeItems.serviceItemId, bizServiceItems.id),
      )
      .where(eq(bizMemberCardTypeItems.cardTypeId, cardTypeId))
      .orderBy(asc(bizMemberCardTypeItems.sort), asc(bizMemberCardTypeItems.id));
    return rows.map((row) => ({
      serviceItemId: row.serviceItemId,
      name: row.name ?? '（项目已删除）',
      price: row.price ?? 0,
      status: row.status ?? 'disabled',
    }));
  }

  async create(input: CardTypeInput, actorId: number): Promise<{ id: number }> {
    await this.assertNameUnique(input.name);
    const serviceItemIds = await this.normalizeServiceItemIds(
      input.serviceItemIds,
    );
    const price = Math.trunc(input.price);
    const totalTimes = Math.trunc(input.totalTimes);
    const validDays = Math.trunc(input.validDays ?? 0);

    const result = await this.database.db.insert(bizMemberCardTypes).values({
      ...withoutUndefined({
        name: input.name,
        price,
        totalTimes,
        validDays,
        status: input.status,
        sort: input.sort === undefined ? undefined : Math.trunc(input.sort),
        remark: input.remark,
      }),
      createdBy: actorId,
      updatedBy: actorId,
    });
    const id = Number(result[0].insertId);
    await this.replaceItems(this.database.db, id, serviceItemIds);
    return { id };
  }

  async update(
    id: number,
    input: Partial<CardTypeInput>,
    actorId: number,
  ): Promise<void> {
    const current = await this.requireCardType(this.database.db, id);
    if (input.name !== undefined) await this.assertNameUnique(input.name, id);

    const price = Math.trunc(input.price ?? current.price);
    const totalTimes = Math.trunc(input.totalTimes ?? current.totalTimes);
    const validDays = Math.trunc(input.validDays ?? current.validDays);
    if (price < 0) throw new BadRequestException('卡价不能为负');
    if (totalTimes < 1) throw new BadRequestException('总次数必须大于 0');
    if (validDays < 0) throw new BadRequestException('有效期天数不能为负');

    await this.database.db.transaction(async (tx) => {
      await tx
        .update(bizMemberCardTypes)
        .set({
          ...withoutUndefined({
            name: input.name,
            price,
            totalTimes,
            validDays,
            status: input.status,
            sort: input.sort === undefined ? undefined : Math.trunc(input.sort),
            remark: input.remark,
          }),
          updatedBy: actorId,
        })
        .where(
          and(
            eq(bizMemberCardTypes.id, id),
            isNull(bizMemberCardTypes.deletedAt),
          ),
        );
      if (input.serviceItemIds !== undefined) {
        const serviceItemIds = await this.normalizeServiceItemIds(
          input.serviceItemIds,
        );
        await this.replaceItems(tx, id, serviceItemIds);
      }
    });
  }

  /** 软删；已发出的卡不受影响（§9.6） */
  async remove(id: number, actorId: number): Promise<void> {
    await this.requireCardType(this.database.db, id);
    const result = await this.database.db
      .update(bizMemberCardTypes)
      .set({ deletedAt: new Date(), updatedBy: actorId })
      .where(
        and(eq(bizMemberCardTypes.id, id), isNull(bizMemberCardTypes.deletedAt)),
      );
    if (!result[0].affectedRows) throw new NotFoundException('卡种不存在');
  }

  /** 适用项目整体替换：先物理删后插（§4.4 软删豁免） */
  private async replaceItems(
    executor: BizDatabase,
    cardTypeId: number,
    serviceItemIds: number[],
  ): Promise<void> {
    await executor
      .delete(bizMemberCardTypeItems)
      .where(eq(bizMemberCardTypeItems.cardTypeId, cardTypeId));
    if (!serviceItemIds.length) return;
    await executor.insert(bizMemberCardTypeItems).values(
      serviceItemIds.map((serviceItemId, index) => ({
        cardTypeId,
        serviceItemId,
        sort: index,
      })),
    );
  }

  /** 1..N 个去重后的启用项目；缺失 / 停用直接 400 */
  private async normalizeServiceItemIds(
    raw: number[] | undefined,
  ): Promise<number[]> {
    const ids = [...new Set((raw ?? []).map((id) => Math.trunc(id)))].filter(
      (id) => Number.isInteger(id) && id > 0,
    );
    if (!ids.length) throw new BadRequestException('卡种必须至少配置一个适用项目');
    const rows = await this.database.db
      .select({
        id: bizServiceItems.id,
        name: bizServiceItems.name,
        status: bizServiceItems.status,
        deletedAt: bizServiceItems.deletedAt,
      })
      .from(bizServiceItems)
      .where(inArray(bizServiceItems.id, ids));
    const usable = new Set(
      rows
        .filter((row) => row.deletedAt === null && row.status === 'active')
        .map((row) => row.id),
    );
    const missing = ids.filter((id) => !usable.has(id));
    if (missing.length)
      throw new BadRequestException(
        `适用项目不存在或已停用：${missing.join(', ')}`,
      );
    return ids;
  }

  private async applicableItemsOfMany(
    cardTypeIds: number[],
  ): Promise<Map<number, ApplicableItem[]>> {
    const map = new Map<number, ApplicableItem[]>();
    if (!cardTypeIds.length) return map;
    const rows = await this.database.db
      .select({
        cardTypeId: bizMemberCardTypeItems.cardTypeId,
        serviceItemId: bizMemberCardTypeItems.serviceItemId,
        name: bizServiceItems.name,
        price: bizServiceItems.price,
        status: bizServiceItems.status,
      })
      .from(bizMemberCardTypeItems)
      .leftJoin(
        bizServiceItems,
        eq(bizMemberCardTypeItems.serviceItemId, bizServiceItems.id),
      )
      .where(inArray(bizMemberCardTypeItems.cardTypeId, cardTypeIds))
      .orderBy(asc(bizMemberCardTypeItems.sort), asc(bizMemberCardTypeItems.id));
    for (const row of rows) {
      const list = map.get(row.cardTypeId) ?? [];
      list.push({
        serviceItemId: row.serviceItemId,
        name: row.name ?? '（项目已删除）',
        price: row.price ?? 0,
        status: row.status ?? 'disabled',
      });
      map.set(row.cardTypeId, list);
    }
    return map;
  }

  private async assertNameUnique(
    name: string,
    excludeId?: number,
  ): Promise<void> {
    const conditions = [eq(bizMemberCardTypes.name, name)];
    if (excludeId !== undefined)
      conditions.push(ne(bizMemberCardTypes.id, excludeId));
    const [duplicate] = await this.database.db
      .select({ id: bizMemberCardTypes.id })
      .from(bizMemberCardTypes)
      .where(and(...conditions))
      .limit(1);
    if (duplicate) throw new ConflictException('卡种名称已存在');
  }
}
