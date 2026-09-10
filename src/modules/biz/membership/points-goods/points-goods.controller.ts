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
import { PointsGoodsService } from './points-goods.service';

const createSchema = z.object({
  name: z.string().min(1).max(50),
  cardTypeId: z.number().int().positive(),
  points: z.number().int().min(1),
  stock: z.number().int().min(-1).optional(),
  perLimit: z.number().int().min(0).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  sort: z.number().int().min(0).optional(),
  remark: z.string().max(200).nullable().optional(),
});
const updateSchema = createSchema.partial();

registerComponent('CreatePointsGoodsRequest', createSchema);
registerComponent('UpdatePointsGoodsRequest', updateSchema);

type AuthRequest = { user: { id: number } };

@ApiTags('积分兑换品')
@ApiBearerAuth('access-token')
@Controller('biz/points-goods')
export class PointsGoodsController {
  constructor(private readonly goods: PointsGoodsService) {}

  @Get()
  @RequirePermissions('biz:pointsgoods:list')
  @ApiOperation({ summary: '兑换品列表（含所需积分、库存、限兑）' })
  @ApiQuery({ name: 'page', required: false, description: '页码' })
  @ApiQuery({ name: 'pageSize', required: false, description: '每页条数' })
  @ApiQuery({ name: 'status', required: false, description: '状态' })
  @ApiQuery({ name: 'keyword', required: false, description: '名称（模糊）' })
  @ApiResponse({ status: 200, description: '成功' })
  list(
    @Query('page') rawPage?: string,
    @Query('pageSize') rawPageSize?: string,
    @Query('status') status?: string,
    @Query('keyword') keyword?: string,
  ) {
    const { page, pageSize } = parsePagination(rawPage, rawPageSize);
    return this.goods.list(page, pageSize, {
      status: status === 'active' || status === 'disabled' ? status : undefined,
      keyword: keyword?.trim() || undefined,
    });
  }

  @Get(':id')
  @RequirePermissions('biz:pointsgoods:list')
  @ApiOperation({ summary: '兑换品详情' })
  @ApiParam({ name: 'id', description: '兑换品ID' })
  @ApiResponse({ status: 200, description: '成功' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.goods.findOne(id);
  }

  @Post()
  @RequirePermissions('biz:pointsgoods:create')
  @ApiOperation({ summary: '新增兑换品（指向卡种）' })
  @ApiBody({
    schema: { $ref: '#/components/schemas/CreatePointsGoodsRequest' },
  })
  @ApiResponse({ status: 200, description: '成功' })
  create(@Body() body: unknown, @Req() request: AuthRequest) {
    return this.goods.create(createSchema.parse(body), request.user.id);
  }

  @Patch(':id')
  @RequirePermissions('biz:pointsgoods:update')
  @ApiOperation({ summary: '修改兑换品' })
  @ApiParam({ name: 'id', description: '兑换品ID' })
  @ApiBody({
    schema: { $ref: '#/components/schemas/UpdatePointsGoodsRequest' },
  })
  @ApiResponse({ status: 200, description: '成功' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    return this.goods.update(id, updateSchema.parse(body), request.user.id);
  }

  @Delete(':id')
  @RequirePermissions('biz:pointsgoods:delete')
  @ApiOperation({ summary: '删除兑换品（软删）' })
  @ApiParam({ name: 'id', description: '兑换品ID' })
  @ApiResponse({ status: 200, description: '成功' })
  remove(@Param('id', ParseIntPipe) id: number, @Req() request: AuthRequest) {
    return this.goods.remove(id, request.user.id);
  }
}
