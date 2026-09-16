import { computed, ref, shallowRef, watch } from 'vue';
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
 * 通用表格分页逻辑
 * 后端分页响应无 total 字段，通过多取一条判断 hasMore 估算 total
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

  const total = computed(() => {
    // 估算 total：当前页满页且有下一页 → page*pageSize+1，否则 page*pageSize
    if (hasMore.value) return currentPage.value * pageSize.value + 1;
    return (currentPage.value - 1) * pageSize.value + items.value.length;
  });

  async function fetchPage(page = currentPage.value) {
    loading.value = true;
    try {
      const extraQuery = options.query?.() ?? ({} as Q);
      // 多取一条用于判断 hasMore
      const data = await get<PageResult<T>>(options.url, {
        page,
        pageSize: pageSize.value + 1,
        ...extraQuery,
      });
      const list = data.items.slice(0, pageSize.value);
      hasMore.value = data.items.length > pageSize.value;
      items.value = options.transform ? options.transform(list) : list;
      currentPage.value = data.page;
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
