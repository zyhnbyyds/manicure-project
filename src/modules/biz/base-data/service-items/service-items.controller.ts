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
import { RequirePermissions } from '../../../../common/auth/permissions.decorator.js';
import { registerComponent } from '../../../../common/swagger/zod-schema.helper.js';
import { parsePagination } from '../../common/query.js';
import {
  ServiceItemsService,
  type ServiceItemListFilter,
} from './service-items.service.js';

const createSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(50)
    .openapi({ example: '基础美甲', description: '项目名称' }),
  category: z
    .string()
    .max(30)
    .nullish()
    .openapi({ example: '基础', description: '分类' }),
  durationMinutes: z
    .number()
    .int()
    .min(1)
    .max(1440)
    .openapi({ example: 60, description: '标准时长（分钟），决定占用时段' }),
  bufferMinutes: z
    .number()
    .int()
    .min(0)
    .max(240)
    .optional()
    .openapi({ example: 15, description: '缓冲时长（分钟），参与冲突判定' }),
  price: z
    .number()
    .int()
    .min(0)
    .optional()
    .openapi({ example: 12800, description: '价格（分）' }),
  description: z
    .string()
    .max(500)
    .nullish()
    .openapi({ example: '含卸甲与基础护理', description: '说明' }),
  image: z.string().max(500).nullish().openapi({ description: '展示图' }),
  status: z
    .enum(['active', 'disabled'])
    .optional()
    .openapi({ example: 'active', description: '状态，停用后不可被预约' }),
  sort: z
    .number()
    .int()
    .optional()
    .openapi({ example: 0, description: '排序' }),
  remark: z.string().max(500).nullish().openapi({ description: '备注' }),
});

const updateSchema = createSchema.partial();

registerComponent('CreateServiceItemRequest', createSchema);
registerComponent('UpdateServiceItemRequest', updateSchema);

type AuthRequest = { user: { id: number } };

@ApiTags('服务项目')
@ApiBearerAuth('access-token')
@Controller('biz/service-items')
export class ServiceItemsController {
  constructor(private readonly serviceItems: ServiceItemsService) {}

  @Get()
  @RequirePermissions('biz:serviceitem:list')
  @ApiOperation({ summary: '服务项目列表' })
  @ApiQuery({ name: 'page', required: false, description: '页码', example: 1 })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: '每页条数',
    example: 20,
  })
  @ApiQuery({ name: 'keyword', required: false, description: '项目名模糊匹配' })
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
    const filter: ServiceItemListFilter = {};
    if (keyword) filter.keyword = keyword;
    if (status === 'active' || status === 'disabled') filter.status = status;
    return this.serviceItems.list(page, pageSize, filter);
  }

  @Get(':id')
  @RequirePermissions('biz:serviceitem:list')
  @ApiOperation({ summary: '服务项目详情' })
  @ApiParam({ name: 'id', description: '项目ID' })
  @ApiResponse({ status: 200, description: '成功' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.serviceItems.findOne(id);
  }

  @Post()
  @RequirePermissions('biz:serviceitem:create')
  @ApiOperation({ summary: '新增服务项目' })
  @ApiBody({
    schema: { $ref: '#/components/schemas/CreateServiceItemRequest' },
  })
  @ApiResponse({ status: 200, description: '成功' })
  create(@Body() body: unknown, @Req() request: AuthRequest) {
    return this.serviceItems.create(createSchema.parse(body), request.user.id);
  }

  @Patch(':id')
  @RequirePermissions('biz:serviceitem:update')
  @ApiOperation({ summary: '修改服务项目' })
  @ApiParam({ name: 'id', description: '项目ID' })
  @ApiBody({
    schema: { $ref: '#/components/schemas/UpdateServiceItemRequest' },
  })
  @ApiResponse({ status: 200, description: '成功' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    return this.serviceItems.update(
      id,
      updateSchema.parse(body),
      request.user.id,
    );
  }

  @Delete(':id')
  @RequirePermissions('biz:serviceitem:delete')
  @ApiOperation({ summary: '删除服务项目（被未完成预约引用时 409）' })
  @ApiParam({ name: 'id', description: '项目ID' })
  @ApiResponse({ status: 200, description: '成功' })
  @ApiResponse({ status: 409, description: '存在引用该项目的未完成预约' })
  remove(@Param('id', ParseIntPipe) id: number, @Req() request: AuthRequest) {
    return this.serviceItems.remove(id, request.user.id);
  }
}
