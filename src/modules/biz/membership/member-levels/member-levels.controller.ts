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
import { parsePagination } from '../../common/query';
import { MemberLevelsService } from './member-levels.service';

const createSchema = z.object({
  name: z.string().min(1).max(30),
  discountPermille: z.number().int().min(0).max(1000).optional(),
  upgradeAmount: z.number().int().min(0).optional(),
  sort: z.number().int().min(0).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  remark: z.string().max(200).nullable().optional(),
});
const updateSchema = createSchema.partial();

registerComponent('CreateMemberLevelRequest', createSchema);
registerComponent('UpdateMemberLevelRequest', updateSchema);

type AuthRequest = { user: { id: number } };

@ApiTags('会员等级')
@ApiBearerAuth('access-token')
@Controller('biz/member-levels')
export class MemberLevelsController {
  constructor(private readonly levels: MemberLevelsService) {}

  @Get()
  @RequirePermissions('biz:memberlevel:list')
  @ApiOperation({ summary: '会员等级列表' })
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
    return this.levels.list(page, pageSize, {
      status: status === 'active' || status === 'disabled' ? status : undefined,
    });
  }

  @Get(':id')
  @RequirePermissions('biz:memberlevel:list')
  @ApiOperation({ summary: '会员等级详情' })
  @ApiParam({ name: 'id', description: '等级ID' })
  @ApiResponse({ status: 200, description: '成功' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.levels.findOne(id);
  }

  @Post()
  @RequirePermissions('biz:memberlevel:create')
  @ApiOperation({ summary: '新增会员等级（门槛随排序单调校验）' })
  @ApiBody({
    schema: { $ref: '#/components/schemas/CreateMemberLevelRequest' },
  })
  @ApiResponse({ status: 200, description: '成功' })
  create(@Body() body: unknown, @Req() request: AuthRequest) {
    return this.levels.create(createSchema.parse(body), request.user.id);
  }

  @Patch(':id')
  @RequirePermissions('biz:memberlevel:update')
  @ApiOperation({ summary: '修改会员等级' })
  @ApiParam({ name: 'id', description: '等级ID' })
  @ApiBody({
    schema: { $ref: '#/components/schemas/UpdateMemberLevelRequest' },
  })
  @ApiResponse({ status: 200, description: '成功' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    return this.levels.update(id, updateSchema.parse(body), request.user.id);
  }

  @Delete(':id')
  @RequirePermissions('biz:memberlevel:delete')
  @ApiOperation({ summary: '删除会员等级（有会员使用时拒绝）' })
  @ApiParam({ name: 'id', description: '等级ID' })
  @ApiResponse({ status: 200, description: '成功' })
  remove(@Param('id', ParseIntPipe) id: number, @Req() request: AuthRequest) {
    return this.levels.remove(id, request.user.id);
  }
}
