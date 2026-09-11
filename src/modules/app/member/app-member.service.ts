import { Injectable, UnauthorizedException } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { DatabaseService } from '../../../database/database.service.js';
import {
  appWxUsers,
  bizCustomers,
  bizMemberCards,
  bizMemberLevels,
} from '../../../database/schema/index.js';
import {
  MemberAccountPort,
  MemberCardPort,
  type MemberCardRow,
  ReviewPort,
} from '../../biz/common/ports.js';
import { parsePagination } from '../../biz/common/query.js';
import type {
  AppMemberCardListVo,
  AppMemberCardVo,
  AppMemberMeVo,
  AppReviewVo,
} from '../dto/app-vo.js';

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
    private readonly memberCards: MemberCardPort,
    private readonly reviews: ReviewPort,
  ) {}

  /**
   * 取当前身份绑定的顾客 ID：**唯一的归属来源**。
   *
   * 客户端传什么都不好使（app 域不接 RBAC，也不接顾客 ID 入参），
   * 越权面因此只剩这一处，改这里就等于改全app 域的口径。
   */
  private async requireCustomerId(appUserId: number): Promise<number> {
    const [identity] = await this.database.db
      .select({ id: appWxUsers.id, customerId: appWxUsers.customerId })
      .from(appWxUsers)
      .where(and(eq(appWxUsers.id, appUserId), isNull(appWxUsers.deletedAt)))
      .limit(1);
    if (!identity) throw new UnauthorizedException();
    if (identity.customerId === null) throw needBind();
    return identity.customerId;
  }

  async me(appUserId: number): Promise<AppMemberMeVo> {
    const customerId = await this.requireCustomerId(appUserId);

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
      cards: cards.map((row) => mapCard(row, displayCardStatus(row))),
    };
  }

  /**
   * 我的次卡（A9）。
   *
   * 与 `me` 一样：`customerId` 只从 token 对应的身份来，维度只有「本人」。
   * 状态用 `displayCardStatus` 现算，**与后台 `assertUsable` 的可用性判定同一套规则**——
   * 否则定时任务还没跑时，顾客会看到一张其实已经不能用的「可用」卡。
   */
  async cards(
    appUserId: number,
    query: {
      status?: string | undefined;
      page?: number | undefined;
      pageSize?: number | undefined;
    },
  ): Promise<AppMemberCardListVo> {
    const customerId = await this.requireCustomerId(appUserId);
    const { page, pageSize, offset } = parsePagination(
      query.page,
      query.pageSize,
    );

    const rows = await this.memberCards.listByCustomer(customerId);
    const filtered = query.status
      ? rows.filter((row) => displayCardStatus(row) === query.status)
      : rows;

    return {
      items: filtered
        .slice(offset, offset + pageSize)
        .map((row) => mapCard(row, displayCardStatus(row))),
      page,
      pageSize,
    };
  }

  /**
   * 提交服务评价（A11）。
   *
   * 三道约束全在服务端：**仅本人**（`ReviewPort.createForCustomer` 按预约事实校验归属）、
   * **仅已完成**（未完成 → 400）、**一单一评**（二次 → 409）。
   * 客户端能决定的只有「打分与文字」，`customer_id` / `staff_id` 一律由预约事实带出。
   */
  async createReview(
    appUserId: number,
    input: {
      bookingId: number;
      rating: number;
      content?: string | undefined;
      images?: string[] | undefined;
    },
  ): Promise<AppReviewVo> {
    const customerId = await this.requireCustomerId(appUserId);
    const created = await this.reviews.createForCustomer(
      customerId,
      {
        bookingId: input.bookingId,
        score: input.rating,
        ...(input.content === undefined ? {} : { content: input.content }),
        ...(input.images === undefined ? {} : { images: input.images }),
      },
      null,
    );
    return {
      id: created.id,
      bookingId: input.bookingId,
      rating: input.rating,
      content: input.content ?? null,
      createdAt: created.createdAt.toISOString(),
    };
  }
}

/**
 * 次卡的**展示态**，规则与 `MemberCardPort.assertUsable` 逐条对齐
 * （退卡 → 已过期 → 次数用完 → 过了有效期）。
 *
 * 只影响展示，不写库：翻转状态是定时任务 `expireCards()` 的事，
 * 这里保证的是「顾客看到的可用性」与「到店真能用」一致。
 */
function displayCardStatus(
  card: Pick<
    MemberCardRow,
    'status' | 'expireAt' | 'usedTimes' | 'totalTimes'
  >,
): 'active' | 'used_up' | 'expired' | 'refunded' {
  if (card.status === 'refunded') return 'refunded';
  if (card.status === 'expired') return 'expired';
  if (card.status === 'used_up' || card.usedTimes >= card.totalTimes)
    return 'used_up';
  if (card.expireAt !== null && card.expireAt.getTime() <= Date.now())
    return 'expired';
  return 'active';
}

function mapCard(
  card: {
    id: number;
    cardNo: string;
    cardName: string;
    totalTimes: number;
    usedTimes: number;
    expireAt: Date | null;
  },
  status: 'active' | 'used_up' | 'expired' | 'refunded',
): AppMemberCardVo {
  return {
    id: card.id,
    cardNo: card.cardNo,
    cardName: card.cardName,
    totalTimes: card.totalTimes,
    usedTimes: card.usedTimes,
    expireAt: card.expireAt ? card.expireAt.toISOString() : null,
    status,
  };
}
