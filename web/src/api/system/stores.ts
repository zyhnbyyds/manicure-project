import type { PageResult, Store, StoreBody } from '~/types/api';
import { del, get, patch, post, put } from '~/request';

/**
 * 门店档案（连锁直营）。
 *
 * 门店是**总部配置**：权限点 `system:store:*`，只有超管/被授予的角色能改。
 * 删除是软删，且默认门店不允许删（后端 409，前端把原因原样展示）。
 */
export function listStores(page = 1, pageSize = 50) {
  return get<PageResult<Store>>('/stores', { page, pageSize });
}

export function createStore(body: StoreBody) {
  return post<{ id: number }>('/stores', body);
}

export function updateStore(id: number, body: Partial<StoreBody>) {
  return patch<{ ok: boolean }>(`/stores/${id}`, body);
}

/** 设为默认门店：后端在同一事务里清掉原默认 */
export function setDefaultStore(id: number) {
  return post<{ ok: boolean }>(`/stores/${id}/default`);
}

export function deleteStore(id: number) {
  return del<{ ok: boolean }>(`/stores/${id}`);
}

/** 该账号的可见门店（授权弹窗回填） */
export function getUserStores(userId: number) {
  return get<{ storeIds: number[] }>(`/system/users/${userId}/stores`);
}

/** 设置该账号的可见门店（整体替换；空数组 = 取消全部授权） */
export function setUserStores(userId: number, storeIds: number[]) {
  return put<{ success: boolean }>(`/system/users/${userId}/stores`, {
    storeIds,
  });
}
