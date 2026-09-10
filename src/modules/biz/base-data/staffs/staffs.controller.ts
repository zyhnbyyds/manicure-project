import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
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
import { RequirePermissions } from '../../../../common/auth/permissions.decorator.js';
import { registerComponent } from '../../../../common/swagger/zod-schema.helper.js';
import { parsePagination } from '../../common/query.js';
import { StaffsService, type StaffListFilter } from './staffs.service.js';

const createSchema = z.object({
  userId: z
    .number()
    .int()
    .positive()
    .nullish()
    .openapi({ example: 3, description: '关联后台账号（可空）' }),
  nickname: z
    .string()
    .min(1)
    .max(50)
    .openapi({ example: '小美', description: '昵称 / 艺名' }),
  avatar: z.string().max(500).nullish().openapi({ description: '头像' }),
  phone: z
    .string()
    .max(20)
    .nullish()
    .openapi({ example: '13800000001', description: '联系电话' }),
  bio: z.string().max(500).nullish().openapi({ description: '简介 / 擅长' }),
  status: z.enum(['active', 'disabled']).optional().openapi({
    example: 'active',
    description: '状态，停用后不再出现在可约列表',
  }),
  sort: z
    .number()
    .int()
    .optional()
    .openapi({ example: 0, description: '排序' }),
  remark: z.string().max(500).nullish().openapi({ description: '备注' }),
});

const updateSchema = createSchema.partial();

const setServiceItemsSchema = z.object({
  serviceItemIds: z.array(z.number().int().positive()).openapi({
    example: [1, 2],
    description: '可做项目 id；空数组 = 可做全部项目（§22）',
  }),
});

registerComponent('CreateStaffRequest', createSchema);
registerComponent('UpdateStaffRequest', updateSchema);
registerComponent('SetStaffServiceItemsRequest', setServiceItemsSchema);

type AuthRequest = { user: { id: number } };

@ApiTags('美甲师')
@ApiBearerAuth('access-token')
@Controller('biz/staffs')
export class StaffsController {
  constructor(private readonly staffs: StaffsService) {}

  @Get()
  @RequirePermissions('biz:staff:list')
  @ApiOperation({ summary: '美甲师列表' })
  @ApiQuery({ name: 'page', required: false, description: '页码', example: 1 })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: '每页条数',
    example: 20,
  })
  @ApiQuery({ name: 'keyword', required: false, description: '昵称/手机号' })
  @ApiQuery({
    name: 'status',
    required: false,
    description: '状态 active / disabled',
  })
  @ApiResponse({ status: 200, description: '成功' })
  list(
    @Query('page') rawPage?: string,
    @Query('pageSize') rawPageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('status') status?: string,
  ) {
    const { page, pageSize } = parsePagination(rawPage, rawPageSize);
    const filter: StaffListFilter = {};
    if (keyword) filter.keyword = keyword;
    if (status === 'active' || status === 'disabled') filter.status = status;
    return this.staffs.list(page, pageSize, filter);
  }

  @Get(':id/service-items')
  @RequirePermissions('biz:staff:list')
  @ApiOperation({ summary: '美甲师可做项目（空数组 = 可做全部）' })
  @ApiParam({ name: 'id', description: '美甲师ID' })
  @ApiResponse({ status: 200, description: '成功' })
  getServiceItems(@Param('id', ParseIntPipe) id: number) {
    return this.staffs.getServiceItems(id);
  }

  @Put(':id/service-items')
  @RequirePermissions('biz:staff:items')
  @ApiOperation({ summary: '整体替换美甲师可做项目（空数组 = 可做全部）' })
  @ApiParam({ name: 'id', description: '美甲师ID' })
  @ApiBody({
    schema: { $ref: '#/components/schemas/SetStaffServiceItemsRequest' },
  })
  @ApiResponse({ status: 200, description: '成功' })
  async setServiceItems(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    const { serviceItemIds } = setServiceItemsSchema.parse(body);
    await this.staffs.setServiceItems(id, serviceItemIds, request.user.id);
    return { success: true, count: serviceItemIds.length };
  }

  @Get(':id')
  @RequirePermissions('biz:staff:list')
  @ApiOperation({ summary: '美甲师详情' })
  @ApiParam({ name: 'id', description: '美甲师ID' })
  @ApiResponse({ status: 200, description: '成功' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.staffs.findOne(id);
  }

  @Post()
  @RequirePermissions('biz:staff:create')
  @ApiOperation({ summary: '新增美甲师' })
  @ApiBody({ schema: { $ref: '#/components/schemas/CreateStaffRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  create(@Body() body: unknown, @Req() request: AuthRequest) {
    return this.staffs.create(createSchema.parse(body), request.user.id);
  }

  @Patch(':id')
  @RequirePermissions('biz:staff:update')
  @ApiOperation({ summary: '修改美甲师' })
  @ApiParam({ name: 'id', description: '美甲师ID' })
  @ApiBody({ schema: { $ref: '#/components/schemas/UpdateStaffRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    return this.staffs.update(id, updateSchema.parse(body), request.user.id);
  }

  @Delete(':id')
  @RequirePermissions('biz:staff:delete')
  @ApiOperation({ summary: '删除美甲师（存在未完成预约时 409）' })
  @ApiParam({ name: 'id', description: '美甲师ID' })
  @ApiResponse({ status: 200, description: '成功' })
  @ApiResponse({ status: 409, description: '存在未完成预约' })
  remove(@Param('id', ParseIntPipe) id: number, @Req() request: AuthRequest) {
    return this.staffs.remove(id, request.user.id);
  }
}
