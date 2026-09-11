/**
 * 细线图标（内联 SVG data-URI）。
 *
 * 为什么不用 emoji、也不用图标字体：
 * 1. 设计稿全篇是 **1.5px 单色细线图标**，emoji 是彩色位图，风格完全不符（这是上一版的失败点）；
 * 2. 图标字体需要一个字体文件，工程里没有，也不该为了几个图标引入外部依赖；
 * 3. 内联 SVG 可以在运行时按主题色生成，换主题时图标跟着变色，且矢量清晰不糊。
 *
 * 用法：页面 `data` 里放 `icons: buildIcons([...], 颜色)`，WXML 用 `src="{{icons.clock}}"`。
 * 颜色取 `getThemeTokens().text / .textSub / .primary`，别写死，否则换主题图标不跟着变。
 */

export type IconName =
  | 'shop'
  | 'chat'
  | 'calendar'
  | 'grid'
  | 'clock'
  | 'card'
  | 'home'
  | 'person'
  | 'search'
  | 'funnel'
  | 'plus'
  | 'back'
  | 'chevron'
  | 'share'
  | 'heart'
  | 'headset'
  | 'location'
  | 'gift'
  | 'coupon'
  | 'settings'
  | 'check';

/** 24x24 视图框内的描边路径（fill=none，描边由外层控制） */
const PATHS: Record<IconName, string> = {
  shop: "<path d='M5.5 8h13l-1 11.5h-11L5.5 8z'/><path d='M9 8V6.2A3 3 0 0 1 15 6.2V8'/>",
  chat: "<path d='M4.5 6.5h15v10h-9l-4 3.2v-3.2h-2z'/>",
  calendar:
    "<rect x='4' y='6' width='16' height='13.5' rx='2.5'/><path d='M4 10.5h16'/><path d='M8.5 3.5v4'/><path d='M15.5 3.5v4'/>",
  grid: "<rect x='4.5' y='4.5' width='6' height='6' rx='1.6'/><rect x='13.5' y='4.5' width='6' height='6' rx='1.6'/><rect x='4.5' y='13.5' width='6' height='6' rx='1.6'/><rect x='13.5' y='13.5' width='6' height='6' rx='1.6'/>",
  clock: "<circle cx='12' cy='12' r='8'/><path d='M12 7.8V12l3.2 2'/>",
  card: "<rect x='3.5' y='6.5' width='17' height='11' rx='2.5'/><path d='M3.5 10.5h17'/><path d='M7 14h3'/>",
  home: "<path d='M4 10.5 12 4.2l8 6.3V19.5H4z'/><path d='M9.8 19.5v-5.2h4.4v5.2'/>",
  person:
    "<circle cx='12' cy='8.6' r='3.4'/><path d='M5.6 20c0-3.5 2.9-5.6 6.4-5.6s6.4 2.1 6.4 5.6'/>",
  search: "<circle cx='10.8' cy='10.8' r='5.8'/><path d='M15.2 15.2 20 20'/>",
  funnel: "<path d='M4 4.8h16l-6.2 7.4v6.1l-3.6 1.9v-8L4 4.8z'/>",
  plus: "<circle cx='12' cy='12' r='8.2'/><path d='M12 8.4v7.2'/><path d='M8.4 12h7.2'/>",
  back: "<path d='M14.6 4.8 7.4 12l7.2 7.2'/>",
  chevron: "<path d='M9.4 4.8 16.6 12l-7.2 7.2'/>",
  share:
    "<path d='M12 3.6v10.2'/><path d='M8.2 7.2 12 3.6l3.8 3.6'/><path d='M6 13.4v6.4h12v-6.4'/>",
  heart:
    "<path d='M12 19.4c-1.2-.9-7-5-7-9.2A4.2 4.2 0 0 1 12 7.2a4.2 4.2 0 0 1 7 3c0 4.2-5.8 8.3-7 9.2z'/>",
  headset:
    "<path d='M5 13.4v-1.2a7 7 0 0 1 14 0v1.2'/><rect x='4.2' y='12.6' width='3.2' height='5.4' rx='1.6'/><rect x='16.6' y='12.6' width='3.2' height='5.4' rx='1.6'/>",
  location:
    "<path d='M12 20.4s6.2-5.6 6.2-10.2A6.2 6.2 0 0 0 5.8 10.2c0 4.6 6.2 10.2 6.2 10.2z'/><circle cx='12' cy='10.2' r='2.4'/>",
  gift: "<rect x='3.8' y='8.6' width='16.4' height='11.4' rx='2'/><path d='M3.8 13h16.4'/><path d='M12 8.6v11.4'/><path d='M12 8.6C11.2 5.6 9.8 4 8 4a2.4 2.4 0 0 0 0 4.6h4z'/><path d='M12 8.6c.8-3 2.2-4.6 4-4.6a2.4 2.4 0 0 1 0 4.6h-4z'/>",
  coupon:
    "<path d='M3.6 8.4a2 2 0 0 1 2-2h12.8a2 2 0 0 1 2 2v1.4a2.2 2.2 0 0 0 0 4.4v1.4a2 2 0 0 1-2 2H5.6a2 2 0 0 1-2-2v-1.4a2.2 2.2 0 0 0 0-4.4z'/><path d='M13.4 6.4v11.2'/>",
  settings:
    "<circle cx='12' cy='12' r='3'/><path d='M12 3.4v2.2'/><path d='M12 18.4v2.2'/><path d='M3.4 12h2.2'/><path d='M18.4 12h2.2'/><path d='M6.2 6.2 7.8 7.8'/><path d='M16.2 16.2l1.6 1.6'/><path d='M17.8 6.2 16.2 7.8'/><path d='M7.8 16.2 6.2 17.8'/>",
  check: "<path d='M5.2 12.6 9.6 17l9.2-9.6'/>",
};

/**
 * SVG → `<image src>` 可用的 data-URI。
 *
 * ⚠️ 必须用 **base64**，不能用 `encodeURIComponent`：小程序的 `<image>` 不解析
 * URL 编码形式的 `data:image/svg+xml,...`，图标会静默不渲染（只剩文字，很难排查）。
 *
 * 这里手写一个只处理 ASCII 的 base64：我们的 SVG 只含 ASCII（路径数据 + 十六进制色值），
 * 因此不需要处理 UTF-8 多字节，避免为一个编码函数引入额外依赖。
 */
const B64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64Ascii(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i += 3) {
    const has2 = i + 1 < input.length;
    const has3 = i + 2 < input.length;
    const c1 = input.charCodeAt(i);
    const c2 = has2 ? input.charCodeAt(i + 1) : 0;
    const c3 = has3 ? input.charCodeAt(i + 2) : 0;
    out += B64[c1 >> 2];
    out += B64[((c1 & 3) << 4) | (c2 >> 4)];
    out += has2 ? B64[((c2 & 15) << 2) | (c3 >> 6)] : '=';
    out += has3 ? B64[c3 & 63] : '=';
  }
  return out;
}

export function svgIcon(name: IconName, color: string, size = 24): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 24 24' ` +
    `fill='none' stroke='${color}' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'>` +
    `${PATHS[name]}</svg>`;
  return `data:image/svg+xml;base64,${base64Ascii(svg)}`;
}

/** 批量生成：`buildIcons(['clock','card'], color)` → `{ clock: 'data:...', card: 'data:...' }` */
export function buildIcons(
  names: IconName[],
  color: string,
  size = 24,
): Record<string, string> {
  const result: Record<string, string> = {};
  names.forEach((name) => {
    result[name] = svgIcon(name, color, size);
  });
  return result;
}
