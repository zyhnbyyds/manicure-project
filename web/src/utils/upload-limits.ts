/**
 * 上传的**客户端**限制（前端预检）+ 预压缩的目标值。
 *
 * 这几个值不是拍脑袋定的，而是抄后端的：
 *
 * - 文件大小：`src/modules/files/files.service.ts` 的 `MAX_FILE_SIZE = 5 * 1024 * 1024`
 *   （multipart 全局 `fileSize` 与 `web/nginx.conf` 的 `client_max_body_size` 也是同一口径）；
 * - 可上传类型：同文件里的 `ALLOWED_EXTENSIONS`（图片只收 jpg/jpeg/png/gif/webp/svg）；
 * - 压缩目标：`src/modules/files/image-compress.ts` 的 `IMAGE_MAX_BYTES = 1MB`。
 *
 * 前端先拦一道只是为了**少一次注定失败的请求 + 给出即时提示**；
 * 真正的把关在后端，所以这里改了那边也要跟着改。
 */

/** 单文件上限：5MB，与后端 `MAX_FILE_SIZE` / multipart / nginx 一致 */
export const MAX_UPLOAD_FILE_SIZE = 5 * 1024 * 1024;

/**
 * 上限的可读写法，专给提示文案用。
 *
 * **别在页面里手写「1MB/5MB」** —— 本轮把上限从 10MB 改成 5MB 时，
 * 三个页面里的写死文案（文件管理页副标题、附件超限提示、头像超限提示）全都成了假话。
 */
export const MAX_UPLOAD_FILE_SIZE_LABEL = `${MAX_UPLOAD_FILE_SIZE / 1024 / 1024}MB`;

/**
 * 图片压缩目标：1MB。
 *
 * 前端（本文件同目录的 `image-compress.ts`）与后端（`src/modules/files/image-compress.ts`）
 * 用同一个数字，但**职责不同**：前端压是为了省流量（弱网下少传几 MB），
 * 后端压是口径兜底（客户端可以绕过）。所以前端压完后端仍会校验一遍，
 * 而前端压不下去（比如浏览器编不了这种图）也不影响上传成功。
 */
export const IMAGE_COMPRESS_TARGET_BYTES = 1024 * 1024;

/**
 * 图片选择器的 `accept`。
 *
 * **别图省事写 `image/*`**：手机相册里的 `.heic` / `.avif` 不在后端白名单里，必然失败。
 * 明确列 `image/jpeg` 还有个好处：iOS 会在上传前把 HEIC **自动转成 JPEG**。
 */
export const IMAGE_ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,image/svg+xml';
