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
/**
 * 后端 API 基址（`API_PREFIX=api/v1`，端口取自根 .env 的 PORT=3000）。
 *
 * **为什么写局域网 IP 而不是 `127.0.0.1`**：
 * 模拟器里两者都能用，但**真机上 `127.0.0.1` 指向手机自己**，必然连不上。
 * 统一用局域网地址 → 一套配置同时服务模拟器与真机。
 *
 * **这个 IP 会随 DHCP 变**（2026-09 就变过一次：`.101` → `.100`，是老地址连不通的头号原因），
 * 连不上时先按下面这条命令核对，别怀疑代码：
 * ```
 * Get-NetIPAddress -AddressFamily IPv4 |
 *   Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -eq 'Dhcp' }
 * ```
 * **挑「有默认网关」的那张网卡** —— VMware / Hyper-V / 蓝牙的虚拟网卡也能通，
 * 但手机连不上（本机当前是 WLAN `192.168.0.100`，网关 `192.168.0.1`）。
 * 想一劳永逸就在路由器上给这台机做 **DHCP 保留（静态分配）**，否则换网络后要改这里。
 *
 * 真机调试的四个前提：
 * 1. 手机与电脑连**同一个 Wi-Fi**；
 * 2. 手机打开**调试模式**（跳过合法域名校验）—— 本项目走 http + IP；
 * 3. **Windows 防火墙放行入站 3000**，否则手机侧一律连不上。
 *    本机已加规则 `manicure dev API 3000 (LAN)`（仅 `LocalSubnet`，管理员 PowerShell）：
 *    ```powershell
 *    New-NetFirewallRule -DisplayName "manicure dev API 3000 (LAN)" -Direction Inbound `
 *      -Protocol TCP -LocalPort 3000 -RemoteAddress LocalSubnet -Action Allow -Profile Any
 *    ```
 *    ⚠️ WLAN 的网络类别若是「公用」而没放行，症状是**手机侧超时**；本机浏览器自测**测不出防火墙**。
 * 4. 快速自检：用**手机浏览器**打开 `http://<局域网IP>:3000/api/v1/health`，能看到 JSON 就说明网络通了。
 */
export const API_BASE = 'http://192.168.0.100:3000/api/v1';

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
  /**
   * 品牌 LOGO（透明底 PNG）。
   *
   * 与 `image` 分开：`image` 是「门店照」（设计稿里的大图），LOGO 是品牌标识，
   * 两者在页面上的位置与用法完全不同，混用会导致换 LOGO 时把门店照一起换掉。
   */
  logo: '/assets/logo.png',
};
