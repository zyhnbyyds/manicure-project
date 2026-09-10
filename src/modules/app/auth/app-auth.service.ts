import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { AppConfigService } from '../../../config/app-config.service.js';
import { DatabaseService } from '../../../database/database.service.js';
import { appWxUsers } from '../../../database/schema/index.js';
import type { AppLoginRequest, AppLoginVo } from '../dto/app-vo.js';

/** `https://api.weixin.qq.com/sns/jscode2session` 的成功/失败应答 */
type WxCode2SessionResponse = {
  openid?: string;
  unionid?: string;
  session_key?: string;
  errcode?: number;
  errmsg?: string;
};

/** 微信接口超时（毫秒）：避免第三方挂起拖死请求 */
const WX_FETCH_TIMEOUT_MS = 5_000;

/**
 * 小程序端认证（spec §16.2）。
 *
 * 只做一件事：`code` → `openid` → upsert `app_wx_user`（openid 唯一，重复登录不产生第二条
 * 身份记录，只刷新 `last_login_at`）→ 签发 app token（`scope: 'app'`）。
 *
 * 手机号绑定（`/app/auth/phone`）本期只留契约骨架，见 `AppAuthController`。
 */
@Injectable()
export class AppAuthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: AppConfigService,
  ) {}

  async login(input: AppLoginRequest): Promise<AppLoginVo> {
    const now = new Date();
    const session = await this.code2Session(input.code);

    // upsert：openid 唯一索引 + ON DUPLICATE KEY UPDATE，
    // 并发登录也不会产生第二条身份记录（幂等）
    await this.database.db
      .insert(appWxUsers)
      .values({
        openid: session.openid,
        unionid: session.unionid,
        nickname: input.nickname ?? null,
        avatar: input.avatar ?? null,
        lastLoginAt: now,
      })
      .onDuplicateKeyUpdate({
        set: {
          lastLoginAt: now,
          ...(session.unionid ? { unionid: session.unionid } : {}),
          ...(input.nickname ? { nickname: input.nickname } : {}),
          ...(input.avatar ? { avatar: input.avatar } : {}),
        },
      });

    const [identity] = await this.database.db
      .select({
        id: appWxUsers.id,
        openid: appWxUsers.openid,
        customerId: appWxUsers.customerId,
      })
      .from(appWxUsers)
      .where(eq(appWxUsers.openid, session.openid))
      .limit(1);
    if (!identity) throw new ServiceUnavailableException('小程序端登录失败');

    return {
      accessToken: await this.signAppToken(identity.id, identity.openid),
      tokenType: 'Bearer',
      expiresIn: this.config.jwt.JWT_ACCESS_TTL,
      customerId: identity.customerId,
    };
  }

  /**
   * code2Session：未配置微信凭据时返回 503「小程序端未启用」
   * （而不是让进程起不来，见 §16.1）。
   */
  private async code2Session(
    code: string,
  ): Promise<{ openid: string; unionid: string | null }> {
    const miniapp = this.config.wxMiniapp;
    if (!miniapp.configured)
      throw new ServiceUnavailableException('小程序端未启用');

    const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.searchParams.set('appid', miniapp.appId ?? '');
    url.searchParams.set('secret', miniapp.secret ?? '');
    url.searchParams.set('js_code', code);
    url.searchParams.set('grant_type', 'authorization_code');

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(WX_FETCH_TIMEOUT_MS),
      });
    } catch {
      throw new ServiceUnavailableException('微信登录服务不可用');
    }
    if (!response.ok)
      throw new ServiceUnavailableException('微信登录服务不可用');

    const data = (await response.json()) as WxCode2SessionResponse;
    if (!data.openid)
      throw new UnauthorizedException(
        data.errmsg ? `微信登录失败：${data.errmsg}` : '微信登录失败',
      );
    return { openid: data.openid, unionid: data.unionid ?? null };
  }

  /**
   * 签发 app 域 access token。
   *
   * - 与后台共用 `JWT_ACCESS_SECRET` / `issuer` / `audience`（配置复用）；
   * - payload 带 `scope: 'app'` → `AppAccessTokenGuard` 才认；
   * - **故意不写 `username`** → 后台 `AccessTokenGuard` 因
   *   `typeof payload.username === 'string'` 不成立而自然拒绝（双向隔离，见 §8.3）。
   */
  private async signAppToken(
    appUserId: number,
    openid: string,
  ): Promise<string> {
    return new SignJWT({ scope: 'app', openid })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(appUserId))
      .setIssuedAt()
      .setIssuer(this.config.jwt.JWT_ISSUER)
      .setAudience(this.config.jwt.JWT_AUDIENCE)
      .setExpirationTime(this.config.jwt.JWT_ACCESS_TTL)
      .sign(new TextEncoder().encode(this.config.jwt.JWT_ACCESS_SECRET));
  }
}
