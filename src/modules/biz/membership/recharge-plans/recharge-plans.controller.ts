import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
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
import { RequirePermissions } from '../../../../common/auth/permissions.decorator';
import { registerComponent } from '../../../../common/swagger/zod-schema.helper';
import { parsePagination } from '../../common/query.js';
import { RechargePlansService } from './recharge-plans.service';

const createSchema = z.object({
  name: z.string().min(1).max(30),
  payAmount: z.number().int().min(1),
  bonusAmount: z.number().int().min(0).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  sort: z.number().int().min(0).optional(),
  remark: z.string().max(200).nullable().optional(),
});
const updateSchema = createSchema.partial();

registerComponent('CreateRechargePlanRequest', createSchema);
registerComponent('UpdateRechargePlanRequest', updateSchema);

type AuthRequest = { user: { id: number } };

@ApiTags('充值方案')
@ApiBearerAuth('access-token')
@Controller('biz/recharge-plans')
export class RechargePlansController {
  constructor(private readonly plans: RechargePlansService) {}

  @Get()
  @RequirePermissions('biz:rechargeplan:list')
  @ApiOperation({ summary: '充值方案列表' })
  @ApiQuery({ name: 'page', required: false, description: '页码' })
  @ApiQuery({ name: 'pageSize', required: false, description: '每页条数' })
  @ApiQuery({ name: 'status', required: false, description: '状态' })
  @ApiResponse({ status: 200, description: '成功' })
  list(
    @Query('page') rawPage?: string,
    @Query('pageSize') rawPageSize?: string,
    @Query('status') status?: string,
  ) {
    const { page, pageSize } = parsePagination(rawPage, rawPageSize);
    return this.plans.list(page, pageSize, {
      status: status === 'active' || status === 'disabled' ? status : undefined,
    });
  }

  @Get(':id')
  @RequirePermissions('biz:rechargeplan:list')
  @ApiOperation({ summary: '充值方案详情' })
  @ApiParam({ name: 'id', description: '方案ID' })
  @ApiResponse({ status: 200, description: '成功' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.plans.findOne(id);
  }

  @Post()
  @RequirePermissions('biz:rechargeplan:create')
  @ApiOperation({ summary: '新增充值方案（赠送比例上限校验）' })
  @ApiBody({
    schema: { $ref: '#/components/schemas/CreateRechargePlanRequest' },
  })
  @ApiResponse({ status: 200, description: '成功' })
  create(@Body() body: unknown, @Req() request: AuthRequest) {
    return this.plans.create(createSchema.parse(body), request.user.id);
  }

  @Patch(':id')
  @RequirePermissions('biz:rechargeplan:update')
  @ApiOperation({ summary: '修改充值方案' })
  @ApiParam({ name: 'id', description: '方案ID' })
  @ApiBody({
    schema: { $ref: '#/components/schemas/UpdateRechargePlanRequest' },
  })
  @ApiResponse({ status: 200, description: '成功' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    return this.plans.update(id, updateSchema.parse(body), request.user.id);
  }

  @Delete(':id')
  @RequirePermissions('biz:rechargeplan:delete')
  @ApiOperation({ summary: '删除充值方案' })
  @ApiParam({ name: 'id', description: '方案ID' })
  @ApiResponse({ status: 200, description: '成功' })
  remove(@Param('id', ParseIntPipe) id: number, @Req() request: AuthRequest) {
    return this.plans.remove(id, request.user.id);
  }
}
