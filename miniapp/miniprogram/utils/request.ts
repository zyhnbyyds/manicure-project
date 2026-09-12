/**
 * HTTP 请求封装。
 *
 * 约定：
 * - 所有 app 域接口都带 `/app` 前缀，基址来自 `config.ts`；
 * - 登录态由 `utils/token.ts` 持有，这里只负责塞 `Authorization`；
 * - **401 + `needBind` 不清 token**：后端用这个组合表示「已登录但未绑定手机号」
 *   （spec §9.7 验收项），清掉 token 会把用户变成未登录，体验更差；
 * - **其它 401 会清登录态并自动重登一次**（见下）；
 * - `501` 统一转成「功能尚未开放」：剩余骨架（JSAPI 支付等）被点到时必须能优雅落地，
 *   不能让用户看到 `NotImplementedException`；
 * - **不把「抽象文案」透给用户**：后端 `message` 优先，但命中 HTTP 原因短语
 *   （`Unauthorized` / `Forbidden` / `Not Found` …）时一律按状态码换成中文兜底。
 *   这条是踩出来的：`new UnauthorizedException()` 不带 message 时 NestJS 回的是英文
 *   `Unauthorized`，而这里原来会**原样显示** —— 于是「没登录也能看美甲列表」这件事，
 *   用户看到的是弹一个英文单词。
 *
 * ## 为什么要有「自动重登」
 *
 * app token 的 TTL 是 **15 分钟**（后端 `expiresIn: 15m`）。原本的实现在 401 时
 * 只做 `clearAuth()`，而**没有任何地方会重新登录**（`ensureLogin()` 只在
 * `app.ts` 的 `onLaunch` 跑一次）。于是：token 一过期，每个请求都 401，
 * **用户必须杀掉小程序重开才能恢复** —— 这是真机上很容易撞到的坑。
 *
 * 现在的行为：非 `needBind` 的 401 → 清 token → **重新登录 → 原请求重试一次**；
 * 再失败才把错误交给页面。重试只做一次，避免 401 循环。
 *
 * ## 为什么用「注册回调」而不是直接 import `store/auth`
 *
 * `store/auth` → `api/index` → `utils/request`，若这里再 import `store/auth` 就成环。
 * `utils/token.ts` 开头已说明这个依赖方向问题，所以这里反转依赖：
 * 由 `store/auth` 在模块初始化时把「重新登录」注册进来。
 */
import { API_BASE, REQUEST_TIMEOUT } from '../config';
import { clearAuth, getToken } from './token';

/**
 * `wx.request` 支持的 method —— **注意没有 PATCH**：
 * 微信只提供 OPTIONS / GET / HEAD / POST / PUT / DELETE / TRACE / CONNECT。
 * app 域接口目前不含 PATCH，若将来需要，只能由后端补一个 POST 动作端点，
 * 不要在客户端硬塞 PATCH（类型层就会拦下来）。
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RequestOptions {
  /** 形如 `/app/service-items` */
  path: string;
  method?: HttpMethod;
  data?: Record<string, unknown>;
  /** 是否携带 token，默认 `true`；登录接口传 `false` */
  auth?: boolean;
}

export interface ApiErrorBody {
  /** 后端回填的请求号（见 ApiFailure.requestId） */
  requestId?: string;
  statusCode?: number;
  message?: string | string[];
  error?: string;
  needBind?: boolean;
}

/** 统一的失败对象：页面只需判断 `needBind` 与 `message` */
export class ApiFailure extends Error {
  readonly statusCode: number;
  readonly needBind: boolean;
  /**
   * 这次请求的**请求号**（排障用）。
   *
   * 请求头带 `request-id`，后端 Fastify 用同一个值当 reqId 写日志、
   * 并回填进异常响应体。用户报「付了钱但没到账」时，
   * 凭这一个号就能在服务端日志里定位到那次请求。
   */
  readonly requestId: string | null;

  constructor(
    message: string,
    statusCode: number,
    needBind = false,
    requestId: string | null = null,
  ) {
    super(message);
    this.name = 'ApiFailure';
    this.statusCode = statusCode;
    this.needBind = needBind;
    this.requestId = requestId;
  }
}

export function isApiFailure(error: unknown): error is ApiFailure {
  return error instanceof ApiFailure;
}

/**
 * 「重新登录」的注册点。
 *
 * `store/auth.ts` 在模块初始化时注册 `ensureLogin`；这样 `request.ts` 不必
 * 反向依赖 `store/auth`（会成环）。未注册时退化为旧行为（只报错，不重试）。
 */
let reauthHandler: (() => Promise<void>) | null = null;

export function setReauthHandler(handler: (() => Promise<void>) | null): void {
  reauthHandler = handler;
}

/** 从错误响应体里取后端回填的请求号 */
function requestIdOf(body: ApiErrorBody | undefined): string | null {
  return body?.requestId ?? null;
}

/** 生成一个请求号（小程序无 `crypto.randomUUID`，用时间戳 + 随机串） */
function newRequestId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * **不该给用户看的**后端文案。
 *
 * 这些是 HTTP 原因短语（NestJS / Fastify 在 `message` 缺失时的默认值），
 * 不是「后端写好的提示」。它们一旦被透出去，用户看到的就是一个英文单词 +
 * 零信息量；而「按状态码给中文兜底」几乎总是更好。
 *
 * 只列确定无信息量的固定短语，**不做**「非中文就丢」这类猜测 ——
 * 那会把将来可能的合法英文提示也一并吞掉。
 */
const ABSTRACT_MESSAGES = new Set([
  'Unauthorized',
  'Forbidden',
  'Not Found',
  'Bad Request',
  'Conflict',
  'Internal Server Error',
  'Not Implemented',
  'Method Not Allowed',
  'Payload Too Large',
  'Too Many Requests',
  'Service Unavailable',
  'Gateway Time-out',
  'Bad Gateway',
]);

/**
 * 按状态码给的人话兜底（后端没给出可用文案时用）。
 *
 * 注意「未登录（没有凭证）」与「凭证失效」是两回事：前者是用户还没进门，
 * 后者是进门凭证过期了。后端新版本会在 `message` 里区分（见
 * `app-access-token.guard.ts`），这里只是它没给文案时的兜底。
 */
function fallbackForStatus(status: number, needBind: boolean): string {
  if (needBind) return '请先绑定手机号';
  switch (status) {
    case 400:
      return '提交的内容有问题，请检查后重试';
    case 401:
      return '登录状态已失效，请重新进入小程序';
    case 403:
      return '没有权限执行这个操作';
    case 404:
      return '内容不存在或已被删除';
    case 409:
      return '操作冲突了，请刷新后重试';
    case 429:
      return '操作太频繁啦，请稍后再试';
    case 503:
      return '服务暂时不可用，请稍后再试';
    default:
      return `操作失败，请稍后再试（${status}）`;
  }
}

/** 把后端可能返回的 `string | string[]` 消息收敛成一句人话 */
function normalizeMessage(
  body: ApiErrorBody | undefined,
  fallback: string,
): string {
  const raw = body?.message;
  const text = Array.isArray(raw)
    ? raw.filter(Boolean).join('；').trim()
    : typeof raw === 'string'
      ? raw.trim()
      : '';
  // 命中原因为「后端其实没给可用文案」，交回调用方按状态码兜底
  if (text.length === 0 || ABSTRACT_MESSAGES.has(text)) return fallback;
  return text;
}

function buildQuery(data?: Record<string, unknown>): string {
  if (!data) return '';
  const parts: string[] = [];
  Object.keys(data).forEach((key) => {
    const value = data[key];
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) {
      // 后端 `serviceItemIds` 兼容逗号分隔写法，这里用逗号，URL 更短
      parts.push(
        `${encodeURIComponent(key)}=${encodeURIComponent(value.join(','))}`,
      );
      return;
    }
    parts.push(
      `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
    );
  });
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

export function request<T>(options: RequestOptions): Promise<T> {
  return send<T>(options, false);
}

/**
 * `alreadyRetried` = 本次调用是否已经因 401 重试过一次。
 * **只重试一次**：若重登后仍然 401（例如后端撤了授权），继续重试会变成死循环。
 */
function send<T>(options: RequestOptions, alreadyRetried: boolean): Promise<T> {
  const method = options.method ?? 'GET';
  const useAuth = options.auth !== false;
  const token = getToken();

  const header: Record<string, string> = {
    'content-type': 'application/json',
    // 请求号：后端用它当 reqId 写日志，并回填进异常响应体
    'request-id': newRequestId(),
  };
  if (useAuth && token) {
    header.Authorization = `Bearer ${token}`;
  }

  const isQueryMethod = method === 'GET';
  const url =
    isQueryMethod || !options.data
      ? `${API_BASE}${options.path}${buildQuery(options.data)}`
      : `${API_BASE}${options.path}`;

  return new Promise<T>((resolve, reject) => {
    wx.request({
      url,
      method,
      header,
      data: isQueryMethod ? undefined : options.data,
      timeout: REQUEST_TIMEOUT,
      success: (res) => {
        const status = res.statusCode;
        const body = res.data as T & ApiErrorBody;

        if (status >= 200 && status < 300) {
          resolve(body);
          return;
        }

        if (status === 501) {
          reject(
            new ApiFailure(
              '这个功能马上就来啦～',
              status,
              false,
              requestIdOf(body),
            ),
          );
          return;
        }

        if (status === 401) {
          const needBind = Boolean(body?.needBind);
          // `needBind` 是「已登录但未绑定手机号」，不是登录态失效 —— 不能清 token
          if (!needBind) clearAuth();
          const message = normalizeMessage(
            body,
            fallbackForStatus(status, needBind),
          );

          // token 过期/被拒：自动重新登录后原请求重试一次（见文件头说明）
          if (!needBind && !alreadyRetried && reauthHandler) {
            reauthHandler()
              .then(() => resolve(send<T>(options, true)))
              .catch(() =>
                reject(
                  new ApiFailure(message, status, false, requestIdOf(body)),
                ),
              );
            return;
          }

          reject(
            new ApiFailure(message, status, needBind, body?.requestId ?? null),
          );
          return;
        }

        if (status === 503) {
          reject(
            new ApiFailure(
              normalizeMessage(body, fallbackForStatus(status, false)),
              status,
              false,
              requestIdOf(body),
            ),
          );
          return;
        }

        reject(
          new ApiFailure(
            normalizeMessage(body, fallbackForStatus(status, false)),
            status,
            false,
            requestIdOf(body),
          ),
        );
      },
      fail: () => {
        // 网络层失败（断网 / 域名未配置 / 后端没起）统一说人话，不暴露 errMsg
        reject(new ApiFailure('网络开小差了，请稍后再试', 0));
      },
    });
  });
}
