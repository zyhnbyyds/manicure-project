import {
  Body,
  Controller,
  NotImplementedException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../../common/auth/public.decorator.js';
import {
  appBindPhoneRequestSchema,
  appLoginRequestSchema,
} from '../dto/app-vo.js';
import { AppAccessTokenGuard } from './app-access-token.guard.js';
import { AppAuthService } from './app-auth.service.js';

/**
 * 小程序端认证（`/api/v1/app/auth`）。
 *
 * 整个 controller 标 `@Public()`：跳过根模块的全局后台守卫 `AccessTokenGuard`，
 * 再按接口分别决定是否需要 app token —— login 公开，phone 用 `AppAccessTokenGuard`。
 * app 域**不接 RBAC**：没有权限点，只有「本人数据」。
 *
 * 限流：基线在 `src/main.ts` 里 `app.register(rateLimit, { max: 100, timeWindow: '1 minute' })`
 * 注册了全局 `@fastify/rate-limit`；这里用 `@nestjs/platform-fastify` 的 `@RouteConfig`
 * 把登录接口收紧到 **10 次/分钟/IP**（`@fastify/rate-limit` 读取 route 的
 * `config.rateLimit` 做单路由覆盖），无需改动 `src/main.ts`。
 */
@ApiTags('小程序端')
@Public()
@Controller('app/auth')
export class AppAuthController {
  constructor(private readonly auth: AppAuthService) {}

  @Post('login')
  @RouteConfig({ rateLimit: { max: 10, timeWindow: '1 minute' } })
  @ApiOperation({
    summary: '小程序登录（wx.login 的 code 换 openid 并签发 app token）',
    description:
      '未配置 WX_MINIAPP_APPID / WX_MINIAPP_SECRET 时返回 503「小程序端未启用」。' +
      '同一 openid 重复登录不会产生第二条身份记录，只刷新 last_login_at。',
  })
  @ApiBody({ schema: { $ref: '#/components/schemas/AppLoginRequest' } })
  @ApiResponse({
    status: 200,
    description: '成功',
    schema: { $ref: '#/components/schemas/AppLoginVo' },
  })
  @ApiResponse({ status: 401, description: 'code 无效' })
  @ApiResponse({ status: 503, description: '小程序端未启用' })
  login(@Body() body: unknown) {
    return this.auth.login(appLoginRequestSchema.parse(body));
  }

  @Post('phone')
  @UseGuards(AppAccessTokenGuard)
  @ApiBearerAuth('app-token')
  @ApiOperation({
    summary: '手机号绑定（契约骨架，本期返回 501）',
    description:
      'getPhoneNumber 的 code 换手机号 → 匹配 / 创建 biz_customer（命中软删走恢复确认）' +
      ' → 回填 app_wx_user.customer_id 与 phone。本期只落契约，不落库。',
  })
  @ApiBody({ schema: { $ref: '#/components/schemas/AppBindPhoneRequest' } })
  @ApiResponse({
    status: 401,
    description: '未登录（缺少 / 非法的 app token）',
  })
  @ApiResponse({ status: 501, description: '本期未实现' })
  phone(@Body() body: unknown): never {
    // 契约校验照常执行（保证 Swagger 文档与实际入参一致），然后返回 501
    appBindPhoneRequestSchema.parse(body);
    throw new NotImplementedException('手机号绑定将在 P2 小程序端实现');
  }
}
