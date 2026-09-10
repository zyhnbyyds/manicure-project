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
import { CardTypesService } from './card-types.service';

const createSchema = z.object({
  name: z.string().min(1).max(50),
  price: z.number().int().min(0),
  totalTimes: z.number().int().min(1),
  validDays: z.number().int().min(0).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  sort: z.number().int().min(0).optional(),
  remark: z.string().max(200).nullable().optional(),
  serviceItemIds: z.array(z.number().int().positive()).min(1),
});
const updateSchema = createSchema.partial();

registerComponent('CreateCardTypeRequest', createSchema);
registerComponent('UpdateCardTypeRequest', updateSchema);

type AuthRequest = { user: { id: number } };

@ApiTags('次卡卡种')
@ApiBearerAuth('access-token')
@Controller('biz/card-types')
export class CardTypesController {
  constructor(private readonly cardTypes: CardTypesService) {}

  @Get()
  @RequirePermissions('biz:cardtype:list')
  @ApiOperation({ summary: '卡种列表（含适用项目）' })
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
    return this.cardTypes.list(page, pageSize, {
      status: status === 'active' || status === 'disabled' ? status : undefined,
    });
  }

  @Get(':id')
  @RequirePermissions('biz:cardtype:list')
  @ApiOperation({ summary: '卡种详情（含适用项目）' })
  @ApiParam({ name: 'id', description: '卡种ID' })
  @ApiResponse({ status: 200, description: '成功' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.cardTypes.findOne(id);
  }

  @Post()
  @RequirePermissions('biz:cardtype:create')
  @ApiOperation({ summary: '新增卡种 + 适用项目（整体替换）' })
  @ApiBody({ schema: { $ref: '#/components/schemas/CreateCardTypeRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  create(@Body() body: unknown, @Req() request: AuthRequest) {
    return this.cardTypes.create(createSchema.parse(body), request.user.id);
  }

  @Patch(':id')
  @RequirePermissions('biz:cardtype:update')
  @ApiOperation({ summary: '修改卡种（传 serviceItemIds 时整体替换适用项目）' })
  @ApiParam({ name: 'id', description: '卡种ID' })
  @ApiBody({ schema: { $ref: '#/components/schemas/UpdateCardTypeRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    return this.cardTypes.update(id, updateSchema.parse(body), request.user.id);
  }

  @Delete(':id')
  @RequirePermissions('biz:cardtype:delete')
  @ApiOperation({ summary: '删除卡种（软删；已发出的卡不受影响）' })
  @ApiParam({ name: 'id', description: '卡种ID' })
  @ApiResponse({ status: 200, description: '成功' })
  remove(@Param('id', ParseIntPipe) id: number, @Req() request: AuthRequest) {
    return this.cardTypes.remove(id, request.user.id);
  }
}
