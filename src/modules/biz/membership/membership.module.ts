import { Module } from '@nestjs/common';
import { CardTypesController } from './card-types/card-types.controller';
import { CardTypesService } from './card-types/card-types.service';
import { MemberLevelsController } from './member-levels/member-levels.controller';
import { MemberLevelsService } from './member-levels/member-levels.service';
import { MemberAccountsService } from './member-accounts/member-accounts.service';
import { MemberCardsController } from './member-cards/member-cards.controller';
import { MemberCardsService } from './member-cards/member-cards.service';
import { MembersController } from './members/members.controller';
import { PointsController } from './points/points.controller';
import { PointsGoodsController } from './points-goods/points-goods.controller';
import { CouponsController } from './coupons/coupons.controller';
import { PointsGoodsService } from './points-goods/points-goods.service';
import { CouponsService } from './coupons/coupons.service';
import { RechargePlansController } from './recharge-plans/recharge-plans.controller';
import { RechargePlansService } from './recharge-plans/recharge-plans.service';

/**
 * B2 会员体系（等级 / 充值方案 / 卡种 / 会员账务 / 次卡 / 积分兑换）。
 *
 * `MemberAccountsService` 与 `MemberCardsService` 必须导出：根模块 `BizModule`（@Global）
 * 用 `useExisting` 把它们绑到 `MemberAccountPort` / `MemberCardPort` 上，其它模块只依赖端口。
 */
@Module({
  controllers: [
    MemberLevelsController,
    RechargePlansController,
    CardTypesController,
    MembersController,
    MemberCardsController,
    PointsGoodsController,
    CouponsController,
    PointsController,
  ],
  providers: [
    MemberLevelsService,
    RechargePlansService,
    CardTypesService,
    MemberAccountsService,
    MemberCardsService,
    PointsGoodsService,
    CouponsService,
  ],
  exports: [
    MemberLevelsService,
    RechargePlansService,
    CardTypesService,
    MemberAccountsService,
    MemberCardsService,
    PointsGoodsService,
    CouponsService,
  ],
})
export class MembershipModule {}
