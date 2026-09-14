import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { getMyStores } from '~/api/system/stores';
import type { MyStore } from '~/types/api';

/**
 * 顶栏门店切换器选中的门店，存 localStorage。
 *
 * 为什么不落库：这是**操作人自己的视图选择**（等同于「当前看哪家店」的浏览器偏好），
 * 不是业务数据；落库反而会带来「同一账号多标签页/多设备互相打架」的问题。
 * 但它必须是**持久**的 —— 刷新、重进后台后要还原成同一家店，
 * 否则用户会以为「我刚才切到 B 店，怎么又是 A 店的数」（用户明确要求过这条）。
 * 服务端每次请求都会复核可见性，所以本地存的值只是「意图」，不存在越权风险。
 */
export const ACTIVE_STORE_KEY = 'manicure:active-store';

function readStoredId(): number | null {
  const raw = localStorage.getItem(ACTIVE_STORE_KEY);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * 「当前门店」上下文（连锁直营 · 阶段 1.7）。
 *
 * 一条链路串起来：
 * 1. `GET /stores/mine` 拿到**我可见的门店**（登录即可，不要求门店管理权限）；
 * 2. 顶栏切换器写 `activeStoreId`（持久化到 localStorage）；
 * 3. `request.ts` 拦截器把它作为 `x-store-id` 头带给后端；
 * 4. 后端 `resolveStoreScope` 复核可见性后，**列表按它筛选、新建单据按它落店**。
 *
 * 因此各页面不需要自己拼 `?storeId=`；`useTable` 会在切换时自动重载当前列表。
 */
export const useStoreScopeStore = defineStore('store-scope', () => {
  const stores = ref<MyStore[]>([]);
  /** `none` = 一家可用的门店都没有（未分配 / 门店全停用），顶栏常驻提示 */
  const scope = ref<'all' | 'stores' | 'none'>('none');
  const activeStoreId = ref<number | null>(readStoredId());
  const loading = ref(false);
  const loaded = ref(false);
  const error = ref<string | null>(null);

  /** 只有「可切的门店超过 1 家」才显示切换器：单店期不该让运营看见这个概念 */
  const hasSwitcher = computed(() => stores.value.length > 1);

  /** 当前选中的门店（`null` = 未选 = 可见范围内的全部门店） */
  const activeStore = computed(
    () => stores.value.find((item) => item.id === activeStoreId.value) ?? null,
  );

  /** 切换器的展示文案：未选时是「全部门店」 */
  const activeLabel = computed(() => activeStore.value?.name ?? '全部门店');

  let inflight: Promise<void> | null = null;

  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const data = await getMyStores();
      stores.value = data.stores;
      scope.value = data.scope;
      // 以服务端复核结果为准：本地残留的「已删除 / 已停用 / 越权」门店在这里被归一回 null
      if (data.activeStoreId !== activeStoreId.value)
        setActive(data.activeStoreId);
      loaded.value = true;
    } catch (err) {
      // 失败不清理已有选择：网络抖一下就把用户选的门店弄丢更糟
      error.value = err instanceof Error ? err.message : '门店信息加载失败';
    } finally {
      loading.value = false;
    }
  }

  /** 幂等加载（路由守卫每次导航都会调）：并发调用共享同一个请求 */
  async function ensureLoaded(): Promise<void> {
    if (loaded.value) return;
    inflight ??= load().finally(() => {
      inflight = null;
    });
    await inflight;
  }

  /**
   * 切换门店（`null` = 全部门店）。
   *
   * 只改本地状态 + 持久化，**不发请求**：门店是请求级上下文（`x-store-id` 头），
   * 下一次请求自然带上；当前页面的列表由 `useTable` 监听 `activeStoreId` 自动重载。
   */
  function setActive(id: number | null): void {
    activeStoreId.value = id;
    if (id === null) localStorage.removeItem(ACTIVE_STORE_KEY);
    else localStorage.setItem(ACTIVE_STORE_KEY, String(id));
  }

  /** 退出登录时清空：否则下一个账号会继承上一个账号选的门店（越权提示会很莫名） */
  function reset(): void {
    stores.value = [];
    scope.value = 'none';
    loaded.value = false;
    error.value = null;
    setActive(null);
  }

  return {
    stores,
    scope,
    activeStoreId,
    loading,
    loaded,
    error,
    hasSwitcher,
    activeStore,
    activeLabel,
    load,
    ensureLoaded,
    setActive,
    reset,
  };
});
