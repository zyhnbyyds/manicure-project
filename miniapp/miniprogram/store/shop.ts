/**
 * 当前门店（多店）。
 *
 * ## 为什么放在 store/ 而不是页面里
 *
 * 「顾客选了哪家店」要影响**整条链路**：门店页展示、美甲师目录、可约时段、下单落店。
 * 所以它和 `mode.ts` 一样是「模块级偏好 + storage 持久化」，并由 `utils/request.ts`
 * 在发请求时统一注入 `x-store-id` 头 —— 页面不用各自传参。漏传一处就是
 * 「在 A 店挑的时间、单子落在 B 店」这种事后极难发现的错。
 *
 * ## 只存 id，不存门店快照
 *
 * 门店名 / 地址 / 坐标随时可能在后台改，缓存一份快照就会出现「改完名小程序还显示旧名」。
 * 要展示就现取（`shopApi.list()` 或让后端按 id 返回档案）。
 *
 * ## 没选过店 = 不发头
 *
 * 后端的规则是「头里没有 / 不合法 → 回落默认门店」。所以这里**不塞默认值**：
 * 发一个空串反而要多走一遍校验分支，语义也更绕。
 */
const STORE_KEY = 'manicure:store-id';

/** 顾客当前选的门店 id；`null` = 没选过（后端会回落默认门店） */
export function getCurrentStoreId(): number | null {
  const raw = wx.getStorageSync(STORE_KEY);
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function setCurrentStoreId(id: number | null): void {
  if (id === null) {
    wx.removeStorageSync(STORE_KEY);
    return;
  }
  wx.setStorageSync(STORE_KEY, id);
}

/** 请求头里的门店值；没选过返回 `null`（`utils/request.ts` 据此决定要不要发头） */
export function storeHeader(): string | null {
  const id = getCurrentStoreId();
  return id === null ? null : String(id);
}

/** 清掉当前门店（退出登录 / 换账号用：别把上一个账号选的店带过去） */
export function clearCurrentStore(): void {
  wx.removeStorageSync(STORE_KEY);
}
