import { API_BASE } from '../config';
import { absoluteAssetUrl } from './asset-url';
import { getToken } from './token';
import { toast } from './ui';

/** 上传接口（app token 域；后台的 `/files/upload` 走的是后台 token，小程序打过去会 401） */
const UPLOAD_PATH = '/app/upload';

export interface UploadedImage {
  /** 可直接绑定到 `<image src>` 的地址（已拼上接口域名） */
  src: string;
  /** 提交给后端时用的相对路径（`/api/v1/files/:id/download`） */
  path: string;
}

/**
 * 选图并上传（评价配图 / 意见反馈截图共用）。
 *
 * ## 为什么用 `wx.uploadFile` 而不是 `wx.request`
 *
 * 小程序上传文件只有 `wx.uploadFile` 这一条路（`wx.request` 发不了 multipart）；
 * 它和 `request()` 一样需要手动带 `Authorization`，所以这里显式取 token。
 *
 * ## 失败一律返回 null 并 toast
 *
 * 调用方的语义是「这张图没传上去」，不是「整个表单失败」——
 * 让顾客可以继续提交文字，而不是因为一张图重填整页。
 *
 * @param count 还能再选几张（调用方按设计稿的图位上限算好）
 */
export async function chooseAndUploadImage(
  count = 1,
): Promise<UploadedImage | null> {
  try {
    const chosen = await wx.chooseMedia({
      count: Math.max(1, Math.min(count, 9)),
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
    });
    const file = chosen.tempFiles[0];
    if (!file) return null;

    const token = getToken();
    const result = await new Promise<WechatMiniprogram.UploadFileSuccessCallbackResult>(
      (resolve, reject) => {
        wx.uploadFile({
          url: `${API_BASE}${UPLOAD_PATH}`,
          filePath: file.tempFilePath,
          name: 'file',
          header: token ? { Authorization: `Bearer ${token}` } : {},
          success: resolve,
          fail: reject,
        });
      },
    );

    const body = parseUploadBody(result.data);
    if (result.statusCode !== 200 || !body) {
      toast(body?.message ?? '图片上传失败，先写文字也能提交');
      return null;
    }
    return {
      // 后端回的是相对路径；拼域名后才是能显示的地址
      src: absoluteAssetUrl(body.url) ?? body.url,
      path: body.url,
    };
  } catch {
    // 用户取消选图也走这里：静默返回，不打扰
    return null;
  }
}

/** `wx.uploadFile` 的 data 是字符串，这里统一解析并兜住非 JSON（如 502 的 HTML） */
function parseUploadBody(raw: string): {
  url: string;
  message?: string;
} | null {
  try {
    return JSON.parse(raw) as { url: string; message?: string };
  } catch {
    return null;
  }
}
