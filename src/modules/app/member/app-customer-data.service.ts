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
} from '../../../database/schema/index.js';
import { APP_ACTOR_ID } from '../app-actor.js';
import type {
  AppAddressListVo,
  AppAddressUpsertRequest,
  AppAddressVo,
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
  constructor(private readonly database: DatabaseService) {}

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
