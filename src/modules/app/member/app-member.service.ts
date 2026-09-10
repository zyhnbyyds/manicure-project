import { Injectable, UnauthorizedException } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { DatabaseService } from '../../../database/database.service.js';
import {
  appWxUsers,
  bizCustomers,
  bizMemberCards,
  bizMemberLevels,
} from '../../../database/schema/index.js';
import { MemberAccountPort } from '../../biz/common/ports.js';
import type { AppMemberCardVo, AppMemberMeVo } from '../dto/app-vo.js';

/** 未绑定手机号：401 且响应体带 `needBind: true`（小程序据此拉起授权弹窗，§16.2） */
function needBind(): UnauthorizedException {
  return new UnauthorizedException({
    message: '请先绑定手机号',
    needBind: true,
  });
}

/**
 * app 域会员中心（spec §9.7 `/app/member/me`）。
 *
 * - app 域**不接 RBAC**：所有数据强制来自 token 对应的 `app_wx_user.customer_id`，
 *   不接受任何来自客户端的顾客 ID（防越权查别人）；
 * - 余额 / 积分 / 折扣率以 `MemberAccountPort`（会员账务）为单一事实来源；
 * - 所有查询**逐个字段显式 select**，响应再投影成 `AppMemberMeVo`，
 *   绝不出现 totalSpent / memberNo / remark / createdBy 等内部字段。
 */
@Injectable()
export class AppMemberService {
  constructor(
    private readonly database: DatabaseService,
    private readonly members: MemberAccountPort,
  ) {}

  async me(appUserId: number): Promise<AppMemberMeVo> {
    const [identity] = await this.database.db
      .select({ id: appWxUsers.id, customerId: appWxUsers.customerId })
      .from(appWxUsers)
      .where(eq(appWxUsers.id, appUserId))
      .limit(1);
    if (!identity) throw new UnauthorizedException();
    if (identity.customerId === null) throw needBind();
    const customerId = identity.customerId;

    const [customer] = await this.database.db
      .select({
        id: bizCustomers.id,
        name: bizCustomers.name,
        phone: bizCustomers.phone,
      })
      .from(bizCustomers)
      .where(
        and(eq(bizCustomers.id, customerId), isNull(bizCustomers.deletedAt)),
      )
      .limit(1);
    // 顾客档案被软删 / 已不存在：按「需要重新绑定手机号」处理
    if (!customer) throw needBind();

    // 算价上下文 = 等级 + 折扣率千分比 + 积分 + 储值余额（无等级时折扣率 = 1000）
    const context = await this.members.getPricingContext(customerId);

    let levelName: string | null = null;
    if (context.levelId !== null) {
      const [level] = await this.database.db
        .select({ name: bizMemberLevels.name })
        .from(bizMemberLevels)
        .where(eq(bizMemberLevels.id, context.levelId))
        .limit(1);
      levelName = level?.name ?? null;
    }

    const cards = await this.database.db
      .select({
        id: bizMemberCards.id,
        cardNo: bizMemberCards.cardNo,
        cardName: bizMemberCards.cardName,
        totalTimes: bizMemberCards.totalTimes,
        usedTimes: bizMemberCards.usedTimes,
        expireAt: bizMemberCards.expireAt,
        status: bizMemberCards.status,
      })
      .from(bizMemberCards)
      .where(
        and(
          eq(bizMemberCards.customerId, customerId),
          isNull(bizMemberCards.deletedAt),
        ),
      )
      .orderBy(desc(bizMemberCards.id));

    return {
      customerId,
      name: customer.name,
      phone: customer.phone,
      levelName,
      discountPermille: context.levelDiscountPermille,
      points: context.points,
      balancePrincipal: context.balancePrincipal,
      balanceBonus: context.balanceBonus,
      cards: cards.map(mapCard),
    };
  }
}

function mapCard(card: {
  id: number;
  cardNo: string;
  cardName: string;
  totalTimes: number;
  usedTimes: number;
  expireAt: Date | null;
  status: 'active' | 'used_up' | 'expired' | 'refunded';
}): AppMemberCardVo {
  return {
    id: card.id,
    cardNo: card.cardNo,
    cardName: card.cardName,
    totalTimes: card.totalTimes,
    usedTimes: card.usedTimes,
    expireAt: card.expireAt ? card.expireAt.toISOString() : null,
    status: card.status,
  };
}
