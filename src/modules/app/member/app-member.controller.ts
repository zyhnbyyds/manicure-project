import {
  Body,
  Controller,
  Get,
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
  appMemberCardsQuerySchema,
  appSubscribeRequestSchema,
  appWxpayJsapiRequestSchema,
  type AppReviewVo,
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
    return this.member.cards(appUser.id, appMemberCardsQuerySchema.parse(query));
  }

  /* ------------------------------------------------------------------ *
   * 以下为契约骨架：路由 + Zod schema + Swagger 已冻结，业务返回 501（不落库）
   * ------------------------------------------------------------------ */

  @Get('bookings')
  @ApiOperation({ summary: '我的预约列表（契约骨架，本期返回 501）' })
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
  @ApiResponse({ status: 401, description: '未登录，或未绑定手机号' })
  @ApiResponse({ status: 501, description: '本期未实现' })
  bookings(@Query() query: Record<string, unknown>): never {
    appBookingListQuerySchema.parse(query);
    throw new NotImplementedException('我的预约列表将在 P2 小程序端实现');
  }

  @Post('bookings')
  @ApiOperation({
    summary: '自助下单（契约骨架，本期返回 501）',
    description:
      'P2 接通微信支付（JSAPI 预支付单）；本期只冻结入参契约，不落库、不占时段。',
  })
  @ApiBody({ schema: { $ref: '#/components/schemas/AppCreateBookingRequest' } })
  @ApiResponse({ status: 401, description: '未登录，或未绑定手机号' })
  @ApiResponse({ status: 501, description: '本期未实现' })
  createBooking(@Body() body: unknown): never {
    appCreateBookingRequestSchema.parse(body);
    throw new NotImplementedException('自助下单将在 P2 小程序端实现');
  }

  @Post('bookings/:id/cancel')
  @ApiOperation({
    summary: '自助取消预约（契约骨架，本期返回 501）',
    description: '是否可退按 §15.6 的人工判责规则，本期只留契约。',
  })
  @ApiParam({ name: 'id', description: '预约 ID', example: 1 })
  @ApiBody({ schema: { $ref: '#/components/schemas/AppCancelBookingRequest' } })
  @ApiResponse({ status: 401, description: '未登录，或未绑定手机号' })
  @ApiResponse({ status: 501, description: '本期未实现' })
  cancelBooking(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
  ): never {
    appCancelBookingRequestSchema.parse(body);
    throw new NotImplementedException(
      `自助取消预约（id=${id}）将在 P2 小程序端实现`,
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
