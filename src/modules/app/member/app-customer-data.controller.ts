import {
  Body,
  Controller,
  Get,
  HttpCode,
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
  appAddressUpsertRequestSchema,
  appCreateFeedbackRequestSchema,
  appListQuerySchema,
  type AppAddressListVo,
  type AppAddressVo,
  type AppFavoriteListVo,
  type AppFavoriteToggleVo,
  type AppNoticeReadVo,
} from '../dto/app-vo.js';
import { AppCustomerDataService } from './app-customer-data.service.js';

/**
 * 顾客自助数据（收货地址；款式收藏后续并入本 controller）。
 *
 * 与 `/app/member/**` 同一鉴权口径：`@Public()` 跳过后台守卫 → `AppAccessTokenGuard`
 * 认 app token；app 域不接 RBAC，只有「本人数据」，归属强制来自 token。
 *
 * ⚠️ 所有写操作都是 **POST**：`wx.request` 的 method 里没有 PATCH
 * （见 `miniapp/miniprogram/utils/request.ts` 的 `HttpMethod`），
 * 所以编辑/删除/设默认都开成动作端点（与 `bookings/:id/cancel` 同风格）。
 */
@ApiTags('小程序端')
@ApiBearerAuth('app-token')
@Public()
@UseGuards(AppAccessTokenGuard)
@Controller('app')
export class AppCustomerDataController {
  constructor(private readonly customerData: AppCustomerDataService) {}

  private appUserId(request: AppRequest): number {
    const appUser = request.appUser;
    if (!appUser) throw new UnauthorizedException();
    return appUser.id;
  }

  @Get('member/addresses')
  @ApiOperation({
    summary: '我的收货地址列表',
    description:
      '只返回本人的地址；默认地址排最前。未绑定手机号 → 400 + `needBind`（地址是个人数据）。',
  })
  @ApiResponse({
    status: 200,
    description: '成功',
    schema: { $ref: '#/components/schemas/AppAddressListVo' },
  })
  listAddresses(@Req() request: AppRequest): Promise<AppAddressListVo> {
    return this.customerData.listAddresses(this.appUserId(request));
  }

  @Post('member/addresses')
  @HttpCode(200)
  @ApiOperation({
    summary: '新增收货地址',
    description:
      `最多 ${10} 个；**第一个地址自动成为默认**；显式传 \`isDefault: true\` 也会成为默认` +
      '（同一顾客最多一个默认，切换在同一事务里完成）。',
  })
  @ApiBody({ schema: { $ref: '#/components/schemas/AppAddressUpsertRequest' } })
  @ApiResponse({
    status: 200,
    description: '成功，返回新增后的地址',
    schema: { $ref: '#/components/schemas/AppAddressVo' },
  })
  createAddress(
    @Req() request: AppRequest,
    @Body() body: unknown,
  ): Promise<AppAddressVo> {
    return this.customerData.createAddress(
      this.appUserId(request),
      appAddressUpsertRequestSchema.parse(body),
    );
  }

  @Post('member/addresses/:id/update')
  @HttpCode(200)
  @ApiOperation({
    summary: '编辑收货地址',
    description:
      '全量字段覆盖（不做 PATCH 语义：`wx.request` 没有 PATCH）。' +
      '不属于自己的 id → 404（不是 403，避免泄露 id 是否存在）。',
  })
  @ApiParam({ name: 'id', description: '地址 ID', example: 1 })
  @ApiBody({ schema: { $ref: '#/components/schemas/AppAddressUpsertRequest' } })
  @ApiResponse({
    status: 200,
    description: '成功，返回更新后的地址',
    schema: { $ref: '#/components/schemas/AppAddressVo' },
  })
  updateAddress(
    @Req() request: AppRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
  ): Promise<AppAddressVo> {
    return this.customerData.updateAddress(
      this.appUserId(request),
      id,
      appAddressUpsertRequestSchema.parse(body),
    );
  }

  @Post('member/addresses/:id/default')
  @HttpCode(200)
  @ApiOperation({
    summary: '设为默认收货地址',
    description: '把该地址设为默认，并清掉原本的默认（同一事务）。',
  })
  @ApiParam({ name: 'id', description: '地址 ID', example: 1 })
  @ApiResponse({
    status: 200,
    description: '成功',
    schema: { $ref: '#/components/schemas/AppAddressVo' },
  })
  setDefaultAddress(
    @Req() request: AppRequest,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<AppAddressVo> {
    return this.customerData.setDefaultAddress(this.appUserId(request), id);
  }

  @Post('member/addresses/:id/delete')
  @HttpCode(200)
  @ApiOperation({
    summary: '删除收货地址',
    description:
      '软删。删掉的若是默认地址，会把剩下最新的一个顶为默认 —— ' +
      '「有地址但没有默认」是没人能处理的状态。',
  })
  @ApiParam({ name: 'id', description: '地址 ID', example: 1 })
  @ApiResponse({ status: 200, description: '成功' })
  async removeAddress(
    @Req() request: AppRequest,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ ok: true }> {
    await this.customerData.removeAddress(this.appUserId(request), id);
    return { ok: true };
  }

  /* ------------------------------ 款式收藏 ------------------------------ */

  @Get('member/favorites')
  @ApiOperation({
    summary: '我的收藏（款式）',
    description:
      '只返回「还在上架且未删」的款式 —— 门店下架的款式不该还能点进去。' +
      '收藏行本身保留：门店重新上架，收藏就回来。',
  })
  @ApiResponse({
    status: 200,
    description: '成功',
    schema: { $ref: '#/components/schemas/AppFavoriteListVo' },
  })
  listFavorites(@Req() request: AppRequest): Promise<AppFavoriteListVo> {
    return this.customerData.listFavorites(this.appUserId(request));
  }

  @Post('member/favorites/:id')
  @HttpCode(200)
  @ApiOperation({
    summary: '收藏款式（幂等）',
    description:
      '返回**目标状态** `{ serviceItemId, favorited: true }`，前端据此改心形图标。' +
      '重复收藏不算错；软删过的收藏走「恢复」而不是插新行。',
  })
  @ApiParam({ name: 'id', description: '款式 ID', example: 1 })
  @ApiResponse({
    status: 200,
    description: '成功',
    schema: { $ref: '#/components/schemas/AppFavoriteToggleVo' },
  })
  addFavorite(
    @Req() request: AppRequest,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<AppFavoriteToggleVo> {
    return this.customerData.addFavorite(this.appUserId(request), id);
  }

  @Post('member/favorites/:id/delete')
  @HttpCode(200)
  @ApiOperation({
    summary: '取消收藏（幂等）',
    description: '软删；没收藏过也返回 `favorited: false`，不是错误。',
  })
  @ApiParam({ name: 'id', description: '款式 ID', example: 1 })
  @ApiResponse({
    status: 200,
    description: '成功',
    schema: { $ref: '#/components/schemas/AppFavoriteToggleVo' },
  })
  removeFavorite(
    @Req() request: AppRequest,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<AppFavoriteToggleVo> {
    return this.customerData.removeFavorite(this.appUserId(request), id);
  }

  /* ------------------------------ 站内消息 ------------------------------ */

  @Get('notices')
  @ApiOperation({
    summary: '我的消息（站内收件箱）',
    description:
      '只出**站内消息**（短信投递日志不进收件箱）；按分类筛选（选项取响应里的 `categories`）。' +
      '响应带 `unread`（红点用）。未绑定手机号 → 400 + `needBind`。',
  })
  @ApiQuery({ name: 'page', required: false, description: '页码', example: 1 })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: '每页条数',
    example: 20,
  })
  @ApiQuery({
    name: 'category',
    required: false,
    description: '按分类筛选（预约提醒 / 账户通知 …）',
  })
  @ApiResponse({
    status: 200,
    description: '成功',
    schema: { $ref: '#/components/schemas/AppNoticeListVo' },
  })
  listNotices(
    @Req() request: AppRequest,
    @Query() query: Record<string, unknown>,
  ) {
    const parsed = appListQuerySchema.parse(query);
    const category =
      typeof query.category === 'string' ? query.category.trim() : '';
    return this.customerData.listNotices(this.appUserId(request), {
      category: category === '' ? undefined : category,
      // 与其它分页端点同口径：给默认值，避免把 undefined 传进 service
      page: parsed.page ?? 1,
      pageSize: parsed.pageSize ?? 20,
    });
  }

  @Post('notices/:id/read')
  @HttpCode(200)
  @ApiOperation({
    summary: '标记一条消息已读（幂等）',
    description: '已读的不会重复更新；返回剩余未读数，前端据此更新红点。',
  })
  @ApiParam({ name: 'id', description: '消息 ID', example: 1 })
  @ApiResponse({
    status: 200,
    description: '成功',
    schema: { $ref: '#/components/schemas/AppNoticeReadVo' },
  })
  markNoticeRead(
    @Req() request: AppRequest,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<AppNoticeReadVo> {
    return this.customerData.markNoticeRead(this.appUserId(request), id);
  }

  @Post('notices/read-all')
  @HttpCode(200)
  @ApiOperation({
    summary: '全部已读（可只清某个分类）',
    description:
      '不传 `category` = 全部已读；传了就只清该分类的未读 —— 有分类筛选时' +
      '「全部已读」不该顺手清掉别的分类。',
  })
  @ApiQuery({
    name: 'category',
    required: false,
    description: '只清这个分类（不传 = 全部）',
  })
  @ApiResponse({
    status: 200,
    description: '成功',
    schema: { $ref: '#/components/schemas/AppNoticeReadVo' },
  })
  markAllNoticesRead(
    @Req() request: AppRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<AppNoticeReadVo> {
    const category =
      typeof query.category === 'string' ? query.category.trim() : '';
    return this.customerData.markAllNoticesRead(
      this.appUserId(request),
      category === '' ? undefined : category,
    );
  }

  @Post('feedback')
  @HttpCode(200)
  @ApiOperation({
    summary: '提交意见反馈',
    description:
      '**不要求绑定手机号**（未绑定的访客也有意见要说，硬拦只会让他去别处说）。' +
      '`anonymous: true` 时**后端一律落 `customer_id = null`** —— 「匿名」是当着顾客的' +
      '面做出的承诺，记了身份再标匿名等于骗人。只写不读：响应不回显内容。',
  })
  @ApiBody({
    schema: { $ref: '#/components/schemas/AppCreateFeedbackRequest' },
  })
  @ApiResponse({
    status: 200,
    description: '成功',
    schema: { $ref: '#/components/schemas/AppCreateFeedbackVo' },
  })
  createFeedback(@Req() request: AppRequest, @Body() body: unknown) {
    const appUser = request.appUser;
    if (!appUser) throw new UnauthorizedException();
    return this.customerData.createFeedback(
      appUser.id,
      appCreateFeedbackRequestSchema.parse(body),
    );
  }

  /* ------------------------------ 门店档案 ------------------------------ */
  @Get('shop')
  @ApiOperation({
    summary: '门店档案（公开信息）',
    description:
      '门店名 / 电话 / 地址 / 营业时间 / 经纬度 / 公告：来自 `sys_config`（门店可在后台改），' +
      '缺省回落内置默认值。**只要求 app token，不要求绑定手机号** —— 这是公开信息，' +
      '与 `/app/service-items` 同为可匿名浏览的目录。',
  })
  @ApiResponse({
    status: 200,
    description: '成功',
    schema: { $ref: '#/components/schemas/AppShopVo' },
  })
  shop() {
    return this.customerData.shopProfile();
  }
}
