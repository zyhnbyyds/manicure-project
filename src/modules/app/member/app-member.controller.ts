import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotImplementedException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../../common/auth/public.decorator.js';
import {
  AppAccessTokenGuard,
  type AppRequest,
} from '../auth/app-access-token.guard.js';
import {
  appBookingListQuerySchema,
  appCancelBookingRequestSchema,
  appCreateBookingRequestSchema,
  appCreateReviewRequestSchema,
  appClaimCouponRequestSchema,
  appCouponsQuerySchema,
  appListQuerySchema,
  appMemberCardsQuerySchema,
  appPointsRedeemRequestSchema,
  appSettleBookingRequestSchema,
  appSubscribeRequestSchema,
  appWxpayJsapiRequestSchema,
  type AppBookingListVo,
  type AppRechargePlanListVo,
  type AppBookingVo,
  type AppCancelBookingVo,
  type AppCreateBookingVo,
  type AppReviewVo,
  type AppSettleBookingVo,
  type AppSubscribeVo,
} from '../dto/app-vo.js';
import { AppMemberService } from './app-member.service.js';

/**
 * app 域会员中心 + C 端写接口契约骨架（`/api/v1/app`）。
 *
 * C 端的预约 / 评价 / 订阅等骨架统一挂在本 controller 下：本期全部返回 501，
 * **不落库**，只保证路由 + Zod schema + Swagger 契约完整（P2 直接填实现）。
 * （微信支付**回调**方向相反、不带 app token，单独放在
 * `../payments/app-payments.controller.ts`。）
 *
 * 鉴权：`@Public()` 跳过全局后台守卫 → `AppAccessTokenGuard` 认 app token；
 * app 域不接 RBAC，只有「本人数据」——所有查询强制 `customer_id = 当前绑定顾客`。
 */
@ApiTags('小程序端')
@ApiBearerAuth('app-token')
@Public()
@UseGuards(AppAccessTokenGuard)
@Controller('app')
export class AppMemberController {
  constructor(private readonly member: AppMemberService) {}

  @Get('member/me')
  @ApiOperation({
    summary: '我的会员信息（等级 / 折扣率 / 积分 / 余额 / 次卡）',
    description:
      '未绑定手机号（app_wx_user.customer_id 为空）→ 401 且响应体带 needBind: true。' +
      '余额只公开本金与赠送两项，不含任何内部字段。',
  })
  @ApiResponse({ status: 200, description: '成功' })
  @ApiResponse({
    status: 401,
    description:
      '未登录，或未绑定手机号（响应体 `{ message, needBind: true }`）',
  })
  me(@Req() request: AppRequest) {
    // 守卫已保证存在；这里只是让类型收窄，避免把 undefined 传进 service
    const appUser = request.appUser;
    if (!appUser) throw new UnauthorizedException();
    return this.member.me(appUser.id);
  }

  @Get('member/cards')
  @ApiOperation({
    summary: '我的次卡列表',
    description:
      '仅本人卡；状态按「到店是否真能用」现算（与后台 `assertUsable` 同一套规则），' +
      '不依赖定时任务是否已把 `expire_at` 翻成 expired。字段只有卡面信息，无成本 / 无备注。',
  })
  @ApiQuery({ name: 'page', required: false, description: '页码', example: 1 })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: '每页条数',
    example: 20,
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: '按状态过滤 active/used_up/expired/refunded',
  })
  @ApiResponse({
    status: 200,
    description: '成功',
    schema: { $ref: '#/components/schemas/AppMemberCardListVo' },
  })
  @ApiResponse({ status: 401, description: '未登录，或未绑定手机号' })
  cards(@Req() request: AppRequest, @Query() query: Record<string, unknown>) {
    const appUser = request.appUser;
    if (!appUser) throw new UnauthorizedException();
    return this.member.cards(
      appUser.id,
      appMemberCardsQuerySchema.parse(query),
    );
  }

  @Get('recharge-plans')
  @ApiOperation({
    summary: '上架中的充值档位',
    description:
      'C 端充值页展示用：只给名称、实付金额、赠送金额（分）。' +
      '**需要 app token，不要求绑定手机号**（与积分商品目录同一口径）。',
  })
  @ApiResponse({
    status: 200,
    description: '成功',
    schema: { $ref: '#/components/schemas/AppRechargePlanListVo' },
  })
  @ApiResponse({ status: 401, description: '未登录' })
  async rechargePlans(
    @Req() request: AppRequest,
  ): Promise<AppRechargePlanListVo> {
    const appUser = request.appUser;
    if (!appUser) throw new UnauthorizedException();
    return this.member.rechargePlans();
  }
  @Get('points-goods')
  @ApiOperation({
    summary: '积分兑换品目录',
    description:
      '顾客侧只读目录：只返回上架商品（`status=active`）与兑换所需字段，' +
      '**不含后台备注与成本**。' +
      '**只要求 app token，不要求绑定手机号** —— 未绑定用户也能先看到能换什么，' +
      '到兑换那一步才需要身份（与 `/app/service-items` 同为可匿名浏览的目录）。' +
      '兑换动作是资金/权益写入，由后续接口复用后台同一套同事务实现，不在此处暴露。',
  })
  @ApiQuery({ name: 'page', required: false, description: '页码', example: 1 })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: '每页条数',
    example: 20,
  })
  @ApiResponse({
    status: 200,
    description: '成功',
    schema: { $ref: '#/components/schemas/AppPointsGoodsListVo' },
  })
  @ApiResponse({ status: 401, description: '未登录（缺少 app token）' })
  pointsGoods(@Query() query: Record<string, unknown>) {
    // `appListQuerySchema` 的 page/pageSize 都是可选，这里给默认值（与分页口径一致）
    const { page = 1, pageSize = 20 } = appListQuerySchema.parse(query);
    return this.member.listPointsGoods(page, pageSize);
  }

  @Post('points/redeem')
  @HttpCode(200)
  @ApiOperation({
    summary: '兑换积分商品',
    description:
      '**需要绑定手机号**（与目录不同：兑换是权益写入）。' +
      '扣积分、发次卡、写兑换记录与 `points_redeem` 流水**全部在后台同一条事务里完成**，' +
      'app 域只做身份解析与转发，不重算积分。' +
      '积分不足 / 已兑完 / 已达每人限兑 → 409；未绑定手机号 → 401 + `needBind`。',
  })
  @ApiBody({ schema: { $ref: '#/components/schemas/AppPointsRedeemRequest' } })
  @ApiResponse({
    status: 200,
    description: '兑换成功',
    schema: { $ref: '#/components/schemas/AppPointsRedeemVo' },
  })
  @ApiResponse({ status: 401, description: '未登录，或未绑定手机号' })
  @ApiResponse({ status: 409, description: '积分不足 / 已兑完 / 超过限兑次数' })
  redeemPoints(@Req() request: AppRequest, @Body() body: unknown) {
    const appUser = request.appUser;
    if (!appUser) throw new UnauthorizedException();
    const input = appPointsRedeemRequestSchema.parse(body);
    return this.member.redeemPoints(appUser.id, input.goodsId);
  }

  @Get('coupon-offers')
  @ApiOperation({
    summary: '可领取的优惠券',
    description:
      '**需要绑定手机号**（领了就是个人权益）。已持有可用券的模板不会出现 —— 同一张券反复领就是薅羊毛，顾客看到自己已领的券出现在「可领取」里也会困惑。',
  })
  @ApiResponse({
    status: 200,
    description: '成功',
    schema: { $ref: '#/components/schemas/AppCouponOfferListVo' },
  })
  @ApiResponse({ status: 401, description: '未登录，或未绑定手机号' })
  couponOffers(@Req() request: AppRequest) {
    const appUser = request.appUser;
    if (!appUser) throw new UnauthorizedException();
    return this.member.listCouponOffers(appUser.id);
  }

  @Post('coupons/claim')
  @HttpCode(200)
  @ApiOperation({
    summary: '领取优惠券',
    description:
      '**需要绑定手机号**。并发安全在服务端：事务内 SELECT ... FOR UPDATE 锁模板行，同一顾客并发点两次「领取」只会成功一次；重复领 → 409。',
  })
  @ApiBody({ schema: { $ref: '#/components/schemas/AppClaimCouponRequest' } })
  @ApiResponse({
    status: 200,
    description: '领取成功',
    schema: { $ref: '#/components/schemas/AppCustomerCouponVo' },
  })
  @ApiResponse({ status: 409, description: '已领过 / 已停止发放' })
  claimCoupon(@Req() request: AppRequest, @Body() body: unknown) {
    const appUser = request.appUser;
    if (!appUser) throw new UnauthorizedException();
    const input = appClaimCouponRequestSchema.parse(body);
    return this.member.claimCoupon(appUser.id, input.templateId);
  }

  @Get('coupons')
  @ApiOperation({
    summary: '我的优惠券',
    description:
      '**需要绑定手机号**（券是个人权益）。只返回本人券，状态为**现算**后的展示状态：' +
      '`usable` 但已过期的券在这里就是 `expired`，不依赖定时任务是否跑过。' +
      '响应**不含** `templateId`、模板备注与审计字段。',
  })
  @ApiQuery({ name: 'page', required: false, description: '页码', example: 1 })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: '每页条数',
    example: 20,
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'usable / used / expired / void / all，不传 = all',
  })
  @ApiResponse({
    status: 200,
    description: '成功',
    schema: { $ref: '#/components/schemas/AppCustomerCouponListVo' },
  })
  @ApiResponse({ status: 401, description: '未登录，或未绑定手机号' })
  coupons(@Req() request: AppRequest, @Query() query: Record<string, unknown>) {
    const appUser = request.appUser;
    if (!appUser) throw new UnauthorizedException();
    const { page, pageSize, status } = appCouponsQuerySchema.parse(query);
    return this.member.listCoupons(
      appUser.id,
      status ?? 'all',
      page ?? 1,
      pageSize ?? 20,
    );
  }

  /* ------------------------------------------------------------------ *
   * 以下为契约骨架：路由 + Zod schema + Swagger 已冻结，业务返回 501（不落库）
   * ------------------------------------------------------------------ */

  @Get('bookings')
  @ApiOperation({
    summary: '我的预约列表',
    description:
      '仅本人预约（`customer_id` 只从 token 对应的绑定身份来，不接受客户端传值）；' +
      '返回 `{ items, page, pageSize }`，无 `total`。列表只含卡面信息与项目快照，' +
      '无成本 / 无备注 / 无内部字段。',
  })
  @ApiQuery({ name: 'page', required: false, description: '页码', example: 1 })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: '每页条数',
    example: 20,
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'pending/confirmed/arrived/completed/cancelled/no_show',
  })
  @ApiResponse({
    status: 200,
    description: '成功',
    schema: { $ref: '#/components/schemas/AppBookingListVo' },
  })
  @ApiResponse({ status: 401, description: '未登录，或未绑定手机号' })
  bookings(
    @Req() request: AppRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<AppBookingListVo> {
    const appUser = request.appUser;
    if (!appUser) throw new UnauthorizedException();
    const parsed = appBookingListQuerySchema.parse(query);
    return this.member.bookings(appUser.id, {
      status: parsed.status,
      page: parsed.page,
      pageSize: parsed.pageSize,
    });
  }

  @Get('bookings/:id')
  @ApiOperation({
    summary: '预约详情（本人）',
    description:
      '按 id 直取，客户端不必再从列表里翻找（老单翻不到会误报「找不到订单」）。\n' +
      '**归属只认 token**：他人的单与不存在的单统一返回 404 —— ' +
      '刻意不区分 403，否则会泄露「这个 id 存在、只是不属于你」。\n' +
      '支付页用它做**支付后确认**：`payStatus` / `dueAmount` 是服务端事实，' +
      '`wx.requestPayment` 成功只代表微信收银台走完，不代表账已落库。',
  })
  @ApiParam({ name: 'id', description: '预约 ID', example: 1 })
  @ApiResponse({
    status: 200,
    description: '成功',
    schema: { $ref: '#/components/schemas/AppBookingVo' },
  })
  @ApiResponse({ status: 401, description: '未登录，或未绑定手机号' })
  @ApiResponse({ status: 404, description: '预约不存在或不属于本人' })
  bookingDetail(
    @Req() request: AppRequest,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<AppBookingVo> {
    const appUser = request.appUser;
    if (!appUser) throw new UnauthorizedException();
    return this.member.bookingDetail(appUser.id, id);
  }
  @Post('bookings')
  @ApiOperation({
    summary: '自助下单',
    description:
      '复用后台创建九步（预约 - 锁定 - 冲突复检 - 建单 - 交易），仅两处差异：\n' +
      '**落 `channel=miniapp` + `status=pending`**（与店员代录的 `confirmed` 区分，待门店确认）；\n' +
      '**不收款**（JSAPI 支付在 P2），如传 `memberCardId` 则整单次卡当场核销（payable=0，选 1 个项目）。\n' +
      '无改价 / 无强制覆盖；顾客时段与已有预约重叠 → 409。',
  })
  @ApiBody({ schema: { $ref: '#/components/schemas/AppCreateBookingRequest' } })
  @ApiResponse({
    status: 201,
    description: '已受理（待确认）',
    schema: { $ref: '#/components/schemas/AppCreateBookingVo' },
  })
  @ApiResponse({ status: 400, description: '入参非法 / 不在班次 / 未达提前期' })
  @ApiResponse({ status: 401, description: '未登录，或未绑定手机号' })
  @ApiResponse({ status: 409, description: '与本人已有预约重叠' })
  createBooking(
    @Req() request: AppRequest,
    @Body() body: unknown,
  ): Promise<AppCreateBookingVo> {
    const appUser = request.appUser;
    if (!appUser) throw new UnauthorizedException();
    return this.member.createBooking(
      appUser.id,
      appCreateBookingRequestSchema.parse(body),
    );
  }

  @Post('bookings/:id/settle')
  @HttpCode(200)
  @ApiOperation({
    summary: '自助结算（付尾款）',
    description:
      '与后台结算**共用同一份资金核心**（算价 / 条件更新 / 流水 / `recalc`），不另写一套。\n' +
      '渠道只允许**不依赖任何通道对接**的两种：`balance`（储值余额）、`card`（次卡核销）；' +
      '微信/支付宝是 P2 契约位，现金/线下收款码/挂账是店员动作。\n' +
      '`memberCardId` 支持「**到店后用次卡核销**」：下单没选卡的预约可在结算补上，' +
      '服务端会**重算应付**（次卡 → `payable = 0`），而不是记一笔 0 元支付单。\n' +
      '`pointsUsed` 是积分抵扣，服务端按 `maxPointsPermille` 复算上限（默认 30%），' +
      '因此积分**不可能单独付清全款**，剩余仍需余额支付或到店支付。',
  })
  @ApiParam({ name: 'id', description: '预约 ID', example: 55 })
  @ApiBody({ schema: { $ref: '#/components/schemas/AppSettleBookingRequest' } })
  @ApiResponse({
    status: 200,
    description: '结算后的金额事实',
    schema: { $ref: '#/components/schemas/AppSettleBookingVo' },
  })
  @ApiResponse({
    status: 400,
    description:
      '金额超过待收尾款 / 次卡与积分同时使用 / 次卡不适用（项目数 ≠ 1）/ 渠道不在白名单',
  })
  @ApiResponse({ status: 401, description: '未登录，或未绑定手机号' })
  @ApiResponse({ status: 403, description: '这不是本人的预约' })
  @ApiResponse({ status: 404, description: '预约不存在' })
  @ApiResponse({
    status: 409,
    description: '已取消 / 爽约不能结算；或储值余额不足',
  })
  settleBooking(
    @Req() request: AppRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
  ): Promise<AppSettleBookingVo> {
    const appUser = request.appUser;
    if (!appUser) throw new UnauthorizedException();
    return this.member.settleBooking(
      appUser.id,
      id,
      appSettleBookingRequestSchema.parse(body),
    );
  }

  @Post('bookings/:id/cancel')
  @ApiOperation({
    summary: '自助取消预约',
    description:
      '仅本人可取消（他人单 403）；pending / confirmed 均可；' +
      '`reason` 必填。已有实收时不自动退款，响应带 `warning` 提示走退款审批（§15.6 人工判责）。',
  })
  @ApiParam({ name: 'id', description: '预约 ID', example: 1 })
  @ApiBody({ schema: { $ref: '#/components/schemas/AppCancelBookingRequest' } })
  @HttpCode(200)
  @ApiResponse({
    status: 200,
    description: '取消结果',
    schema: { $ref: '#/components/schemas/AppCancelBookingVo' },
  })
  @ApiResponse({ status: 400, description: '取消原因未填' })
  @ApiResponse({ status: 401, description: '未登录，或未绑定手机号' })
  @ApiResponse({ status: 403, description: '不是本人的预约' })
  @ApiResponse({ status: 404, description: '预约不存在' })
  @ApiResponse({ status: 409, description: '当前状态不允许取消' })
  cancelBooking(
    @Req() request: AppRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
  ): Promise<AppCancelBookingVo> {
    const appUser = request.appUser;
    if (!appUser) throw new UnauthorizedException();
    return this.member.cancelBooking(
      appUser.id,
      id,
      appCancelBookingRequestSchema.parse(body),
    );
  }

  @Post('reviews')
  @ApiOperation({
    summary: '提交服务评价',
    description:
      '三道约束全在服务端：**仅本人**（按预约事实校验归属）→ **仅已完成**（未完成 400）' +
      '→ **一单一评**（二次提交 409）。客户端只能决定打分与文字，' +
      '`customer_id` / `staff_id` 由预约事实带出。',
  })
  @ApiBody({ schema: { $ref: '#/components/schemas/AppCreateReviewRequest' } })
  @ApiResponse({
    status: 201,
    description: '成功',
    schema: { $ref: '#/components/schemas/AppReviewVo' },
  })
  @ApiResponse({ status: 400, description: '预约不是已完成状态' })
  @ApiResponse({ status: 401, description: '未登录，或未绑定手机号' })
  @ApiResponse({ status: 403, description: '这不是本人的预约' })
  @ApiResponse({ status: 404, description: '预约不存在' })
  @ApiResponse({ status: 409, description: '该预约已评价（一单一评）' })
  createReview(
    @Req() request: AppRequest,
    @Body() body: unknown,
  ): Promise<AppReviewVo> {
    const appUser = request.appUser;
    if (!appUser) throw new UnauthorizedException();
    return this.member.createReview(
      appUser.id,
      appCreateReviewRequestSchema.parse(body),
    );
  }

  @Post('payments/wxpay/jsapi')
  @ApiOperation({
    summary: '小程序内微信支付（JSAPI）（契约骨架，本期返回 501）',
    description:
      '本期后台在线支付走 Native 扫码（§17.1），JSAPI 只是给 P2 预留的契约位：' +
      '返回 wx.requestPayment 所需的预支付参数。',
  })
  @ApiBody({ schema: { $ref: '#/components/schemas/AppWxpayJsapiRequest' } })
  @ApiResponse({ status: 401, description: '未登录，或未绑定手机号' })
  @ApiResponse({ status: 503, description: '微信支付通道未启用' })
  @ApiResponse({ status: 501, description: '本期未实现' })
  wxpayJsapi(@Body() body: unknown): never {
    appWxpayJsapiRequestSchema.parse(body);
    throw new NotImplementedException('小程序内 JSAPI 支付将在 P2 实现');
  }

  @Post('subscribe')
  @ApiOperation({
    summary: '订阅消息授权',
    description:
      '客户端在 `wx.requestSubscribeMessage` 回调里**只上报用户点了「允许」的模板**，' +
      '用户拒绝时不要调用本接口。服务端按 `(用户, 模板)` 累加微信下发额度' +
      '（一次性订阅可累积），**未授权不报错、不阻塞业务**——订阅消息是增强而非前置条件。' +
      '`bookingId` 为可选上下文，传了就必须是本人的预约。' +
      '额度的消费（真正下发服务通知）依赖 H10 的模板 ID 申请，见交接文档 D12。',
  })
  @ApiBody({ schema: { $ref: '#/components/schemas/AppSubscribeRequest' } })
  @ApiResponse({
    status: 201,
    description: '已受理；`accepted=false` 表示没有可记录的模板',
    schema: { $ref: '#/components/schemas/AppSubscribeVo' },
  })
  @ApiResponse({ status: 401, description: '未登录，或未绑定手机号' })
  @ApiResponse({ status: 403, description: 'bookingId 不是本人的预约' })
  @ApiResponse({ status: 404, description: '预约不存在' })
  subscribe(
    @Req() request: AppRequest,
    @Body() body: unknown,
  ): Promise<AppSubscribeVo> {
    const appUser = request.appUser;
    if (!appUser) throw new UnauthorizedException();
    return this.member.subscribe(
      appUser.id,
      appSubscribeRequestSchema.parse(body),
    );
  }
}
