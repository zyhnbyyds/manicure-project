import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AppConfigService } from '../../../config/app-config.service.js';

/** `code2Session` 的结果：只取身份，`session_key` 一律不外传、不落库 */
export type WxSession = { openid: string; unionid: string | null };

/** `getPhoneNumber` 的结果：只取手机号本身 */
export type WxPhone = { phone: string };

/** 微信接口超时（毫秒）：避免第三方挂起拖死请求 */
const WX_FETCH_TIMEOUT_MS = 5_000;

/**
 * 微信小程序能力端口。
 *
 * 为什么要抽端口（而不是像原来那样在 service 里直接 fetch）：
 * 1. **可离线测试**：登录 / 手机号换取都依赖微信域名，测试里不可能真连；
 *    抽成端口后测试注入 `FakeWxMiniappProvider`，业务逻辑（匹配顾客、绑定、软删分支、
 *    美甲师探测）才能被真实覆盖——这也是验收项「测试 code 能换到 app token」能自动化的前提；
 * 2. **凭据未到位时不阻塞**：`WX_MINIAPP_FAKE=true` 时用假实现，UI 与业务可以先跑通。
 *
 * 假实现**在生产环境强制不可用**（见 `AppConfigService.wxMiniappFake` 与本文件构造函数双重校验）：
 * 否则只要有人改一个环境变量，任何人都能用任意手机号登录成任意顾客/美甲师。
 */
export abstract class WxMiniappProvider {
  abstract code2Session(code: string): Promise<WxSession>;
  abstract getPhoneNumber(code: string): Promise<WxPhone>;
}

/** 假实现的手机号 code 前缀：`phone-13800000001` */
export const FAKE_PHONE_PREFIX = 'phone-';

type WxCode2SessionResponse = {
  openid?: string;
  unionid?: string;
  errcode?: number;
  errmsg?: string;
};

type WxAccessTokenResponse = {
  access_token?: string;
  expires_in?: number;
  errcode?: number;
  errmsg?: string;
};

type WxPhoneResponse = {
  errcode?: number;
  errmsg?: string;
  phone_info?: { phoneNumber?: string; purePhoneNumber?: string };
};

type CachedToken = { value: string; expiresAt: number };

/**
 * 真实实现：直连微信开放接口。
 *
 * `code2Session` 不需要 access_token；但 `getPhoneNumber` 需要，
 * 而 access_token 有 2 小时有效期且**获取次数受限**，所以必须缓存。
 *
 * 注意：这里是**进程内缓存**。当前部署是单实例（pm2 单进程）没问题；
 * 若将来多实例/多副本，需换成共享缓存（Redis），否则每个实例各拉一份 token，
 * 量大时会触发微信的频率限制。这个取舍写在这里，便于将来排查「取 token 失败」。
 */
@Injectable()
export class HttpWxMiniappProvider extends WxMiniappProvider {
  private tokenCache: CachedToken | null = null;

  constructor(private readonly config: AppConfigService) {
    super();
  }

  private requireCredentials(): { appId: string; secret: string } {
    const miniapp = this.config.wxMiniapp;
    if (!miniapp.configured || !miniapp.appId || !miniapp.secret) {
      throw new ServiceUnavailableException('小程序端未启用');
    }
    return { appId: miniapp.appId, secret: miniapp.secret };
  }

  private async fetchJson<T>(url: URL, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(WX_FETCH_TIMEOUT_MS),
      });
    } catch {
      throw new ServiceUnavailableException('微信服务不可用');
    }
    if (!response.ok) throw new ServiceUnavailableException('微信服务不可用');
    return (await response.json()) as T;
  }

  /** `https://api.weixin.qq.com/sns/jscode2session` */
  async code2Session(code: string): Promise<WxSession> {
    const { appId, secret } = this.requireCredentials();
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.searchParams.set('appid', appId);
    url.searchParams.set('secret', secret);
    url.searchParams.set('js_code', code);
    url.searchParams.set('grant_type', 'authorization_code');

    const data = await this.fetchJson<WxCode2SessionResponse>(url);
    if (!data.openid) {
      throw new BadRequestException(
        data.errmsg ? `微信登录失败：${data.errmsg}` : '微信登录失败',
      );
    }
    return { openid: data.openid, unionid: data.unionid ?? null };
  }

  /** 带缓存的 access_token（提前 60 秒过期，避免边界上用到刚失效的 token） */
  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60_000) {
      return this.tokenCache.value;
    }
    const { appId, secret } = this.requireCredentials();
    const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
    url.searchParams.set('grant_type', 'client_credential');
    url.searchParams.set('appid', appId);
    url.searchParams.set('secret', secret);

    const data = await this.fetchJson<WxAccessTokenResponse>(url);
    if (!data.access_token) {
      throw new ServiceUnavailableException(
        data.errmsg ? `获取微信凭证失败：${data.errmsg}` : '获取微信凭证失败',
      );
    }
    this.tokenCache = {
      value: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
    };
    return this.tokenCache.value;
  }

  /** `https://api.weixin.qq.com/wxa/business/getuserphonenumber` */
  async getPhoneNumber(code: string): Promise<WxPhone> {
    const accessToken = await this.getAccessToken();
    const url = new URL('https://api.weixin.qq.com/wxa/business/getuserphonenumber');
    url.searchParams.set('access_token', accessToken);

    const data = await this.fetchJson<WxPhoneResponse>(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const phone = data.phone_info?.purePhoneNumber ?? data.phone_info?.phoneNumber;
    if (data.errcode || !phone) {
      throw new BadRequestException(
        data.errmsg ? `手机号获取失败：${data.errmsg}` : '手机号获取失败',
      );
    }
    return { phone };
  }
}

/**
 * 假实现：**零网络**、确定性映射，供本地开发与集成测试使用。
 *
 * - `code2Session(code)` → `openid = 'fake-openid-' + code`
 *   （同一个 code 永远同一个 openid，因此可以测「重复登录只一行」与并发首登）；
 * - `getPhoneNumber(code)` → code 本身为 11 位手机号，或 `phone-<手机号>`。
 */
@Injectable()
export class FakeWxMiniappProvider extends WxMiniappProvider {
  constructor() {
    super();
    // 双保险：即使有人把 WX_MINIAPP_FAKE 传进生产，也在这里直接拒绝启动
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'FakeWxMiniappProvider 不允许在生产环境使用：它会让任意手机号登录成任意顾客/美甲师',
      );
    }
  }

  async code2Session(code: string): Promise<WxSession> {
    if (!code) throw new BadRequestException('缺少 code');
    return { openid: `fake-openid-${code}`, unionid: null };
  }

  async getPhoneNumber(code: string): Promise<WxPhone> {
    const phone = code.startsWith(FAKE_PHONE_PREFIX)
      ? code.slice(FAKE_PHONE_PREFIX.length)
      : code;
    if (!/^1\d{10}$/.test(phone)) {
      throw new BadRequestException(
        `假实现要求 code 为 11 位手机号或 ${FAKE_PHONE_PREFIX}<手机号>`,
      );
    }
    return { phone };
  }
}
