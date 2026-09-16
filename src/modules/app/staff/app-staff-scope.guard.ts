import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DatabaseService } from '../../../database/database.service';
import { appWxUsers, bizStaffs } from '../../../database/schema/index';
import {
  AppAccessTokenGuard,
  type AppAuthUser,
  type AppRequest,
} from '../auth/app-access-token.guard';

export type AppStaffAuthUser = AppAuthUser & {
  staffId: number;
};

export type AppStaffRequest = AppRequest & {
  appStaff?: AppStaffAuthUser;
};

/**
 * 美甲师工作台作用域守卫。
 *
 * 不读 token 里的角色，也不相信 `app_wx_user.staff_status` 单列：每次请求都重新查
 * `app_wx_user + biz_staff`，同时要求身份 active、档案 active、档案未软删。
 * 店长撤权 / 停用 / 删除后，下一次请求立即失效。
 */
@Injectable()
export class AppStaffScopeGuard implements CanActivate {
  constructor(private readonly database: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AppStaffRequest>();
    const appUser = request.appUser;
    if (!appUser) throw new UnauthorizedException();

    const [row] = await this.database.db
      .select({
        staffId: appWxUsers.staffId,
        staffStatus: appWxUsers.staffStatus,
      })
      .from(appWxUsers)
      .innerJoin(bizStaffs, eq(appWxUsers.staffId, bizStaffs.id))
      .where(
        and(
          eq(appWxUsers.id, appUser.id),
          isNull(appWxUsers.deletedAt),
          eq(appWxUsers.staffStatus, 'active'),
          eq(bizStaffs.status, 'active'),
          isNull(bizStaffs.deletedAt),
        ),
      )
      .limit(1);

    if (!row?.staffId || row.staffStatus !== 'active')
      throw new ForbiddenException('美甲师工作台未开通或已失效');

    request.appStaff = { ...appUser, staffId: row.staffId };
    return true;
  }
}

/**
 * 组合守卫导出：后续 `/app/staff/**` controller 直接使用这个，保证先验 app token
 * 再验每请求的美甲师数据作用域。保留单独的 `AppStaffScopeGuard` 便于单测。
 */
export const APP_STAFF_GUARDS = [
  AppAccessTokenGuard,
  AppStaffScopeGuard,
] as const;
