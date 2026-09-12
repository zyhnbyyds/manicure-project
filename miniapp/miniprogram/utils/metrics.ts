/**
 * 导航栏所需的窗口信息。
 *
 * ## 为什么不用 `wx.getSystemInfoSync()`
 *
 * 官方已弃用：新基础库上每调一次就在控制台刷一条
 * `wx.getSystemInfoSync is deprecated. Please use ... instead`。
 * 而导航栏高度有 4 个页面要用，等于每次进页面都刷 —— 控制台里的真问题会被淹掉。
 *
 * 优先用新的 `wx.getWindowInfo()`；仅在**老基础库**上没有该 API 时回退到旧接口
 * （回退分支在老库上走到，那时本来也没有弃用告警）。
 *
 * ## 为什么要包一层
 *
 * 这 4 个页面原本各写一遍「取 statusBarHeight / windowWidth」，兜底口径容易漂。
 * 现在只有这一处。
 */
export interface NavMetrics {
  /** 状态栏高度（px） */
  statusBarHeight: number;
  /** 窗口宽度（px），用于按胶囊位置留出右侧间距 */
  windowWidth: number;
}

const DEFAULT_STATUS_BAR = 20;
const DEFAULT_WINDOW_WIDTH = 375;

export function getNavMetrics(): NavMetrics {
  try {
    if (typeof wx.getWindowInfo === 'function') {
      const info = wx.getWindowInfo();
      return {
        statusBarHeight: info.statusBarHeight ?? DEFAULT_STATUS_BAR,
        windowWidth: info.windowWidth ?? DEFAULT_WINDOW_WIDTH,
      };
    }
    // 老基础库回退：这里刻意保留旧 API，它在这类系统上并未被弃用
    const legacy = (
      wx as unknown as {
        getSystemInfoSync?: () => {
          statusBarHeight?: number;
          windowWidth?: number;
        };
      }
    ).getSystemInfoSync;
    if (typeof legacy === 'function') {
      const info = legacy.call(wx);
      return {
        statusBarHeight: info.statusBarHeight ?? DEFAULT_STATUS_BAR,
        windowWidth: info.windowWidth ?? DEFAULT_WINDOW_WIDTH,
      };
    }
  } catch {
    /* 取不到就用默认值，不让导航栏计算影响页面加载 */
  }
  return {
    statusBarHeight: DEFAULT_STATUS_BAR,
    windowWidth: DEFAULT_WINDOW_WIDTH,
  };
}
