import { API_BASE } from '../config';
import { absoluteAssetUrl } from './asset-url';
import { getToken } from './token';
import { toast } from './ui';

/** 上传接口（app token 域；后台的 `/files/upload` 走的是后台 token，小程序打过去会 401） */
const UPLOAD_PATH = '/app/upload';

/** 图片压缩目标：1MB（与后端 `src/modules/files/image-compress.ts` 同口径） */
const IMAGE_MAX_BYTES = 1024 * 1024;

/**
 * `wx.compressImage` 的质量档（从高到低，够小就停）。
 *
 * 微信的 `quality` 是「质量百分比」，不是「压缩比」—— 82 已经能砍掉手机原图的大半体积，
 * 再低的档位是给夜景 / 高像素照片（纹理多、难压）兜底的。
 */
const COMPRESS_QUALITIES = [82, 70, 60, 50];

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
 * ## 上传前先压一遍
 *
 * `wx.chooseMedia` 的 `sizeType: ['compressed']` 是微信自己的策略，高像素机型压完仍有 2~4MB；
 * 这里再用 `wx.compressImage` 逐档降到 1MB 以下（见 `shrinkForUpload`）——
 * 顾客多在移动网络，少传几 MB 比什么都实在。
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

    // 先在本端压到 1MB 以下再传（压不动就传原图，后端还有一道兜底）
    const filePath = await shrinkForUpload(file.tempFilePath, file.size);

    const token = getToken();
    const result =
      await new Promise<WechatMiniprogram.UploadFileSuccessCallbackResult>(
        (resolve, reject) => {
          wx.uploadFile({
            url: `${API_BASE}${UPLOAD_PATH}`,
            filePath,
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

/**
 * 把图片压到 1MB 以下，返回可以上传的本地路径。
 *
 * ⚠️ **`wx.compressImage` 只对 jpg 有效**（png 会原样返回），所以这条路不保证一定压得动 ——
 * 压不小就返回已经变小的那一版（都比原图小），一档都压不动则返回原路径，
 * 剩下的交给后端 `image-compress.ts`。**这里永远不该因为压缩失败而让上传失败。**
 */
async function shrinkForUpload(
  filePath: string,
  originalSize: number,
): Promise<string> {
  if (originalSize <= IMAGE_MAX_BYTES) return filePath;
  let best = filePath;
  let bestSize = originalSize;
  for (const quality of COMPRESS_QUALITIES) {
    try {
      // 每档都从**原图**重压（质量是绝对的，不需要在前一次结果上叠加）
      const { tempFilePath } = await wx.compressImage({
        src: filePath,
        quality,
      });
      const size = await fileSizeOf(tempFilePath);
      if (size > 0 && size < bestSize) {
        best = tempFilePath;
        bestSize = size;
      }
      if (bestSize <= IMAGE_MAX_BYTES) break;
    } catch {
      // 基础库太老 / 格式不支持：直接放弃压缩，别把上传拖挂
      break;
    }
  }
  return best;
}

/** 读临时文件大小（`wx.compressImage` 只回路径，不给大小）；拿不到就当 0（= 不采用） */
function fileSizeOf(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    wx.getFileSystemManager().stat({
      path: filePath,
      success: (res) => resolve(Array.isArray(res.stats) ? 0 : res.stats.size),
      fail: () => resolve(0),
    });
  });
}
