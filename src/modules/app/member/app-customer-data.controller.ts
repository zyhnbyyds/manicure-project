import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
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
  type AppAddressListVo,
  type AppAddressVo,
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
}
