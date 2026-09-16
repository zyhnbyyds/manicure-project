import { ref, shallowRef, watch } from 'vue';
import type { PageResult } from '~/types/api';
import { get } from '~/request';
import { useStoreScopeStore } from '~/store/store-scope';

export interface UseTableOptions<T, Q extends Record<string, unknown>> {
  /** 请求路径 */
  url: string;
  /** 额外查询参数（响应式） */
  query?: () => Q;
  /** 默认分页大小 */
  defaultPageSize?: number;
  /** 数据加载后转换 */
  transform?: (items: T[]) => T[];
}

/**
 * 通用表格分页逻辑（服务端分页）。
 *
 * `total` 来自后端列表响应的 `total`（同条件下的 `COUNT(*)`），所以分页器的页数是**真的**：
 * 能显示「共 N 条」、能直接跳到第 20 页。
 *
 * ⚠️ **不要再改成「多取一条」判 `hasMore`** —— 原因见 `fetchPage` 里的注释（会污染 offset）。
 */
export function useTable<
  T extends { id: number },
  Q extends Record<string, unknown> = Record<string, unknown>,
>(options: UseTableOptions<T, Q>) {
  const pageSize = ref(options.defaultPageSize ?? 20);
  const currentPage = ref(1);
  const items = shallowRef<T[]>([]);
  const loading = ref(false);
  const hasMore = ref(false);

  /** 总条数：后端给了就是真值，否则退回「已加载到的位置」估算 */
  const total = ref(0);

  async function fetchPage(page = currentPage.value) {
    loading.value = true;
    try {
      const extraQuery = options.query?.() ?? ({} as Q);
      /**
       * ⚠️ **`pageSize` 必须是「每页条数」本身 —— 绝不能传 `pageSize + 1`。**
       *
       * 曾经为了「多取一条判有没有下一页」而传 `pageSize + 1`，但后端的 `offset` 就是
       * `(page - 1) * pageSize`（用的正是这个被 +1 的值），于是第 N 页的起点整体后移
       * `N - 1` 条：**翻页会漏数据，最后一页还会越界变空**。
       *
       * 实测（32 条、每页 10 条）：`page=4&pageSize=10` 返回 2 条，而前端实际发的
       * `page=4&pageSize=11` 返回 **0 条** —— 这就是「点最后一页是空的」的真凶。
       *
       * 现在后端列表都返回 `total`，`hasMore` 由它推导，不需要多取那一条；
       * 只有 `total` 缺失的老接口才退回「满页即可能还有下一页」的保守判断。
       */
      const data = await get<PageResult<T>>(options.url, {
        page,
        pageSize: pageSize.value,
        ...extraQuery,
      });
      const list = data.items;
      items.value = options.transform ? options.transform(list) : list;
      currentPage.value = data.page;
      const serverTotal =
        typeof data.total === 'number' && Number.isFinite(data.total)
          ? data.total
          : null;
      const loadedTo = (data.page - 1) * pageSize.value + list.length;
      total.value = serverTotal ?? loadedTo;
      hasMore.value =
        serverTotal === null
          ? list.length >= pageSize.value
          : loadedTo < serverTotal;
    } finally {
      loading.value = false;
    }
  }

  function search() {
    currentPage.value = 1;
    return fetchPage(1);
  }

  function refresh() {
    return fetchPage(currentPage.value);
  }

  /**
   * 分页器变化 → 拉对应页。
   *
   * ⚠️ **只读 `currentPage`，绝不能拿 `data.pageSize` 回写 `pageSize`。**
   *
   * lew-ui 是受控组件：换每页条数时它先 emit `update:pageSize(新值)`，紧接着
   * **在同一个同步流程里** emit `change` —— 而那会儿父组件还没把新值回写到 props，
   * 于是 `change` 负载里带的是**旧值**。实测点「每页 10」的 emit 序列是：
   * `update:pageSize(10)` → `change({ currentPage: 1, pageSize: 20 })`。
   * 若在这里写 `pageSize.value = data.pageSize`，就把刚选中的 10 覆盖回 20，
   * 请求仍按 20 发 —— 症状正是「从 20 切到 10 没反应，列表纹丝不动」。
   *
   * 所以写入交给 `v-model:page-size`（它能正确写进 ref），这里只负责按新的
   * 每页条数重新拉数据。翻页不受此影响：`change` 里的 `currentPage` 是**新值**
   * （实测 `update:currentPage(2)` → `change({ currentPage: 2 })`）。
   */
  function handleChange(data: { currentPage: number; pageSize: number }) {
    return fetchPage(data.currentPage);
  }

  /**
   * 顶栏切换门店 → 当前列表自动从第 1 页重载。
   *
   * 放在这里而不是每个页面自己 `watch`：门店筛选是**横切**的（后端所有接了门店的单据表
   * 都按 `x-store-id` 过滤），逐个页面接迟早会漏，漏了就是「切了店但列表还是旧数据」。
   * 不接门店的后端会忽略这个头，代价只是一次多余请求（切换是低频动作）。
   */
  const storeScope = useStoreScopeStore();
  watch(
    () => storeScope.activeStoreId,
    () => {
      void search();
    },
  );

  return {
    items,
    loading,
    currentPage,
    pageSize,
    total,
    hasMore,
    fetchPage,
    search,
    refresh,
    handleChange,
  };
}
