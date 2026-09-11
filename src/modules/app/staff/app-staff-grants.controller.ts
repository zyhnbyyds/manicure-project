import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
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
import { z } from 'zod';
import { RequirePermissions } from '../../../common/auth/permissions.decorator.js';
import { registerComponent } from '../../../common/swagger/zod-schema.helper.js';
import { parsePagination } from '../../biz/common/query.js';
import {
  AppStaffGrantsService,
  type GrantStatus,
} from './app-staff-grants.service.js';

const rejectSchema = z.object({
  reason: z
    .string()
    .min(1)
    .max(200)
    .openapi({
      example: '手机号与档案不符',
      description: '驳回原因（申请人可见）',
    }),
});

registerComponent('AppStaffGrantRejectRequest', rejectSchema);

type AuthRequest = { user: { id: number } };

/**
 * 店长侧「小程序工作台开通申请」（施工单 §12.5）。
 *
 * 挂在 `/biz/**` 下走后台 RBAC，权限点 `biz:staff:grant`；
 * 与小程序端 `POST /app/staff/apply` 是同一条流程的两端。
 */
@ApiTags('小程序端 - 工作台授权')
@ApiBearerAuth('access-token')
@Controller('biz/app-staff-grants')
export class AppStaffGrantsController {
  constructor(private readonly grants: AppStaffGrantsService) {}

  @Get()
  @RequirePermissions('biz:staff:grant')
  @ApiOperation({ summary: '美甲师工作台开通申请列表' })
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
    description:
      '申请状态 pending / active / rejected；不传=全部（不含未申请）',
  })
  @ApiResponse({ status: 200, description: '成功' })
  list(
    @Query('page') rawPage?: string,
    @Query('pageSize') rawPageSize?: string,
    @Query('status') status?: string,
  ) {
    const { page, pageSize } = parsePagination(rawPage, rawPageSize);
    // 白名单：非法值当未传（与其它列表页口径一致）
    const allowed: GrantStatus[] = ['pending', 'active', 'rejected'];
    return this.grants.list(page, pageSize, {
      status: allowed.includes(status as GrantStatus)
        ? (status as GrantStatus)
        : undefined,
    });
  }

  @Post(':id/approve')
  @RequirePermissions('biz:staff:grant')
  @ApiOperation({
    summary: '通过开通申请',
    description:
      '置 `staff_status=active` 并记录决策人 / 时间；已通过则幂等返回。' +
      '档案停用或已删除时直接 409 —— 批了也进不去工作台，不如现在讲清楚。',
  })
  @ApiParam({ name: 'id', description: '申请ID（app_wx_user.id）' })
  @ApiResponse({ status: 200, description: '成功' })
  @ApiResponse({ status: 404, description: '申请不存在' })
  @ApiResponse({ status: 409, description: '已驳回 / 档案不可用时拒绝' })
  approve(@Param('id', ParseIntPipe) id: number, @Req() request: AuthRequest) {
    return this.grants.approve(id, request.user.id);
  }

  @Post(':id/reject')
  @RequirePermissions('biz:staff:grant')
  @ApiOperation({
    summary: '驳回开通申请',
    description:
      '置 `staff_status=rejected` 并记录原因（小程序端可见）与决策人 / 时间；已驳回则幂等返回。',
  })
  @ApiParam({ name: 'id', description: '申请ID（app_wx_user.id）' })
  @ApiBody({
    schema: { $ref: '#/components/schemas/AppStaffGrantRejectRequest' },
  })
  @ApiResponse({ status: 200, description: '成功' })
  @ApiResponse({ status: 400, description: '未填写驳回原因' })
  @ApiResponse({ status: 404, description: '申请不存在' })
  @ApiResponse({ status: 409, description: '已开通的授权不能驳回' })
  reject(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    const { reason } = rejectSchema.parse(body);
    return this.grants.reject(id, reason, request.user.id);
  }
}
