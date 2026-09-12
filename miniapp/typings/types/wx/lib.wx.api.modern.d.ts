/**
 * 补声明：基础库 2.20.1+ 的「新」同步 API。
 *
 * 本仓库 `lib.wx.api.d.ts` 是从 miniprogram-api-typings 拷来的**旧版**，
 * 没有下面这几个接口。而 `wx.getSystemInfoSync` 已被官方标记弃用
 * （新基础库上每调一次就刷一条 deprecation 告警），所以按官方文档补最小可用声明，
 * 让业务代码可以正常使用新 API。
 *
 * 只声明 `getNavMetrics()` 实际用到的字段，避免凭空写一堆没验证过的类型。
 */
declare namespace WechatMiniprogram {
  interface Wx {
    /**
     * 窗口信息（`getSystemInfoSync` 的替代之一）。
     * 取导航栏高度只需要 `statusBarHeight` 与 `windowWidth`。
     */
    getWindowInfo(): {
      pixelRatio: number;
      screenWidth: number;
      screenHeight: number;
      windowWidth: number;
      windowHeight: number;
      statusBarHeight: number;
      screenTop: number;
      safeArea: {
        left: number;
        right: number;
        top: number;
        bottom: number;
        width: number;
        height: number;
      };
    };
  }
}
