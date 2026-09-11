import type { EntityStatus, PageResult } from '~/types/api';
import { del, get, patch, post } from '~/request';

/** 服务项目（biz_service_item，§9.1） */
export interface ServiceItem {
  id: number;
  name: string;
  category: string | null;
  /** 标准时长（分钟），参与可约时段计算 */
  durationMinutes: number;
  /** 缓冲时长（分钟），参与冲突判定 */
  bufferMinutes: number;
  /** 价格（分） */
  price: number;
  description: string | null;
  /**
   * 封面图：**服务端派生字段**，恒等于 `images[0] ?? null`。
   * 只读，提交时不要带（后端 zod 会直接丢掉）。
   */
  image: string | null;
  /** 展示图集，顺序即展示顺序；最多 9 张 */
  images: string[] | null;
  status: EntityStatus;
  sort: number;
  remark: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  createdBy: number | null;
  updatedBy: number | null;
}

export interface CreateServiceItemBody {
  name: string;
  category?: string | null;
  durationMinutes: number;
  bufferMinutes?: number;
  /** 单位「分」，前端表单用元输入后 ×100 */
  price?: number;
  description?: string | null;
  /** 展示图集（最多 9 张，首图即封面）；封面 `image` 由后端派生，不要传 */
  images?: string[] | null;
  status?: EntityStatus;
  sort?: number;
  remark?: string | null;
}

export type UpdateServiceItemBody = Partial<CreateServiceItemBody>;

export interface ServiceItemListQuery {
  /** 项目名模糊匹配 */
  keyword?: string;
  status?: EntityStatus;
}

/** 服务项目列表（分页，响应无 total） */
export function listServiceItems(
  page = 1,
  pageSize = 20,
  query: ServiceItemListQuery = {},
) {
  return get<PageResult<ServiceItem>>('/biz/service-items', {
    page,
    pageSize,
    ...query,
  });
}

/** 启用中的服务项目（预约弹窗 / 美甲师可做项目多选用） */
export function listActiveServiceItems(pageSize = 200) {
  return listServiceItems(1, pageSize, { status: 'active' });
}

/** 服务项目详情 */
export function getServiceItem(id: number) {
  return get<ServiceItem>(`/biz/service-items/${id}`);
}

/** 新增服务项目 */
export function createServiceItem(body: CreateServiceItemBody) {
  return post<{ id: number }>('/biz/service-items', body);
}

/** 修改服务项目 */
export function updateServiceItem(id: number, body: UpdateServiceItemBody) {
  return patch<void>(`/biz/service-items/${id}`, body);
}

/** 删除服务项目（软删；被未完成预约引用时 409） */
export function deleteServiceItem(id: number) {
  return del<void>(`/biz/service-items/${id}`);
}
