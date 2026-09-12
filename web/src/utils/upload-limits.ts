/**
 * 上传的**客户端**限制。
 *
 * 这两个值不是拍脑袋定的，而是抄后端的：
 *
 * - 文件大小：`src/modules/files/files.service.ts` 的 `MAX_FILE_SIZE = 10 * 1024 * 1024`；
 * - 可上传类型：同文件里的 `ALLOWED_EXTENSIONS`（图片只收 jpg/jpeg/png/gif/webp/svg）。
 *
 * 前端先拦一道只是为了**少一次注定失败的请求 + 给出即时提示**；
 * 真正的把关在后端，所以这里改了那边也要跟着改。
 */

/** 单文件上限：10MB，与后端 `MAX_FILE_SIZE` 一致 */
export const MAX_UPLOAD_FILE_SIZE = 10 * 1024 * 1024;

/**
 * 图片选择器的 `accept`。
 *
 * **别图省事写 `image/*`**：手机相册里的 `.heic` / `.avif` 不在后端白名单里，必然失败。
 * 明确列 `image/jpeg` 还有个好处：iOS 会在上传前把 HEIC **自动转成 JPEG**。
 */
export const IMAGE_ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,image/svg+xml';
