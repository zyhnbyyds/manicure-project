import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../../common/auth/public.decorator.js';
import { AppAccessTokenGuard } from '../auth/app-access-token.guard.js';
import { AppCatalogService } from './app-catalog.service.js';

/**
 * app 域目录（`/api/v1/app`）：只读接口，需要 app token。
 *
 * `@Public()` 跳过全局后台守卫 → 再由 `AppAccessTokenGuard` 做 app 域鉴权
 * （后台 token 打这里必然 401）。不接 RBAC，无权限点。
 */
@ApiTags('小程序端')
@ApiBearerAuth('app-token')
@Public()
@UseGuards(AppAccessTokenGuard)
@Controller('app')
export class AppCatalogController {
  constructor(private readonly catalog: AppCatalogService) {}

  @Get('service-items')
  @ApiOperation({
    summary: '服务项目列表（启用中）',
    description:
      '字段只有 id/name/category/durationMinutes/price/description/image，不含成本与备注。',
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
    description: '未登录（缺少 / 非法的 app token）',
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
    description: '字段只有 id/nickname/avatar/bio，用于小程序端选择美甲师。',
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
    description: '未登录（缺少 / 非法的 app token）',
  })
  staffs(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.catalog.listStaffs(page, pageSize);
  }

  @Get('available-slots')
  @ApiOperation({
    summary: '可约时段',
    description:
      '与后台复用同一个可约时段算法（§5）：班次 − 已有预约 − 缓冲 gap、美甲师可做项目过滤、' +
      '店内本地日界；小程序渠道额外应用提前期 minLeadMinutes。结果与后台一致。',
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
    description: '未登录（缺少 / 非法的 app token）',
  })
  availableSlots(@Query() query: Record<string, unknown>) {
    return this.catalog.availableSlots(query);
  }
}
