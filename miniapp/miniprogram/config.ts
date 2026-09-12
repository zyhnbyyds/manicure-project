/**
 * 小程序端运行时配置。
 *
 * `useMock` 说明（诚实开关，不是绕过实现）：
 *   后端已把 4 个只读接口做成真实现，但要拿到 app token 必须先过一次 `wx.login` →
 *   `POST /app/auth/login`，而该接口在 **未配置 `WX_MINIAPP_APPID` / `WX_MINIAPP_SECRET`
 *   时返回 503「小程序端未启用」**（spec §16.1 的既定降级）。
 *   在凭据到位之前，UI 无法拿到真实数据，所以开发期走演示数据；
 *   **凭据到位后改这里为 false 即可切真接口，页面代码不需要动**。
 */

/** 后端 API 基址（`API_PREFIX=api/v1`，端口取自根 .env 的 PORT=3000） */
export const API_BASE = 'http://127.0.0.1:3000/api/v1';

/** 请求超时（毫秒） */
export const REQUEST_TIMEOUT = 10000;


/**
 * 门店信息（门店信息页、客服、导航、拨号都用这一份）。
 *
 * ⚠️ **应该来自后端**：app 域目前没有「门店档案」接口（如 `GET /app/shop`），
 * 所以先集中在这里 —— 改一处即可全局生效；等后端补了接口再换成请求。
 */
export const SHOP = {
  name: '美甲小铺',
  /** 英文副标题（设计稿里有这个字样） */
  nameEn: 'BEAUTY NAILS',
  slogan: '把喜欢的样子，做在手上',
  hours: '10:00 - 20:00',
  phone: '13800000000',
  wechat: 'nailshop001',
  address: '上海市静安区南京西路 1788 号 3 楼 355 室',
  latitude: 31.229,
  longitude: 121.455,
  /** 门店照片（本地占位素材，正式应由门店档案提供） */
  image: '/assets/hero.png',
};
