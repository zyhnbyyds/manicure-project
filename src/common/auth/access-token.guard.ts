import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { jwtVerify } from 'jose';
import { AppConfigService } from '../../config/app-config.service';
import { STORE_HEADER } from '../data-scope/data-scope';
import { IS_PUBLIC } from './public.decorator';
import { REQUIRED_PERMISSIONS } from './permissions.decorator';

type RequestUser = {
  id: number;
  username: string;
  permissions: string[];
  roles: string[];
  /** 当前门店（`x-store-id` 头，后台门店切换器）；非法值一律忽略，当没传 */
  storeId?: number | undefined;
};

/**
 * 解析 `x-store-id`：只接受正安全整数，其它（空串 / 非数字 / 负数 / 小数）一律当没传。
 *
 * 这里**不校验门店是否存在、是否可见**：那是 `resolveStoreScope` 的职责，
 * 守卫只负责「把请求里的这个东西变成数字」。
 */
function parseStoreHeader(
  raw: string | string[] | undefined,
): number | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
type RequestWithUser = {
  headers: Record<string, string | string[] | undefined>;
  user?: RequestUser;
};

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: AppConfigService,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const request = context.switchToHttp().getRequest<RequestWithUser>();
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
      const id = Number(payload.sub);
      if (!Number.isSafeInteger(id) || typeof payload.username !== 'string')
        throw new UnauthorizedException();
      request.user = {
        id,
        username: payload.username,
        permissions: Array.isArray(payload.permissions)
          ? payload.permissions.filter(
              (value): value is string => typeof value === 'string',
            )
          : [],
        roles: Array.isArray(payload.roles)
          ? payload.roles.filter(
              (value): value is string => typeof value === 'string',
            )
          : [],
        // 门店切换器的「当前门店」：由 resolveStoreScope 复核可见性后再用
        storeId: parseStoreHeader(request.headers[STORE_HEADER]),
      };
      const required =
        this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS, [
          context.getHandler(),
          context.getClass(),
        ]) ?? [];
      if (
        required.length &&
        !required.some(
          (permission) =>
            request.user?.permissions.includes(permission) ||
            request.user?.permissions.includes('*:*:*'),
        )
      )
        throw new UnauthorizedException('权限不足');
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException();
    }
  }
}
