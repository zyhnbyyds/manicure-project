import type { PageResult } from '~/types/api';
import { del, get, patch, post } from '~/request';

/** 次卡卡种（biz_member_card_type + 适用项目子表，§4.4 / §15.5） */
export interface CardType {
  id: number;
  name: string;
  /** 售价（分），发卡时可改价 */
  price: number;
  /** 总次数 */
  totalTimes: number;
  /** 有效期天数，**0 = 永久** */
  validDays: number;
  status: 'active' | 'disabled';
  sort: number;
  remark: string | null;
  /** 适用项目 id 集合（整体替换，至少 1 个） */
  serviceItemIds: number[];
  /** 适用项目名称（列表展示用，后端联查返回） */
  serviceItems?: { id: number; name: string }[];
  createdAt: string;
  updatedAt?: string;
}

export interface CardTypeQuery {
  status?: string;
  keyword?: string;
}

export interface CardTypeBody {
  name?: string;
  price?: number;
  totalTimes?: number;
  validDays?: number;
  status?: 'active' | 'disabled';
  sort?: number;
  remark?: string | null;
  /** 适用项目**整体替换** */
  serviceItemIds?: number[];
}

/** 卡种列表（分页，含适用项目） */
export function listCardTypes(
  page = 1,
  pageSize = 20,
  query: CardTypeQuery = {},
) {
  return get<PageResult<CardType>>('/biz/card-types', {
    page,
    pageSize,
    ...query,
  });
}

/** 全部启用卡种（下拉选项用） */
export async function listActiveCardTypes() {
  const data = await listCardTypes(1, 100, { status: 'active' });
  return data.items;
}

/** 新增卡种（含适用项目，整体替换） */
export function createCardType(body: CardTypeBody) {
  return post<{ id: number }>('/biz/card-types', body);
}

/** 修改卡种（含适用项目，整体替换） */
export function updateCardType(id: number, body: CardTypeBody) {
  return patch<void>(`/biz/card-types/${id}`, body);
}

/** 删除卡种（软删；已发出的卡不受影响） */
export function deleteCardType(id: number) {
  return del<void>(`/biz/card-types/${id}`);
}

/** 适用项目下拉选项（读 `/biz/service-items`，只取启用项） */
export interface ServiceItemOption {
  id: number;
  name: string;
  durationMinutes?: number;
  price?: number;
}

export async function listServiceItemOptions() {
  const data = await get<PageResult<ServiceItemOption>>('/biz/service-items', {
    page: 1,
    pageSize: 200,
    status: 'active',
  });
  return data.items;
}
