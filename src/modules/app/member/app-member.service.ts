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
  BookingPort,
  MemberAccountPort,
  MemberCardPort,
  type MemberCardRow,
  NoticePort,
  PointsGoodsPort,
  type BookingWithItems,
  ReviewPort,
} from '../../biz/common/ports.js';
import { parsePagination } from '../../biz/common/query.js';
import type {
  AppBookingListVo,
  AppBookingVo,
  AppCancelBookingVo,
  AppCreateBookingVo,
  AppMemberCardListVo,
  AppMemberCardVo,
  AppMemberMeVo,
  AppPointsGoodsListVo,
  AppPointsRedeemVo,
  AppReviewVo,
  AppSubscribeVo,
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
    private readonly notices: NoticePort,
    private readonly bookingPort: BookingPort,
    private readonly pointsGoods: PointsGoodsPort,
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

  /**
   * 积分兑换品目录（顾客侧只读）。
   *
   * **只要求 app token，不要求绑定手机号**：这是非个人的目录信息，
   * 未绑定用户也能先看到「能换什么」，到兑换那一步才需要身份
   * （与 `/app/service-items` 同为可匿名浏览的目录）。
   *
   * 只取 `status=active`；返回**逐字段白名单投影**，不把后台 `remark` 带出去。
   */
  async listPointsGoods(
    page: number,
    pageSize: number,
  ): Promise<AppPointsGoodsListVo> {
    const result = await this.pointsGoods.list(page, pageSize, {
      status: 'active',
    });
    return {
      items: result.items.map((item) => ({
        id: item.id,
        name: item.name,
        points: item.points,
        stock: item.stock,
        perLimit: item.perLimit,
        cardTypeName: item.cardTypeName,
      })),
      page: result.page,
      pageSize: result.pageSize,
    };
  }

  /**
   * 兑换积分商品（§15.3）。
   *
   * 三件事按顺序做对：
   * 1. `requireCustomerId` —— **兑换必须要身份**（与「目录可匿名浏览」不同）；
   * 2. 顾客身份只从 token 来，入参只有 `goodsId`（不接受客户端传 customerId）；
   * 3. 真正的扣分/发卡/流水**全部委托给后台 `PointsGoodsService.redeem()`**，
   *    app 域不重算、不另写扣减 —— 否则两套实现必然分叉。
   *
   * `actorId` 传 app 身份 id，用于审计字段 `created_by`。
   */
  async redeemPoints(
    appUserId: number,
    goodsId: number,
  ): Promise<AppPointsRedeemVo> {
    const customerId = await this.requireCustomerId(appUserId);
    const result = await this.pointsGoods.redeem(customerId, goodsId, appUserId);
    return {
      redeemNo: result.redeemNo,
      points: result.points,
      cardNo: result.cardNo,
      cardId: result.cardId,
    };
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

  /**
   * 订阅消息授权（A12）。
   *
   * 客户端在 `wx.requestSubscribeMessage` 的回调里**只上报用户点了「允许」的模板**，
   * 用户拒绝时根本不会调这个接口 —— 所以这里没有「授权失败」这种错误，
   * 永远返回 200。订阅消息是增强，不是业务前置条件，**绝不能因为没授权就拦住下单**。
   *
   * 服务端只做两件事：按 token 定归属（`bookingId` 传了就必须是本人的单）、
   * 按 `(用户, 模板)` 累加额度。额度怎么消费是发送段的事（等 H10 模板 ID）。
   */
  async subscribe(
    appUserId: number,
    input: { templateIds: string[]; bookingId?: number | undefined },
  ): Promise<AppSubscribeVo> {
    const customerId = await this.requireCustomerId(appUserId);
    const { accepted } = await this.notices.recordSubscribeGrant({
      appWxUserId: appUserId,
      customerId,
      templateIds: input.templateIds,
      bookingId: input.bookingId ?? null,
    });
    return { accepted: accepted.length > 0, templateIds: accepted };
  }

  /**
   * 我的预约列表（A10）。
   *
   * `customer_id` 只从 token 对应的身份来，客户端传什么都不好使（§8.3 隔离）。
   * 字段只暴露卡面信息与项目快照：无成本、无备注、无内部字段。
   */
  async bookings(
    appUserId: number,
    query: {
      status?: string | undefined;
      page?: number | undefined;
      pageSize?: number | undefined;
    },
  ): Promise<AppBookingListVo> {
    const customerId = await this.requireCustomerId(appUserId);
    const { page, pageSize } = parsePagination(query.page, query.pageSize);
    const result = await this.bookingPort.listByCustomer(
      customerId,
      page,
      pageSize,
      { status: query.status as never },
    );
    return {
      page: result.page,
      pageSize: result.pageSize,
      items: result.items.map(mapBooking),
    };
  }

  /**
   * 自助下单（A10）。
   *
   * 全部业务逻辑在 `BookingPort.createForCustomer`（复用后台九步，落
   * `channel=miniapp` + `status=pending`）。这里只负责：
   * - 归属（customerId 只从 token 来）；
   * - 把 `pointsToUse` 等入参透传给端口；
   * - 把结果投影成 C 端 VO（无 adjustAmount / 无渠道明细）。
   */
  async createBooking(
    appUserId: number,
    input: {
      staffId: number;
      startAt: string;
      serviceItemIds: number[];
      memberCardId?: number | null | undefined;
      pointsToUse?: number | undefined;
      remark?: string | null | undefined;
    },
  ): Promise<AppCreateBookingVo> {
    const customerId = await this.requireCustomerId(appUserId);
    const created = await this.bookingPort.createForCustomer(customerId, {
      staffId: input.staffId,
      startAt: input.startAt,
      serviceItemIds: input.serviceItemIds,
      memberCardId: input.memberCardId ?? null,
      pointsToUse: input.pointsToUse,
      remark: input.remark ?? undefined,
    });
    return {
      id: created.id,
      bookingNo: created.bookingNo,
      startAt: created.startAt,
      endAt: created.endAt,
      status: 'pending',
      payableAmount: created.payableAmount,
      paidAmount: created.paidAmount,
      dueAmount: created.dueAmount,
      payStatus: created.payStatus,
      items: created.items,
    };
  }

  /**
   * 自助取消（A10）。
   *
   * 归属 + 状态机都在端口里（`cancelForCustomer` 复用后台 `transition`）：
   * 非本人 403、不存在 404、状态不允许 409。这里只透传 + 投影。
   */
  async cancelBooking(
    appUserId: number,
    bookingId: number,
    input: { reason?: string | undefined },
  ): Promise<AppCancelBookingVo> {
    const customerId = await this.requireCustomerId(appUserId);
    const result = await this.bookingPort.cancelForCustomer(
      bookingId,
      customerId,
      input.reason ?? '',
    );
    return { changed: result.changed, warning: result.warning ?? null };
  }
}

/** 预约列表 VO 投影：只留 C 端字段 */
function mapBooking(booking: BookingWithItems): AppBookingVo {
  return {
    id: booking.id,
    bookingNo: booking.bookingNo,
    staffId: booking.staffId,
    staffName: null,
    startAt: booking.startAt.toISOString(),
    endAt: booking.endAt.toISOString(),
    status: booking.status,
    payStatus: booking.payStatus,
    payableAmount: booking.payableAmount,
    paidAmount: booking.paidAmount,
    dueAmount: booking.dueAmount,
    items: booking.items.map((item) => ({
      serviceItemId: item.serviceItemId,
      name: item.name,
      price: item.price,
      durationMinutes: item.durationMinutes,
    })),
  };
}

/**
 * 次卡的**展示态**，规则与 `MemberCardPort.assertUsable` 逐条对齐
 * （退卡 → 已过期 → 次数用完 → 过了有效期）。
 *
 * 只影响展示，不写库：翻转状态是定时任务 `expireCards()` 的事，
 * 这里保证的是「顾客看到的可用性」与「到店真能用」一致。
 */
function displayCardStatus(
  card: Pick<MemberCardRow, 'status' | 'expireAt' | 'usedTimes' | 'totalTimes'>,
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
