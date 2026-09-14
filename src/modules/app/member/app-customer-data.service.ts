import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { DatabaseService } from '../../../database/database.service.js';
import {
  appWxUsers,
  bizCustomerAddresses,
  bizCustomerFavorites,
  bizFeedbacks,
  bizServiceItems,
} from '../../../database/schema/index.js';
import { APP_ACTOR_ID } from '../app-actor.js';
import { BizConfigService } from '../../biz/common/biz-config.service.js';
import { NoticePort, StorePort } from '../../biz/common/ports.js';
import type {
  AppAddressListVo,
  AppAddressUpsertRequest,
  AppAddressVo,
  AppCreateFeedbackRequest,
  AppCreateFeedbackVo,
  AppFavoriteListVo,
  AppFavoriteToggleVo,
  AppNoticeListVo,
  AppNoticeReadVo,
  AppShopVo,
} from '../dto/app-vo.js';

/** 每个顾客最多保存多少个收货地址（防刷，也防「默认地址」被淹没） */
const MAX_ADDRESSES = 10;

/**
 * 顾客自助数据：收货地址（batch4 设计稿「收货地址」页）。
 *
 * ## 为什么单独一个 service
 *
 * `AppMemberService` 已经 700 行，而这里是另一类东西：**顾客自己维护的从属数据**，
 * 不属于「会员资产」（余额 / 积分 / 次卡都不在这条链路上）。
 *
 * ## 三条硬规则
 *
 * 1. **归属只认 token**：所有查询/写入都带 `customer_id = 当前绑定顾客`，
 *    接口入参里没有 customerId，改不到别人的地址；
 * 2. **不属于自己的 id 一律 404**（不是 403）—— 403 等于告诉对方「这个 id 存在」；
 * 3. **默认地址唯一**：同顾客最多一个 `is_default = 1`，换默认与删默认都要在同一事务里
 *    把旧的清掉 / 补上新的，否则会出现「一个都没有」或「两个都是」。
 */
@Injectable()
export class AppCustomerDataService {
  constructor(
    private readonly database: DatabaseService,
    /** 站内消息走 biz 侧同一套收件箱实现（不强求 app 域自己写一份查询） */
    private readonly notices: NoticePort,
    /** 门店档案：门店表优先，遗留的单店配置 `biz.shop.*` 兜底 */
    private readonly bizConfig: BizConfigService,
    /** 门店实体（阶段 0 起门店是实体，不再是散落的配置键） */
    private readonly stores: StorePort,
  ) {}

  /** 取当前身份绑定的顾客 ID（唯一归属来源，与 `AppMemberService` 同一口径） */
  private async requireCustomerId(appUserId: number): Promise<number> {
    const [identity] = await this.database.db
      .select({ customerId: appWxUsers.customerId })
      .from(appWxUsers)
      .where(and(eq(appWxUsers.id, appUserId), isNull(appWxUsers.deletedAt)))
      .limit(1);
    if (!identity) throw new NotFoundException('小程序身份不存在，请重新登录');
    if (identity.customerId === null) {
      throw new BadRequestException({
        message: '请先绑定手机号',
        needBind: true,
      });
    }
    return identity.customerId;
  }

  /** 我的地址列表：默认地址排最前，其余按新增时间倒序 */
  async listAddresses(appUserId: number): Promise<AppAddressListVo> {
    const customerId = await this.requireCustomerId(appUserId);
    const rows = await this.database.db
      .select({
        id: bizCustomerAddresses.id,
        contactName: bizCustomerAddresses.contactName,
        contactPhone: bizCustomerAddresses.contactPhone,
        province: bizCustomerAddresses.province,
        city: bizCustomerAddresses.city,
        district: bizCustomerAddresses.district,
        detail: bizCustomerAddresses.detail,
        isDefault: bizCustomerAddresses.isDefault,
      })
      .from(bizCustomerAddresses)
      .where(
        and(
          eq(bizCustomerAddresses.customerId, customerId),
          isNull(bizCustomerAddresses.deletedAt),
        ),
      )
      .orderBy(
        desc(bizCustomerAddresses.isDefault),
        desc(bizCustomerAddresses.id),
      );
    return { items: rows };
  }

  /** 新增地址；`isDefault` 或「这是第一个地址」时设为默认 */
  async createAddress(
    appUserId: number,
    input: AppAddressUpsertRequest,
  ): Promise<AppAddressVo> {
    const customerId = await this.requireCustomerId(appUserId);
    const count = await this.countAddresses(customerId);
    if (count >= MAX_ADDRESSES) {
      throw new BadRequestException(`最多保存 ${MAX_ADDRESSES} 个收货地址`);
    }
    // 第一个地址必须是默认：否则下单时「没有默认地址」要靠前端兜底，很容易漏
    const shouldBeDefault = input.isDefault === true || count === 0;

    const id = await this.database.db.transaction(async (tx) => {
      if (shouldBeDefault) await this.clearDefault(tx, customerId);
      const inserted = await tx.insert(bizCustomerAddresses).values({
        customerId,
        contactName: input.contactName,
        contactPhone: input.contactPhone,
        province: input.province ?? null,
        city: input.city ?? null,
        district: input.district ?? null,
        detail: input.detail,
        isDefault: shouldBeDefault,
        createdBy: APP_ACTOR_ID,
        updatedBy: APP_ACTOR_ID,
      });
      return Number(inserted[0].insertId);
    });

    return this.getAddress(customerId, id);
  }

  /** 编辑地址（全量字段覆盖）；改成默认时把旧的默认清掉 */
  async updateAddress(
    appUserId: number,
    addressId: number,
    input: AppAddressUpsertRequest,
  ): Promise<AppAddressVo> {
    const customerId = await this.requireCustomerId(appUserId);
    // 先确认这个地址是自己的（否则 404），再做任何写入
    const current = await this.getAddress(customerId, addressId);

    await this.database.db.transaction(async (tx) => {
      if (input.isDefault === true) await this.clearDefault(tx, customerId);
      await tx
        .update(bizCustomerAddresses)
        .set({
          contactName: input.contactName,
          contactPhone: input.contactPhone,
          province: input.province ?? null,
          city: input.city ?? null,
          district: input.district ?? null,
          detail: input.detail,
          // 显式传 false 才降级；不传就保持原样（编辑时忘了勾默认不该把默认取消）
          ...(input.isDefault === undefined
            ? {}
            : { isDefault: input.isDefault }),
          updatedBy: APP_ACTOR_ID,
        })
        .where(
          and(
            eq(bizCustomerAddresses.id, addressId),
            eq(bizCustomerAddresses.customerId, customerId),
          ),
        );
    });

    // 「唯一一个地址被取消默认」是不可能状态：兜回来
    if (input.isDefault === false && current.isDefault) {
      await this.ensureDefault(customerId);
    }
    return this.getAddress(customerId, addressId);
  }

  /** 设为默认地址（单独的入口，列表页一键切换） */
  async setDefaultAddress(
    appUserId: number,
    addressId: number,
  ): Promise<AppAddressVo> {
    const customerId = await this.requireCustomerId(appUserId);
    await this.getAddress(customerId, addressId);
    await this.database.db.transaction(async (tx) => {
      await this.clearDefault(tx, customerId);
      await tx
        .update(bizCustomerAddresses)
        .set({ isDefault: true, updatedBy: APP_ACTOR_ID })
        .where(
          and(
            eq(bizCustomerAddresses.id, addressId),
            eq(bizCustomerAddresses.customerId, customerId),
          ),
        );
    });
    return this.getAddress(customerId, addressId);
  }

  /** 删除地址（软删）；删掉的是默认地址时，把剩下最新的一个顶上 */
  async removeAddress(appUserId: number, addressId: number): Promise<void> {
    const customerId = await this.requireCustomerId(appUserId);
    await this.getAddress(customerId, addressId);
    await this.database.db
      .update(bizCustomerAddresses)
      .set({ deletedAt: new Date(), updatedBy: APP_ACTOR_ID })
      .where(
        and(
          eq(bizCustomerAddresses.id, addressId),
          eq(bizCustomerAddresses.customerId, customerId),
        ),
      );
    await this.ensureDefault(customerId);
  }

  /* ------------------------------ 款式收藏 ------------------------------ */

  /**
   * 我的收藏（款式卡面字段 + 收藏时间）。
   *
   * **只出「还在上架且未删」的款式**：门店下架或删掉一个款式后，顾客收藏夹里那条
   * 不该还能点进去（点进去是 404 空页，比不显示更糟）。收藏行本身保留着 ——
   * 门店重新上架，收藏自然就回来了。
   */
  async listFavorites(appUserId: number): Promise<AppFavoriteListVo> {
    const customerId = await this.requireCustomerId(appUserId);
    const rows = await this.database.db
      .select({
        id: bizServiceItems.id,
        name: bizServiceItems.name,
        category: bizServiceItems.category,
        durationMinutes: bizServiceItems.durationMinutes,
        price: bizServiceItems.price,
        description: bizServiceItems.description,
        image: bizServiceItems.image,
        favoritedAt: bizCustomerFavorites.createdAt,
      })
      .from(bizCustomerFavorites)
      .innerJoin(
        bizServiceItems,
        eq(bizServiceItems.id, bizCustomerFavorites.serviceItemId),
      )
      .where(
        and(
          eq(bizCustomerFavorites.customerId, customerId),
          isNull(bizCustomerFavorites.deletedAt),
          isNull(bizServiceItems.deletedAt),
          eq(bizServiceItems.status, 'active'),
        ),
      )
      .orderBy(desc(bizCustomerFavorites.id));

    return {
      items: rows.map((row) => ({
        ...row,
        favoritedAt: row.favoritedAt.toISOString(),
      })),
    };
  }

  /**
   * 收藏一个款式（幂等）。
   *
   * `uq_customer_favorite(customer_id, service_item_id)` 在，而**软删行仍然占着**这个唯一键 ——
   * 所以查重时**不能过滤 `deletedAt`**：命中软删行就走「恢复」（`deleted_at` 置回 null），
   * 直接 INSERT 会撞 1062（data-model 技能里记的那个经典坑）。
   */
  async addFavorite(
    appUserId: number,
    serviceItemId: number,
  ): Promise<AppFavoriteToggleVo> {
    const customerId = await this.requireCustomerId(appUserId);
    await this.assertServiceItemOnSale(serviceItemId);

    const [existing] = await this.database.db
      .select({
        id: bizCustomerFavorites.id,
        deletedAt: bizCustomerFavorites.deletedAt,
      })
      .from(bizCustomerFavorites)
      .where(
        and(
          eq(bizCustomerFavorites.customerId, customerId),
          eq(bizCustomerFavorites.serviceItemId, serviceItemId),
        ),
      )
      .limit(1);

    if (existing) {
      if (existing.deletedAt) {
        await this.database.db
          .update(bizCustomerFavorites)
          .set({ deletedAt: null, updatedBy: APP_ACTOR_ID })
          .where(eq(bizCustomerFavorites.id, existing.id));
      }
      // 已经收藏着也算成功：这个动作要的语义是「让它处于已收藏」，不是「插入一行」
      return { serviceItemId, favorited: true };
    }

    await this.database.db.insert(bizCustomerFavorites).values({
      customerId,
      serviceItemId,
      createdBy: APP_ACTOR_ID,
      updatedBy: APP_ACTOR_ID,
    });
    return { serviceItemId, favorited: true };
  }

  /** 取消收藏（软删，幂等）：没收藏过也返回 `favorited: false` */
  async removeFavorite(
    appUserId: number,
    serviceItemId: number,
  ): Promise<AppFavoriteToggleVo> {
    const customerId = await this.requireCustomerId(appUserId);
    await this.database.db
      .update(bizCustomerFavorites)
      .set({ deletedAt: new Date(), updatedBy: APP_ACTOR_ID })
      .where(
        and(
          eq(bizCustomerFavorites.customerId, customerId),
          eq(bizCustomerFavorites.serviceItemId, serviceItemId),
          isNull(bizCustomerFavorites.deletedAt),
        ),
      );
    return { serviceItemId, favorited: false };
  }

  /** 只能收藏「在架且未删」的款式，否则收藏夹里会出现点不开的空壳 */
  private async assertServiceItemOnSale(serviceItemId: number): Promise<void> {
    const [item] = await this.database.db
      .select({ id: bizServiceItems.id })
      .from(bizServiceItems)
      .where(
        and(
          eq(bizServiceItems.id, serviceItemId),
          isNull(bizServiceItems.deletedAt),
          eq(bizServiceItems.status, 'active'),
        ),
      )
      .limit(1);
    if (!item) throw new NotFoundException('款式不存在或已下架');
  }

  /* ------------------------------ 站内消息 ------------------------------ */

  /**
   * 我的消息（收件箱）。
   *
   * 一律**要求绑定手机号**：站内消息是发给「这个顾客」的（预约提醒、充值成功…），
   * 未绑定时没有收件人，也就没有消息可言 —— 与「款式目录可匿名浏览」不同。
   *
   * 分类页签与未读数由 biz 侧的 `customerInbox` 一起给（它只出 `channel='site'`，
   * 短信投递日志不进收件箱）。
   */
  async listNotices(
    appUserId: number,
    query: { category?: string | undefined; page?: number; pageSize?: number },
  ): Promise<AppNoticeListVo> {
    const customerId = await this.requireCustomerId(appUserId);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const result = await this.notices.customerInbox(
      customerId,
      page,
      pageSize,
      query.category ? { category: query.category } : {},
    );
    return {
      items: result.items.map((row) => ({
        id: row.id,
        // 标题缺失时用模板 code 兜底不合适（顾客看不懂），给一句人能读的默认值
        title: row.title ?? '门店通知',
        content: row.content,
        category: row.category,
        readAt: row.readAt ? row.readAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
        bookingId: row.bookingId,
      })),
      page: result.page,
      pageSize: result.pageSize,
      unread: result.unread,
      categories: result.categories,
    };
  }

  /** 标记单条已读（幂等：已读的不会重复更新），返回剩余未读数 */
  async markNoticeRead(
    appUserId: number,
    noticeId: number,
  ): Promise<AppNoticeReadVo> {
    const customerId = await this.requireCustomerId(appUserId);
    const updated = await this.notices.markCustomerInboxRead(customerId, [
      noticeId,
    ]);
    return {
      updated: updated.updated,
      unread: await this.unreadNotices(customerId),
    };
  }

  /** 全部已读（可只清某个分类），返回剩余未读数 */
  async markAllNoticesRead(
    appUserId: number,
    category?: string,
  ): Promise<AppNoticeReadVo> {
    const customerId = await this.requireCustomerId(appUserId);
    // 按分类清已读要拿到「该分类下的未读 id」——「全部已读」按钮在有分类时也得只作用当前分类
    let ids: number[] | undefined;
    if (category) {
      const result = await this.notices.customerInbox(customerId, 1, 200, {
        category,
      });
      ids = result.items
        .filter((row) => row.readAt === null)
        .map((row) => row.id);
      if (ids.length === 0)
        return { updated: 0, unread: await this.unreadNotices(customerId) };
    }
    const updated = await this.notices.markCustomerInboxRead(customerId, ids);
    return {
      updated: updated.updated,
      unread: await this.unreadNotices(customerId),
    };
  }

  private async unreadNotices(customerId: number): Promise<number> {
    const result = await this.notices.customerInbox(customerId, 1, 1);
    return result.unread;
  }

  /* ------------------------------ 意见反馈 ------------------------------ */

  /**
   * 提交意见反馈（batch5 第 4 屏）。
   *
   * 三处刻意与别处不同：
   * 1. **不要求绑定手机号**：未绑定的访客也有意见要说，硬拦只会让他去别处骂。
   *    身份能取到就带上，取不到就按未实名处理；
   * 2. **匿名提交绝不写 `customer_id`** —— 「匿名」是当着顾客的面做出的承诺，
   *    写成「记了 id 但标了匿名」等于骗人；
   * 3. 落库后**不返回内容回显**，只回 id 与是否匿名：反馈是只写不读的通道。
   */
  async createFeedback(
    appUserId: number,
    input: AppCreateFeedbackRequest,
  ): Promise<AppCreateFeedbackVo> {
    const anonymous = input.anonymous === true;
    // 非匿名时才去解析顾客身份（未绑定时为 null，不报错）
    let customerId: number | null = null;
    if (!anonymous) {
      const [identity] = await this.database.db
        .select({ customerId: appWxUsers.customerId })
        .from(appWxUsers)
        .where(and(eq(appWxUsers.id, appUserId), isNull(appWxUsers.deletedAt)))
        .limit(1);
      customerId = identity?.customerId ?? null;
    }

    const inserted = await this.database.db.insert(bizFeedbacks).values({
      customerId,
      type: input.type,
      content: input.content,
      // 空数组与「没传」都存 null：前端判空只需判一种值
      images: input.images && input.images.length > 0 ? input.images : null,
      contact: input.contact && input.contact !== '' ? input.contact : null,
      isAnonymous: anonymous,
      status: 'pending',
      createdBy: APP_ACTOR_ID,
      updatedBy: APP_ACTOR_ID,
    });
    return { id: Number(inserted[0].insertId), anonymous };
  }

  /* ------------------------------ 门店档案 ------------------------------ */

  /**
   * 门店档案（公开信息）。
   *
   * 数据来源两层，**门店表优先、遗留配置兜底**：
   * 1. `sys_store` 的默认门店（阶段 0 起门店是实体；多店后这里会变成「按 storeId 取」）；
   * 2. 门店行里为空的字段回落 `biz.shop.*`（`BizConfigService.shopProfile()`）——
   *    老库的门店行是迁移时从配置生成的，可能整列是 null，不兜就会给小程序一片空白。
   */
  async shopProfile(): Promise<AppShopVo> {
    const [store, profile] = await Promise.all([
      this.stores.findDefault(),
      this.bizConfig.shopProfile(),
    ]);
    return {
      storeId: store?.id ?? null,
      storeCode: store?.code ?? null,
      name: store?.name ?? profile.name,
      nameEn: store?.nameEn ?? profile.nameEn,
      phone: store?.phone ?? profile.phone,
      address: store?.address ?? profile.address,
      hours: store?.hours ?? profile.hours,
      latitude: store?.latitude ?? profile.latitude,
      longitude: store?.longitude ?? profile.longitude,
      // 空串统一成 null：前端判「有没有公告」只需判一种值
      notice:
        (store?.notice ?? profile.notice) === ''
          ? null
          : (store?.notice ?? profile.notice),
      // 图集：没传过就是空数组（C 端判 length，不用判 null）
      images: store?.images ?? [],
    };
  }

  /* ------------------------------ 内部工具 ------------------------------ */

  private async countAddresses(customerId: number): Promise<number> {
    const [row] = await this.database.db
      .select({ value: sql<number>`COUNT(*)` })
      .from(bizCustomerAddresses)
      .where(
        and(
          eq(bizCustomerAddresses.customerId, customerId),
          isNull(bizCustomerAddresses.deletedAt),
        ),
      );
    return Number(row?.value ?? 0);
  }

  /** 归属校验 + 读取：不是自己的地址一律 404（不用 403，避免泄露 id 是否存在） */
  private async getAddress(
    customerId: number,
    addressId: number,
  ): Promise<AppAddressVo> {
    const [row] = await this.database.db
      .select({
        id: bizCustomerAddresses.id,
        contactName: bizCustomerAddresses.contactName,
        contactPhone: bizCustomerAddresses.contactPhone,
        province: bizCustomerAddresses.province,
        city: bizCustomerAddresses.city,
        district: bizCustomerAddresses.district,
        detail: bizCustomerAddresses.detail,
        isDefault: bizCustomerAddresses.isDefault,
      })
      .from(bizCustomerAddresses)
      .where(
        and(
          eq(bizCustomerAddresses.id, addressId),
          eq(bizCustomerAddresses.customerId, customerId),
          isNull(bizCustomerAddresses.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('地址不存在');
    return row;
  }

  private async clearDefault(tx: DbTx, customerId: number): Promise<void> {
    await tx
      .update(bizCustomerAddresses)
      .set({ isDefault: false, updatedBy: APP_ACTOR_ID })
      .where(
        and(
          eq(bizCustomerAddresses.customerId, customerId),
          eq(bizCustomerAddresses.isDefault, true),
        ),
      );
  }

  /** 一个默认地址都没有时，把最新的一个顶上去（删掉默认地址后走这里） */
  private async ensureDefault(customerId: number): Promise<void> {
    const [any] = await this.database.db
      .select({ id: bizCustomerAddresses.id })
      .from(bizCustomerAddresses)
      .where(
        and(
          eq(bizCustomerAddresses.customerId, customerId),
          eq(bizCustomerAddresses.isDefault, true),
          isNull(bizCustomerAddresses.deletedAt),
        ),
      )
      .limit(1);
    if (any) return;

    const [latest] = await this.database.db
      .select({ id: bizCustomerAddresses.id })
      .from(bizCustomerAddresses)
      .where(
        and(
          eq(bizCustomerAddresses.customerId, customerId),
          isNull(bizCustomerAddresses.deletedAt),
        ),
      )
      .orderBy(desc(bizCustomerAddresses.id))
      .limit(1);
    if (!latest) return;
    await this.database.db
      .update(bizCustomerAddresses)
      .set({ isDefault: true, updatedBy: APP_ACTOR_ID })
      .where(eq(bizCustomerAddresses.id, latest.id));
  }
}

/** 事务句柄（只在内部用，避免把 drizzle 的事务类型泄漏到调用方） */
type DbTx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];
