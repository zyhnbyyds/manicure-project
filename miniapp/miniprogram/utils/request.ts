/**
 * HTTP 请求封装。
 *
 * 约定：
 * - 所有 app 域接口都带 `/app` 前缀，基址来自 `config.ts`；
 * - 登录态由 `utils/token.ts` 持有，这里只负责塞 `Authorization`；
 * - **401 + `needBind` 不清 token**：后端用这个组合表示「已登录但未绑定手机号」
 *   （spec §9.7 验收项），清掉 token 会把用户变成未登录，体验更差；
 * - 其它 401 才清登录态（token 过期/被拒）；
 * - `501` 统一转成「功能尚未开放」：本期 9 个写接口是契约骨架，前端必须能优雅落地，
 *   不能让用户看到 `NotImplementedException`。
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
  statusCode?: number;
  message?: string | string[];
  error?: string;
  needBind?: boolean;
}

/** 统一的失败对象：页面只需判断 `needBind` 与 `message` */
export class ApiFailure extends Error {
  readonly statusCode: number;
  readonly needBind: boolean;

  constructor(message: string, statusCode: number, needBind = false) {
    super(message);
    this.name = 'ApiFailure';
    this.statusCode = statusCode;
    this.needBind = needBind;
  }
}

export function isApiFailure(error: unknown): error is ApiFailure {
  return error instanceof ApiFailure;
}

/** 把后端可能返回的 `string | string[]` 消息收敛成一句人话 */
function normalizeMessage(body: ApiErrorBody | undefined, fallback: string): string {
  const raw = body?.message;
  if (Array.isArray(raw)) return raw.filter(Boolean).join('；') || fallback;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return fallback;
}

function buildQuery(data?: Record<string, unknown>): string {
  if (!data) return '';
  const parts: string[] = [];
  Object.keys(data).forEach((key) => {
    const value = data[key];
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) {
      // 后端 `serviceItemIds` 兼容逗号分隔写法，这里用逗号，URL 更短
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value.join(','))}`);
      return;
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  });
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

export function request<T>(options: RequestOptions): Promise<T> {
  const method = options.method ?? 'GET';
  const useAuth = options.auth !== false;
  const token = getToken();

  const header: Record<string, string> = { 'content-type': 'application/json' };
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
          reject(new ApiFailure('这个功能马上就来啦～', status));
          return;
        }

        if (status === 401) {
          const needBind = Boolean(body?.needBind);
          if (!needBind) clearAuth();
          reject(
            new ApiFailure(
              normalizeMessage(body, needBind ? '请先绑定手机号' : '登录已过期，请重新进入'),
              status,
              needBind,
            ),
          );
          return;
        }

        if (status === 503) {
          reject(new ApiFailure(normalizeMessage(body, '服务暂时不可用'), status));
          return;
        }

        reject(new ApiFailure(normalizeMessage(body, `请求失败（${status}）`), status));
      },
      fail: () => {
        // 网络层失败（断网 / 域名未配置 / 后端没起）统一说人话，不暴露 errMsg
        reject(new ApiFailure('网络开小差了，请稍后再试', 0));
      },
    });
  });
}
