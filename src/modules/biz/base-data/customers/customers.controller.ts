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
  CustomersService,
  type CustomerListFilter,
} from './customers.service.js';

const createSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(50)
    .openapi({ example: '张女士', description: '姓名 / 称呼' }),
  phone: z
    .string()
    .max(20)
    .nullish()
    .openapi({ example: '13800000002', description: '手机号（唯一，可空=散客）' }),
  gender: z
    .enum(['unknown', 'male', 'female'])
    .optional()
    .openapi({ example: 'female', description: '性别' }),
  birthday: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish()
    .openapi({ example: '1995-08-08', description: '生日 YYYY-MM-DD' }),
  remark: z
    .string()
    .max(500)
    .nullish()
    .openapi({ example: '偏好裸色系', description: '备注' }),
});

const updateSchema = createSchema.partial();

registerComponent('CreateCustomerRequest', createSchema);
registerComponent('UpdateCustomerRequest', updateSchema);

type AuthRequest = { user: { id: number } };

@ApiTags('顾客')
@ApiBearerAuth('access-token')
@Controller('biz/customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermissions('biz:customer:list')
  @ApiOperation({ summary: '顾客列表' })
  @ApiQuery({ name: 'page', required: false, description: '页码', example: 1 })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: '每页条数',
    example: 20,
  })
  @ApiQuery({ name: 'keyword', required: false, description: '姓名 / 手机号' })
  @ApiQuery({ name: 'levelId', required: false, description: '会员等级ID' })
  @ApiQuery({
    name: 'hasBalance',
    required: false,
    description: '是否有储值余额 true / false',
  })
  @ApiResponse({ status: 200, description: '成功' })
  list(
    @Query('page') rawPage?: string,
    @Query('pageSize') rawPageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('levelId') rawLevelId?: string,
    @Query('hasBalance') rawHasBalance?: string,
  ) {
    const { page, pageSize } = parsePagination(rawPage, rawPageSize);
    const filter: CustomerListFilter = {};
    if (keyword) filter.keyword = keyword;
    const levelId = Number(rawLevelId);
    if (rawLevelId && Number.isInteger(levelId) && levelId > 0)
      filter.levelId = levelId;
    if (rawHasBalance === 'true' || rawHasBalance === '1')
      filter.hasBalance = true;
    else if (rawHasBalance === 'false' || rawHasBalance === '0')
      filter.hasBalance = false;
    return this.customers.list(page, pageSize, filter);
  }

  @Get(':id/bookings')
  @RequirePermissions('biz:customer:list')
  @ApiOperation({ summary: '顾客历史预约' })
  @ApiParam({ name: 'id', description: '顾客ID' })
  @ApiQuery({ name: 'page', required: false, description: '页码', example: 1 })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: '每页条数',
    example: 20,
  })
  @ApiResponse({ status: 200, description: '成功' })
  listBookings(
    @Param('id', ParseIntPipe) id: number,
    @Query('page') rawPage?: string,
    @Query('pageSize') rawPageSize?: string,
  ) {
    const { page, pageSize } = parsePagination(rawPage, rawPageSize);
    return this.customers.listBookings(id, page, pageSize);
  }

  @Get(':id')
  @RequirePermissions('biz:customer:list')
  @ApiOperation({ summary: '顾客详情' })
  @ApiParam({ name: 'id', description: '顾客ID' })
  @ApiResponse({ status: 200, description: '成功' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.customers.findOne(id);
  }

  @Post()
  @RequirePermissions('biz:customer:create')
  @ApiOperation({ summary: '新增顾客（手机号重复时 409）' })
  @ApiBody({ schema: { $ref: '#/components/schemas/CreateCustomerRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  @ApiResponse({ status: 409, description: '手机号已被占用 / 属于已删除顾客' })
  create(@Body() body: unknown, @Req() request: AuthRequest) {
    return this.customers.create(createSchema.parse(body), request.user.id);
  }

  @Patch(':id')
  @RequirePermissions('biz:customer:update')
  @ApiOperation({ summary: '修改顾客' })
  @ApiParam({ name: 'id', description: '顾客ID' })
  @ApiBody({ schema: { $ref: '#/components/schemas/UpdateCustomerRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    return this.customers.update(id, updateSchema.parse(body), request.user.id);
  }

  @Post(':id/recount')
  @RequirePermissions('biz:customer:update')
  @ApiOperation({ summary: '重算到店次数 / 最近到店时间（对账修复，幂等）' })
  @ApiParam({ name: 'id', description: '顾客ID' })
  @ApiResponse({ status: 200, description: '成功' })
  recount(@Param('id', ParseIntPipe) id: number, @Req() request: AuthRequest) {
    return this.customers.recount(id, request.user.id);
  }

  @Delete(':id')
  @RequirePermissions('biz:customer:delete')
  @ApiOperation({ summary: '删除顾客（存在预约记录时 409）' })
  @ApiParam({ name: 'id', description: '顾客ID' })
  @ApiResponse({ status: 200, description: '成功' })
  @ApiResponse({ status: 409, description: '存在预约记录' })
  remove(@Param('id', ParseIntPipe) id: number, @Req() request: AuthRequest) {
    return this.customers.remove(id, request.user.id);
  }
}
