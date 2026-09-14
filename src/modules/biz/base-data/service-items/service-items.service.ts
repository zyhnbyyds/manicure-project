import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm';
import { DatabaseService } from '../../../../database/database.service.js';
import {
  bizBookingItems,
  bizBookings,
  bizServiceItems,
} from '../../../../database/schema/index.js';
import {
  ServiceItemPort,
  type PageResult,
  type ServiceItemRow,
} from '../../common/ports.js';
import { keywordLike } from '../../common/query.js';
import { normalizeImages } from '../../common/gallery.js';
import { withoutUndefined, type BizTx } from '../../common/tx.js';

/** 未完成预约（§6.4）：这些状态下的预约会阻止主数据被停用 / 删除 */
const UNFINISHED_BOOKING_STATUSES = [
  'pending',
  'confirmed',
  'arrived',
] as const;

/** 单次预约可选项目数上限（§2.9 `requireActiveItems`） */
const MAX_BOOKING_ITEMS = 3;

/** 删除保护提示里最多列出的单号数 */
const SAMPLE_BOOKING_LIMIT = 3;

export type CreateServiceItemInput = {
  name: string;
  category?: string | null | undefined;
  durationMinutes: number;
  bufferMinutes?: number | undefined;
  price?: number | undefined;
  description?: string | null | undefined;
  /** 图集：顺序即展示顺序；封面 `image` 由服务端取首图派生，不接受调用方单独指定 */
  images?: string[] | null | undefined;
  status?: 'active' | 'disabled' | undefined;
  sort?: number | undefined;
  remark?: string | null | undefined;
};

export type UpdateServiceItemInput = {
  [K in keyof CreateServiceItemInput]?: CreateServiceItemInput[K] | undefined;
};

export type ServiceItemListFilter = {
  keyword?: string;
  status?: 'active' | 'disabled';
};

/**
 * 服务项目（§4.3 / §9.1）。
 *
 * - 停用 / 删除前必须检查是否被**未完成预约**引用（§6.4），已完成单不受影响（快照已落库）；
 * - 金额单位「分」，时长 / 缓冲参与可约时段计算，改项目不影响历史单据；
 * - 图片是「图集 + 封面」两个字段：`images` 是唯一事实来源，`image` 恒等于 `images[0] ?? null`，
 *   由下面的 `imagesPatch` 统一回写，调用方无法单独写封面（防止两个字段各写各的）。
 */
@Injectable()
export class ServiceItemsService extends ServiceItemPort {
  constructor(private readonly database: DatabaseService) {
    super();
  }

  async list(
    page: number,
    pageSize: number,
    filter: ServiceItemListFilter,
  ): Promise<PageResult<ServiceItemRow>> {
    const conditions = [isNull(bizServiceItems.deletedAt)];
    const keyword = keywordLike(bizServiceItems.name, filter.keyword);
    if (keyword) conditions.push(keyword);
    if (filter.status)
      conditions.push(eq(bizServiceItems.status, filter.status));
    const items = await this.database.db
      .select()
      .from(bizServiceItems)
      .where(and(...conditions))
      .orderBy(asc(bizServiceItems.sort), asc(bizServiceItems.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return { items, page, pageSize };
  }

  async findOne(id: number): Promise<ServiceItemRow> {
    const [item] = await this.database.db
      .select()
      .from(bizServiceItems)
      .where(and(eq(bizServiceItems.id, id), isNull(bizServiceItems.deletedAt)))
      .limit(1);
    if (!item) throw new NotFoundException('服务项目不存在');
    return item;
  }

  async create(
    input: CreateServiceItemInput,
    actorId: number,
  ): Promise<{ id: number }> {
    const { images, ...rest } = input;
    const result = await this.database.db.insert(bizServiceItems).values({
      ...withoutUndefined(rest),
      ...imagesPatch(images),
      createdBy: actorId,
      updatedBy: actorId,
    });
    return { id: Number(result[0].insertId) };
  }

  async update(
    id: number,
    input: UpdateServiceItemInput,
    actorId: number,
  ): Promise<void> {
    const current = await this.findOne(id);
    // 停用 = 变相下架，同样不能让既有未完成预约失去项目（§6.4）
    if (input.status === 'disabled' && current.status !== 'disabled')
      await this.assertNoUnfinishedBookings(current, '停用');
    const { images, ...rest } = input;
    const result = await this.database.db
      .update(bizServiceItems)
      .set({
        ...withoutUndefined(rest),
        ...imagesPatch(images),
        updatedBy: actorId,
      })
      .where(
        and(eq(bizServiceItems.id, id), isNull(bizServiceItems.deletedAt)),
      );
    if (!result[0].affectedRows) throw new NotFoundException('服务项目不存在');
  }

  async remove(id: number, actorId: number): Promise<void> {
    const item = await this.findOne(id);
    await this.assertNoUnfinishedBookings(item, '删除');
    const result = await this.database.db
      .update(bizServiceItems)
      .set({ deletedAt: new Date(), updatedBy: actorId })
      .where(
        and(eq(bizServiceItems.id, id), isNull(bizServiceItems.deletedAt)),
      );
    if (!result[0].affectedRows) throw new NotFoundException('服务项目不存在');
  }

  /** 去重后 1..3 个；缺失 / 停用抛 BadRequest（§9.5 第 2 步） */
  async requireActiveItems(
    ids: number[],
    tx?: BizTx,
  ): Promise<ServiceItemRow[]> {
    const executor = tx ?? this.database.db;
    const unique = [
      ...new Set(ids.filter((id) => Number.isInteger(id) && id > 0)),
    ];
    if (!unique.length) throw new BadRequestException('至少选择 1 个服务项目');
    if (unique.length > MAX_BOOKING_ITEMS)
      throw new BadRequestException(
        `单次最多选择 ${MAX_BOOKING_ITEMS} 个服务项目`,
      );
    const rows = await executor
      .select()
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
    const ordered = unique.map((id) => found.get(id) as ServiceItemRow);
    const disabled = ordered.filter((row) => row.status !== 'active');
    if (disabled.length)
      throw new BadRequestException(
        `服务项目已停用：${disabled.map((row) => row.name).join('、')}`,
      );
    return ordered;
  }

  async listActive(): Promise<ServiceItemRow[]> {
    return this.database.db
      .select()
      .from(bizServiceItems)
      .where(
        and(
          eq(bizServiceItems.status, 'active'),
          isNull(bizServiceItems.deletedAt),
        ),
      )
      .orderBy(asc(bizServiceItems.sort), asc(bizServiceItems.id));
  }

  /** 是否存在引用该项目的未完成预约（§6.4） */
  private async assertNoUnfinishedBookings(
    item: ServiceItemRow,
    action: string,
  ): Promise<void> {
    const conditions = and(
      eq(bizBookingItems.serviceItemId, item.id),
      inArray(bizBookings.status, [...UNFINISHED_BOOKING_STATUSES]),
      isNull(bizBookings.deletedAt),
    );
    const [row] = await this.database.db
      .select({ value: count() })
      .from(bizBookingItems)
      .innerJoin(bizBookings, eq(bizBookingItems.bookingId, bizBookings.id))
      .where(conditions);
    const total = Number(row?.value ?? 0);
    if (!total) return;
    const samples = await this.database.db
      .select({ bookingNo: bizBookings.bookingNo })
      .from(bizBookingItems)
      .innerJoin(bizBookings, eq(bizBookingItems.bookingId, bizBookings.id))
      .where(conditions)
      .limit(SAMPLE_BOOKING_LIMIT);
    const nos = samples.map((sample) => sample.bookingNo).join('、');
    throw new ConflictException(
      `服务项目「${item.name}」被 ${total} 条未完成预约引用（${nos}），不能${action}；请先处理这些预约`,
    );
  }
}

/**
 * 图集 → 写入补丁。
 *
 * `images === undefined` 表示「本次不改图集」，返回空补丁，让 `update` 保持原值；
 * 否则连同派生封面 `image = images[0] ?? null` 一起写，两者永远同进同退。
 * （归一化规则见 `common/gallery.ts`：上限 9 张。）
 */
export function imagesPatch(images: string[] | null | undefined): {
  images?: string[] | null;
  image?: string | null;
} {
  if (images === undefined) return {};
  const normalized = normalizeImages(images);
  return { images: normalized, image: normalized?.[0] ?? null };
}
