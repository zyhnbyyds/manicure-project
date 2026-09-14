import { Injectable } from '@nestjs/common';
import {
  ServiceItemPort,
  SlotPort,
  StaffPort,
  StorePort,
} from '../../biz/common/ports.js';
import { parsePagination } from '../../biz/common/query.js';
import {
  appAvailableSlotsQuerySchema,
  appServiceItemIdsSchema,
  normalizeServiceItemIds,
  type AppAvailableSlotsVo,
  type AppServiceItemListVo,
  type AppStaffListVo,
} from '../dto/app-vo.js';

/**
 * app 域目录：服务项目 / 美甲师 / 可约时段（spec §9.7）。
 *
 * - **只通过端口**依赖业务模块（`ServiceItemPort` / `StaffPort` / `SlotPort`），不 import 别人的 service；
 * - 可约时段与后台**复用同一个 `SlotPort` 实现**（`channel: 'miniapp'` 只影响提前期），
 *   因此结果与后台一致（验收项）；
 * - 响应一律**逐个字段显式投影**成 `AppXxxVo`：绝不多吐成本 / 状态 / 备注 / `createdBy` 等内部字段。
 */
@Injectable()
export class AppCatalogService {
  constructor(
    private readonly serviceItems: ServiceItemPort,
    private readonly staffs: StaffPort,
    private readonly slots: SlotPort,
    private readonly stores: StorePort,
  ) {}

  /** 启用中的服务项目：字段只有 id/name/category/durationMinutes/price/description/image */
  async listServiceItems(
    rawPage?: string,
    rawPageSize?: string,
  ): Promise<AppServiceItemListVo> {
    const { page, pageSize } = parsePagination(rawPage, rawPageSize);
    const rows = await this.serviceItems.listActive();
    const offset = (page - 1) * pageSize;
    const items = rows.slice(offset, offset + pageSize).map((row) => ({
      id: row.id,
      name: row.name,
      category: row.category,
      durationMinutes: row.durationMinutes,
      price: row.price,
      description: row.description,
      image: row.image,
    }));
    return { items, page, pageSize };
  }

  /** 启用中的美甲师：字段只有 id/nickname/avatar/bio（无手机号 / 状态 / 备注） */
  async listStaffs(
    rawPage?: string,
    rawPageSize?: string,
  ): Promise<AppStaffListVo> {
    const { page, pageSize } = parsePagination(rawPage, rawPageSize);
    /*
     * 门店维度：小程序还没做「选店」，全程按**默认门店** ——
     * 只回能服务这家店的人（没配过门店的美甲师依旧全店可用，见 biz_staff_store 的约定）。
     * 将来小程序带 storeId 时，把这里换成请求里的门店即可。
     */
    const store = await this.stores.findDefault();
    const rows = await this.staffs.listActive(store?.id);
    const offset = (page - 1) * pageSize;
    const items = rows.slice(offset, offset + pageSize).map((row) => ({
      id: row.id,
      nickname: row.nickname,
      avatar: row.avatar,
      bio: row.bio,
    }));
    return { items, page, pageSize };
  }

  /**
   * 可约时段（§5）：`staffId` + `date` + `serviceItemIds`（逗号分隔或重复 query）。
   * `channel: 'miniapp'` → 走小程序的提前期（`minLeadMinutes`），算法与后台完全相同。
   */
  async availableSlots(
    query: Record<string, unknown>,
  ): Promise<AppAvailableSlotsVo> {
    const parsed = appAvailableSlotsQuerySchema.parse({
      staffId: query['staffId'],
      date: query['date'],
      serviceItemIds: query['serviceItemIds'],
    });
    const serviceItemIds = appServiceItemIdsSchema.parse(
      normalizeServiceItemIds(parsed.serviceItemIds),
    );
    return this.slots.availableSlots({
      staffId: parsed.staffId,
      date: parsed.date,
      serviceItemIds,
      channel: 'miniapp',
    });
  }
}
