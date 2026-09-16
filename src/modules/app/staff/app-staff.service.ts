import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DatabaseService } from '../../../database/database.service';
import { appWxUsers } from '../../../database/schema/index';
import { BizConfigService } from '../../biz/common/biz-config.service';
import { StaffPort } from '../../biz/common/ports';
import { appIso, appIsoOrNull, appShopTimeZone } from '../common/app-time';
import type { AppStaffApplyVo } from '../dto/app-vo';

/** 小程序美甲师申请：只能由手机号命中的在职档案发起，店长确认才 active。 */
@Injectable()
export class AppStaffService {
  constructor(
    private readonly database: DatabaseService,
    private readonly staffs: StaffPort,
    /** 只用于取店内时区：app 域时刻必须带偏移，见 `../common/app-time.ts` */
    private readonly bizConfig: BizConfigService,
  ) {}

  /** 店内时区（`biz.booking.timezone`，默认 `Asia/Shanghai`） */
  private async shopTimeZone(): Promise<string> {
    return appShopTimeZone(this.bizConfig);
  }

  async apply(appUserId: number): Promise<AppStaffApplyVo> {
    const tz = await this.shopTimeZone();
    const [identity] = await this.database.db
      .select({
        id: appWxUsers.id,
        phone: appWxUsers.phone,
        staffId: appWxUsers.staffId,
        staffStatus: appWxUsers.staffStatus,
        staffRequestedAt: appWxUsers.staffRequestedAt,
      })
      .from(appWxUsers)
      .where(and(eq(appWxUsers.id, appUserId), isNull(appWxUsers.deletedAt)))
      .limit(1);
    if (!identity) throw new NotFoundException('小程序身份不存在，请重新登录');
    if (!identity.phone)
      throw new BadRequestException('请先完成手机号授权，再申请美甲师工作台');

    const staff = await this.staffs.findByPhone(identity.phone);
    if (!staff || staff.deletedAt || staff.status !== 'active')
      throw new BadRequestException(
        '该手机号未匹配到在职美甲师档案，请联系门店处理',
      );

    if (identity.staffStatus === 'active') {
      if (identity.staffId !== staff.id)
        throw new ConflictException(
          '当前美甲师授权与手机号档案不一致，请联系门店处理',
        );
      return {
        staffId: staff.id,
        staffStatus: 'active',
        staffRequestedAt: appIsoOrNull(identity.staffRequestedAt, tz),
      };
    }

    if (identity.staffStatus === 'pending' && identity.staffId === staff.id) {
      return {
        staffId: staff.id,
        staffStatus: 'pending',
        staffRequestedAt: appIsoOrNull(identity.staffRequestedAt, tz),
      };
    }

    const requestedAt = new Date();
    await this.database.db
      .update(appWxUsers)
      .set({
        staffId: staff.id,
        staffStatus: 'pending',
        staffRequestedAt: requestedAt,
        staffDecidedAt: null,
        staffDecidedBy: null,
      })
      .where(and(eq(appWxUsers.id, appUserId), isNull(appWxUsers.deletedAt)));

    return {
      staffId: staff.id,
      staffStatus: 'pending',
      staffRequestedAt: appIso(requestedAt, tz),
    };
  }
}
