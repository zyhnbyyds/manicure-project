import { Module } from '@nestjs/common';
import { CardTypesController } from './card-types/card-types.controller.js';
import { CardTypesService } from './card-types/card-types.service.js';
import { MemberLevelsController } from './member-levels/member-levels.controller.js';
import { MemberLevelsService } from './member-levels/member-levels.service.js';
import { MemberAccountsService } from './member-accounts/member-accounts.service.js';
import { MemberCardsController } from './member-cards/member-cards.controller.js';
import { MemberCardsService } from './member-cards/member-cards.service.js';
import { MembersController } from './members/members.controller.js';
import { PointsController } from './points/points.controller.js';
import { PointsGoodsController } from './points-goods/points-goods.controller.js';
import { PointsGoodsService } from './points-goods/points-goods.service.js';
import { RechargePlansController } from './recharge-plans/recharge-plans.controller.js';
import { RechargePlansService } from './recharge-plans/recharge-plans.service.js';

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
    PointsController,
  ],
  providers: [
    MemberLevelsService,
    RechargePlansService,
    CardTypesService,
    MemberAccountsService,
    MemberCardsService,
    PointsGoodsService,
  ],
  exports: [
    MemberLevelsService,
    RechargePlansService,
    CardTypesService,
    MemberAccountsService,
    MemberCardsService,
    PointsGoodsService,
  ],
})
export class MembershipModule {}
