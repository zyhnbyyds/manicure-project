import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { jwtVerify } from 'jose';
import { AppConfigService } from '../../../config/app-config.service.js';

/** app 域身份（只表示「哪个微信身份」，不代表后台账号，也没有角色 / 权限点） */
export type AppAuthUser = {
  /** `app_wx_user.id` */
  id: number;
  openid: string;
};

export type AppRequest = {
  headers: Record<string, string | string[] | undefined>;
  appUser?: AppAuthUser;
};

/**
 * 小程序端访问令牌守卫（独立 token 域，spec §8.3）。
 *
 * ## 双向拒绝的实现方式（不要改 `AccessTokenGuard`）
 *
 * 两个守卫**共用** `JWT_ACCESS_SECRET` / `issuer` / `audience`，靠 payload 形态区分：
 *
 * - 后台 token（`AuthService.issueTokens`）：payload 含 `username`、`permissions`、`roles`，
 *   **不含** `scope`；
 * - app token（`AppAuthService.login`）：payload 含 `scope: 'app'`、`openid`，
 *   **故意不含 `username`**。
 *
 * 于是：
 * - 本守卫要求 `payload.scope === 'app'` → 后台 token 打 app 接口 401；
 * - `AccessTokenGuard` 要求 `typeof payload.username === 'string'` → app token 打
 *   `/api/v1/biz/**` 自然 401（无需修改那一侧守卫）。
 *
 * ## 为什么必须有 `@Public()`
 *
 * 根模块注册的全局 `AccessTokenGuard` 先于路由级守卫执行；app controller 必须标
 * `@Public()` 跳过它，再由本守卫做真正的鉴权。app 域**不接 RBAC**：没有权限点，
 * 只有「本人数据」——所有查询强制 `customer_id = 当前绑定顾客`。
 */
@Injectable()
export class AppAccessTokenGuard implements CanActivate {
  constructor(private readonly config: AppConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AppRequest>();
    const token = request.headers.authorization
      ?.toString()
      .match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) throw new UnauthorizedException();
    try {
      const { payload } = await jwtVerify(
        token,
        new TextEncoder().encode(this.config.jwt.JWT_ACCESS_SECRET),
        {
          issuer: this.config.jwt.JWT_ISSUER,
          audience: this.config.jwt.JWT_AUDIENCE,
        },
      );
      // 独立 token 域：只接受 scope=app 的令牌（后台令牌一律 401）
      if (payload.scope !== 'app') throw new UnauthorizedException();
      const id = Number(payload.sub);
      if (!Number.isSafeInteger(id) || typeof payload.openid !== 'string')
        throw new UnauthorizedException();
      request.appUser = { id, openid: payload.openid };
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException();
    }
  }
}
