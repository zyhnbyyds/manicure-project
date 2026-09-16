import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { jwtVerify } from 'jose';
import { AppConfigService } from '../../../config/app-config.service';
import { APP_OPTIONAL_TOKEN } from './app-optional-token.decorator';

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
 * 没带凭证时的提示。
 *
 * 这两句存在的理由很实际：守卫原来抛的是**不带 message** 的 `UnauthorizedException`，
 * NestJS 于是回默认的英文 `Unauthorized`；而小程序 `utils/request.ts` 会把后端的
 * `message` 原样显示给用户 —— 结果就是用户点开美甲列表，弹出一个英文单词。
 * 守卫是唯一知道「为什么 401」的地方，所以文案必须在这里给。
 */
const NEED_LOGIN_MESSAGE = '请先登录后再操作';
const TOKEN_INVALID_MESSAGE = '登录状态已失效，请重新进入小程序';

function unauthorized(message: string): UnauthorizedException {
  return new UnauthorizedException({ statusCode: 401, message });
}

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
 *
 * ## 访客可浏览（`@AppOptionalToken()`）
 *
 * 标了这个装饰器的路由允许**没有凭证的访客**通过（项目 / 美甲师 / 可约时段这类
 * 谁看都一样的只读数据，见 `app-optional-token.decorator.ts`）。
 * 「没带凭证」放行、「带了凭证」仍严格校验 —— 双向拒绝的红线不受影响。
 */
@Injectable()
export class AppAccessTokenGuard implements CanActivate {
  constructor(
    private readonly config: AppConfigService,
    private readonly reflector: Reflector,
  ) {}

  /** 该路由是否允许访客（无凭证）访问 */
  private allowsGuest(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(APP_OPTIONAL_TOKEN, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AppRequest>();
    const token = request.headers.authorization
      ?.toString()
      .match(/^Bearer\s+(.+)$/i)?.[1];

    // 没带凭证：访客可直接浏览只读数据，其余接口给出「该怎么办」而不是英文单词
    if (!token) {
      if (this.allowsGuest(context)) return true;
      throw unauthorized(NEED_LOGIN_MESSAGE);
    }

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
      if (payload.scope !== 'app') throw new Error('scope 不是 app');
      const id = Number(payload.sub);
      if (!Number.isSafeInteger(id) || typeof payload.openid !== 'string')
        throw new Error('payload 形态不对');
      request.appUser = { id, openid: payload.openid };
      return true;
    } catch {
      // 过期 / 签名不对 / 后台 token 打过来 —— 小程序会自动静默重登并重试一次
      throw unauthorized(TOKEN_INVALID_MESSAGE);
    }
  }
}
