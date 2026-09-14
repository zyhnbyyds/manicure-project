/**
 * 资源地址（图片等）的绝对化。
 *
 * ## 为什么需要
 *
 * 后端库里存的是**服务端相对路径**：`/api/v1/files/10/download?inline=1`
 * （web 后台靠同源 / vite 代理能直接渲染，所以一直没暴露）。
 * 但小程序里 `<image src="/...">` 会被当成**包内本地文件**去加载 → **必然失败**：
 * 款式库封面、美甲师头像这类图会静默空掉。
 *
 * 所以小程序侧统一把相对路径拼上 `API_BASE` 的 origin；
 * 已经是 `http(s)://` 或本地 `assets/` 相对路径的原样返回。
 */
import { API_BASE } from '../config';

/** 把 `http://host:3000/api/v1` 之类的前缀去掉，得到 origin */
const ASSET_ORIGIN = API_BASE.replace(/\/api\/v\d+\/?$/i, '').replace(
  /\/+$/,
  '',
);

/**
 * 服务端相对路径 → 可直接绑定到 `<image src>` 的绝对地址。
 *
 * - `http(s)://…`（含 `cloud://`）→ 原样返回；
 * - `/api/v1/files/…`（服务端路径）→ 拼上 origin；
 * - `assets/…`（小程序包内相对素材）→ 原样返回；
 * - 空值 → `null`（调用方走占位图）。
 */
export function absoluteAssetUrl(
  url: string | null | undefined,
): string | null {
  if (!url) return null;
  if (/^(?:https?:|cloud:)/i.test(url)) return url;
  // 包内素材：`assets/xxx.png` / `./assets/xxx.png`（不带前导斜杠）
  if (!url.startsWith('/')) return url;
  // 已经是「双斜杠协议相对」的也放行
  if (url.startsWith('//')) return url;
  return `${ASSET_ORIGIN}${url}`;
}
