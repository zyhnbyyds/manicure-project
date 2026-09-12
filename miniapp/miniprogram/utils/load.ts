/**
 * 统一的「异步加载状态机」。
 *
 * ## 为什么需要
 *
 * 迁移前 20 多个页面各写一遍：
 * `setData({loading:true})` → `try` → `setData({loading:false, ...})`
 * → `catch` → `setData({loading:false, errorText: isApiFailure(e) ? e.message : '×××'})`。
 * 三处漂移是必然的：
 * 1. **兜底文案各写各的**（「网络连接失败」/「加载失败，请稍后再试」/「加载失败」）；
 * 2. **每次 onShow 都回骨架态** —— 切 Tab 回来先闪一屏骨架再出内容，这就是「不顺畅」的主要来源；
 * 3. **刷新失败会把已有内容清空** —— 一次网络抖动让整页变空，比不刷新还糟。
 *
 * ## 约定（页面只要记住三条）
 *
 * - 页面 `data` 里由 `definePage` 自动带上 `loading / refreshing / errorText / loaded`；
 * - 拉数据只写 `await runLoad(this, () => api(), { merge, after })`，**不要自己 setData loading**；
 * - 首屏用 `loading` 渲染骨架；`refreshing` 只用于「非首屏刷新」的轻提示。
 *
 * 状态机：
 * | 时机 | loading | refreshing | 内容 |
 * | ---- | ------- | ---------- | ---- |
 * | 首次加载 | true | false | 骨架屏 |
 * | 已有数据再刷新 | 保持 false | true | **保留旧内容**，顶部细条提示 |
 * | 首次失败 | false | false | errorText → 错误态（可重试） |
 * | 刷新失败 | false | false | **保留旧内容** + toast 告知 |
 */
import { isApiFailure } from './request';
import { toast } from './ui';

/** 参与状态机的最小宿主（`Page` / `Component` 实例都满足） */
export interface LoadHost {
  // 用 any 而不是 unknown：这里只是一个结构性约束，
  // 收紧成 Record<string, unknown> 会让所有页面实例因为「缺少索引签名」而不可赋值。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
  setData(data: Record<string, any>, callback?: () => void): void;
}

export interface RunLoadOptions<T> {
  /**
   * 结果 → `setData` 的补丁。
   * 返回 `undefined`（即不返回）表示调用方自己已经 `setData` 过（少数需要特殊时序的页面）。
   */
  merge?: (result: T) => Record<string, any> | undefined;
  /** 失败兜底文案（默认「网络连接失败」；只有确实需要区分时再传） */
  fallbackMessage?: string;
  /** 本次是否**强制**回到骨架态（如切换了筛选条件、数据源整体变了） */
  force?: boolean;
  /** setData 之后的收尾（如本地过滤 recompute） */
  after?: () => void;
  /** 失败时是否 toast（默认：已有内容时才 toast，首屏失败由错误态自己表达） */
  toastOnError?: boolean;
}

/** 首屏错误态的兜底文案，全项目统一 */
export const DEFAULT_LOAD_ERROR = '网络连接失败';

/**
 * 跑一次加载。
 *
 * @returns 是否成功（少数页面需要据此决定后续动作）
 */
export async function runLoad<T>(
  page: LoadHost,
  task: () => Promise<T>,
  options: RunLoadOptions<T> = {},
): Promise<boolean> {
  const first = page.data.loaded !== true || options.force === true;

  // 首屏显示骨架；已有数据则静默刷新，**不清空、不回骨架**（这是「顺滑」的关键）
  page.setData(first ? { loading: true, errorText: '' } : { refreshing: true });

  try {
    const result = await task();
    const patch = options.merge ? options.merge(result) : undefined;
    page.setData(
      {
        loading: false,
        refreshing: false,
        loaded: true,
        errorText: '',
        ...patch,
      },
      options.after,
    );
    return true;
  } catch (error) {
    const message = isApiFailure(error)
      ? error.message
      : (options.fallbackMessage ?? DEFAULT_LOAD_ERROR);
    const keepContent = page.data.loaded === true;
    page.setData(
      keepContent
        ? { loading: false, refreshing: false }
        : { loading: false, refreshing: false, errorText: message },
    );
    if (options.toastOnError ?? keepContent) toast(message);
    return false;
  }
}

/**
 * 下拉刷新的标准收尾。
 *
 * 单独抽出来是因为「`await load()` 之后必须 `stopPullDownRefresh`」这件事
 * 一旦漏写，下拉转圈就会永远停不下来 —— 交给一个函数比靠记性可靠。
 */
export async function runPullDownLoad(
  task: () => Promise<unknown>,
): Promise<void> {
  try {
    await task();
  } finally {
    wx.stopPullDownRefresh();
  }
}
