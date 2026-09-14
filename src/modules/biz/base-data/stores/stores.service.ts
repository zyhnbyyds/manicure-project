import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { DatabaseService } from '../../../../database/database.service.js';
import { sysStores } from '../../../../database/schema/index.js';
import type { RequestActor } from '../../../../common/data-scope/data-scope.js';
import {
  listVisibleStores,
  type StoreBrief,
} from '../../../../common/data-scope/store-scope.js';
import { StorePort, type StoreRow } from '../../common/ports.js';
import { normalizeImages } from '../../common/gallery.js';
import { withoutUndefined } from '../../common/tx.js';
import type { BizTx } from '../../common/tx.js';

/**
 * 门店图集张数上限（小程序门店页展示）。
 *
 * 三处必须同源：这里、controller 的 zod `.max(5)`、前端表单的 `limit: 5`。
 */
export const MAX_STORE_IMAGES = 5;

export type CreateStoreInput = {
  code: string;
  name: string;
  nameEn?: string | null | undefined;
  phone?: string | null | undefined;
  address?: string | null | undefined;
  hours?: string | null | undefined;
  latitude?: number | null | undefined;
  longitude?: number | null | undefined;
  notice?: string | null | undefined;
  /** 门店图集（最多 5 张）；空数组 = 清空 → 存 `null` */
  images?: string[] | null | undefined;
  timezone?: string | null | undefined;
  status?: 'active' | 'disabled' | undefined;
  sort?: number | undefined;
  isDefault?: boolean | undefined;
  remark?: string | null | undefined;
};

export type UpdateStoreInput = {
  [K in keyof CreateStoreInput]?: CreateStoreInput[K] | undefined;
};

/**
 * 门店档案（连锁直营，阶段 0）。
 *
 * ## 单店期的三条规则
 *
 * 1. **必须有一条默认门店**：小程序 `GET /app/shop` 与（下一阶段）单据写入时的
 *    「当前门店」都靠它兜底。`findDefault()` 在没有任何标记时**回落到第一个启用门店**，
 *    连一条都没有才返回 null —— 让调用方少写一层判空；
 * 2. **默认门店唯一**：MySQL 没有部分唯一索引（`WHERE is_default = 1`），
 *    所以规则落在事务里（清旧 + 置新），与收货地址的默认地址同一套做法；
 * 3. **不允许删掉默认门店**：删了它就没有兜底了。先把默认切到别家再删。
 *
 * ## 与 `sys_config` 的 `biz.shop.*` 的关系
 *
 * 那些配置键是**单店遗留**：迁移把它们落成了一条默认门店。此后门店页读门店表，
 * 门店表里的空字段再由配置兜底（`AppCustomerDataService.shopProfile` 里合并）——
 * 这样老库（门店行字段还是 null）与跑过 seed 的新库表现一致。
 */
@Injectable()
export class StoresService extends StorePort {
  constructor(private readonly database: DatabaseService) {
    super();
  }

  /** 后台列表：含停用门店，按默认门店优先 + sort */
  async list(
    page: number,
    pageSize: number,
  ): Promise<{
    items: StoreRow[];
    page: number;
    pageSize: number;
  }> {
    const offset = (page - 1) * pageSize;
    const items = await this.database.db
      .select()
      .from(sysStores)
      .where(isNull(sysStores.deletedAt))
      .orderBy(
        desc(sysStores.isDefault),
        asc(sysStores.sort),
        asc(sysStores.id),
      )
      .limit(pageSize)
      .offset(offset);
    return { items, page, pageSize };
  }

  /**
   * 「我可见的门店」——后台顶栏**门店切换器**的数据源。
   *
   * 与 `list()`（门店档案管理，要 `system:store:list`、含停用门店）的区别：
   * 这里登录即可访问、只回**当前账号能用的启用门店**。店长也要在顶栏看到自己门店的名字，
   * 不该为了这个给他开「门店管理」权限。
   *
   * `activeStoreId` 是**复核过**的「当前门店」：请求头里的门店一旦被停用/删除或授权被收回，
   * 就归一回 `null`（= 全部门店视图），免得顶栏显示一家已不存在的店、列表却是空的。
   */
  async listMine(actor: RequestActor | null): Promise<{
    scope: 'all' | 'stores' | 'none';
    activeStoreId: number | null;
    stores: StoreBrief[];
  }> {
    const { scope, stores } = await listVisibleStores(this.database.db, actor);
    const requested = actor?.storeId ?? null;
    const activeStoreId =
      requested !== null && stores.some((item) => item.id === requested)
        ? requested
        : null;
    return { scope, activeStoreId, stores };
  }

  async listActive(): Promise<StoreRow[]> {
    return this.database.db
      .select()
      .from(sysStores)
      .where(and(eq(sysStores.status, 'active'), isNull(sysStores.deletedAt)))
      .orderBy(
        desc(sysStores.isDefault),
        asc(sysStores.sort),
        asc(sysStores.id),
      );
  }

  async findById(id: number): Promise<StoreRow | null> {
    const [row] = await this.database.db
      .select()
      .from(sysStores)
      .where(and(eq(sysStores.id, id), isNull(sysStores.deletedAt)))
      .limit(1);
    return row ?? null;
  }

  /**
   * 默认门店：优先 `is_default = 1`，没有就回落到第一个启用门店。
   *
   * 回落是刻意的：运营「忘了勾默认」不该让小程序门店页与下单直接失败 ——
   * 单店期更是如此（那时候连这个概念都不该被感知到）。
   */
  async findDefault(): Promise<StoreRow | null> {
    const [marked] = await this.database.db
      .select()
      .from(sysStores)
      .where(
        and(
          eq(sysStores.isDefault, true),
          eq(sysStores.status, 'active'),
          isNull(sysStores.deletedAt),
        ),
      )
      .orderBy(asc(sysStores.sort), asc(sysStores.id))
      .limit(1);
    if (marked) return marked;

    const [fallback] = await this.database.db
      .select()
      .from(sysStores)
      .where(and(eq(sysStores.status, 'active'), isNull(sysStores.deletedAt)))
      .orderBy(asc(sysStores.sort), asc(sysStores.id))
      .limit(1);
    return fallback ?? null;
  }

  async create(
    input: CreateStoreInput,
    actorId: number,
  ): Promise<{ id: number }> {
    await this.assertCodeAvailable(input.code);
    // 第一条门店**自动成为默认**：否则「没有默认门店」要靠调用方兜底，很容易漏
    const isFirst = (await this.countStores()) === 0;
    const shouldBeDefault = input.isDefault === true || isFirst;

    const id = await this.database.db.transaction(async (tx) => {
      if (shouldBeDefault) await this.clearDefault(tx);
      const inserted = await tx.insert(sysStores).values({
        ...withoutUndefined(input),
        // 图集归一化（空 → null、上限截断）：库里只留 `NULL` 或非空数组两种形态
        images: normalizeImages(input.images, MAX_STORE_IMAGES),
        isDefault: shouldBeDefault,
        createdBy: actorId,
        updatedBy: actorId,
      });
      return Number(inserted[0].insertId);
    });
    return { id };
  }

  async update(
    id: number,
    input: UpdateStoreInput,
    actorId: number,
  ): Promise<void> {
    await this.requireById(id);
    if (input.code !== undefined)
      await this.assertCodeAvailable(input.code, id);

    await this.database.db.transaction(async (tx) => {
      if (input.isDefault === true) await this.clearDefault(tx);
      await tx
        .update(sysStores)
        .set({
          ...withoutUndefined(input),
          // `images` 不传 = 「本次不改图集」（与其它字段同款）；传了才归一化后写
          ...(input.images === undefined
            ? {}
            : { images: normalizeImages(input.images, MAX_STORE_IMAGES) }),
          updatedBy: actorId,
        })
        .where(and(eq(sysStores.id, id), isNull(sysStores.deletedAt)));
    });

    // 「唯一一家门店被取消默认」是不可能状态：兜回来（与收货地址同款）
    if (input.isDefault === false) await this.ensureDefault();
  }

  /** 设为默认门店（单独入口，切换器/列表页一键切换） */
  async setDefault(id: number, actorId: number): Promise<void> {
    await this.requireById(id);
    await this.database.db.transaction(async (tx) => {
      await this.clearDefault(tx);
      await tx
        .update(sysStores)
        .set({ isDefault: true, updatedBy: actorId })
        .where(eq(sysStores.id, id));
    });
  }

  /** 软删门店；默认门店不允许删（删了就没有兜底了） */
  async remove(id: number, actorId: number): Promise<void> {
    const store = await this.requireById(id);
    if (store.isDefault)
      throw new ConflictException('默认门店不能删除，请先把默认门店切到别家');
    await this.database.db
      .update(sysStores)
      .set({ deletedAt: new Date(), updatedBy: actorId })
      .where(and(eq(sysStores.id, id), isNull(sysStores.deletedAt)));
  }

  /* ------------------------------ 内部工具 ------------------------------ */

  private async requireById(id: number): Promise<StoreRow> {
    const store = await this.findById(id);
    if (!store) throw new NotFoundException('门店不存在');
    return store;
  }

  private async countStores(): Promise<number> {
    const rows = await this.database.db
      .select({ id: sysStores.id })
      .from(sysStores)
      .where(isNull(sysStores.deletedAt));
    return rows.length;
  }

  /** 门店编码唯一（软删也占位：与用户名的既有口径一致，查重不过滤软删） */
  private async assertCodeAvailable(
    code: string,
    excludeId?: number,
  ): Promise<void> {
    const [row] = await this.database.db
      .select({ id: sysStores.id })
      .from(sysStores)
      .where(eq(sysStores.code, code))
      .limit(1);
    if (row && row.id !== excludeId)
      throw new BadRequestException(`门店编码「${code}」已被占用`);
  }

  private async clearDefault(tx: BizTx): Promise<void> {
    await tx
      .update(sysStores)
      .set({ isDefault: false })
      .where(eq(sysStores.isDefault, true));
  }

  /** 一个默认门店都没有时，把 sort 最靠前的启用门店顶上去 */
  private async ensureDefault(): Promise<void> {
    const current = await this.findDefault();
    if (current?.isDefault) return;
    const target = current;
    if (!target) return;
    await this.database.db
      .update(sysStores)
      .set({ isDefault: true })
      .where(eq(sysStores.id, target.id));
  }
}
