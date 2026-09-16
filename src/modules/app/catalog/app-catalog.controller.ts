import { Controller, Get, Headers, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../../common/auth/public.decorator';
import { AppAccessTokenGuard } from '../auth/app-access-token.guard';
import { AppOptionalToken } from '../auth/app-optional-token.decorator';
import { AppCatalogService } from './app-catalog.service';

/**
 * app 域目录（`/api/v1/app`）：只读接口，**访客即可浏览**。
 *
 * `@Public()` 跳过全局后台守卫 → 再由 `AppAccessTokenGuard` 做 app 域鉴权
 * （后台 token 打这里必然 401）。不接 RBAC，无权限点。
 *
 * `@AppOptionalToken()`：本控制器的三个接口**谁看都一样**（不含任何本人数据），
 * 所以没带凭证时按访客放行 —— 用户还没登录也应该能翻款式、看美甲师、看可约时段，
 * 而不是收到一个 `401 Unauthorized`。带了凭证仍严格校验，双向拒绝不受影响。
 */
@ApiTags('小程序端')
@ApiBearerAuth('app-token')
@Public()
@AppOptionalToken()
@UseGuards(AppAccessTokenGuard)
@Controller('app')
export class AppCatalogController {
  constructor(private readonly catalog: AppCatalogService) {}

  @Get('service-items')
  @ApiOperation({
    summary: '服务项目列表（启用中）',
    description:
      '字段只有 id/name/category/durationMinutes/price/description/image，不含成本与备注。' +
      '**免登录可访问**（带凭证时按凭证鉴权）。',
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
    schema: { $ref: '#/components/schemas/AppServiceItemListVo' },
  })
  @ApiResponse({
    status: 401,
    description: '带了凭证但凭证非法 / 非 app token（访客不带凭证可正常访问）',
  })
  serviceItems(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.catalog.listServiceItems(page, pageSize);
  }

  @Get('staffs')
  @ApiOperation({
    summary: '美甲师列表（启用中）',
    description:
      '字段只有 id/nickname/avatar/bio，用于小程序端选择美甲师。' +
      '**按「当前门店」收窄**（请求头 `x-store-id` → 校验启用 → 回落默认门店）：' +
      '只返回能服务这家店的人，没配过服务门店的人在所有店都可用。**免登录可访问**。',
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
    schema: { $ref: '#/components/schemas/AppStaffListVo' },
  })
  @ApiResponse({
    status: 401,
    description: '带了凭证但凭证非法 / 非 app token（访客不带凭证可正常访问）',
  })
  staffs(
    @Headers('x-store-id') rawStoreId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.catalog.listStaffs(page, pageSize, rawStoreId);
  }

  @Get('available-slots')
  @ApiOperation({
    summary: '可约时段',
    description:
      '与后台复用同一个可约时段算法（§5）：班次 − 已有预约 − 缓冲 gap、美甲师可做项目过滤、' +
      '店内本地日界；小程序渠道额外应用提前期 minLeadMinutes。结果与后台一致。**免登录可访问**。',
  })
  @ApiQuery({
    name: 'staffId',
    required: true,
    description: '美甲师 ID',
    example: 1,
  })
  @ApiQuery({
    name: 'date',
    required: true,
    description: '店内本地日 YYYY-MM-DD',
    example: '2026-09-11',
  })
  @ApiQuery({
    name: 'serviceItemIds',
    required: true,
    description:
      '服务项目 ID：逗号分隔（1,2）或重复 query（1&serviceItemIds=2），去重后 1~3 个',
    example: '1,2',
  })
  @ApiResponse({
    status: 200,
    description: '成功；无可约时段时 slots 为空数组并附 reason',
    schema: { $ref: '#/components/schemas/AppAvailableSlotsVo' },
  })
  @ApiResponse({
    status: 400,
    description: '参数不合法（项目数量不在 1~3 / 日期格式错误）',
  })
  @ApiResponse({
    status: 401,
    description: '带了凭证但凭证非法 / 非 app token（访客不带凭证可正常访问）',
  })
  availableSlots(
    @Query() query: Record<string, unknown>,
    @Headers('x-store-id') rawStoreId?: string,
  ) {
    return this.catalog.availableSlots(query, rawStoreId);
  }
}
