import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import type { RequestActor } from '../../../../common/data-scope/data-scope.js';
import { RequirePermissions } from '../../../../common/auth/permissions.decorator.js';
import { registerComponent } from '../../../../common/swagger/zod-schema.helper.js';
import { parsePagination } from '../../common/query.js';
import { StoresService } from './stores.service.js';

const createSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(32)
    .openapi({ example: 'MAIN', description: '门店编码（唯一，对账/单号用）' }),
  name: z.string().min(1).max(50).openapi({ example: '南京西路店' }),
  nameEn: z.string().max(50).nullish().openapi({ example: 'BEAUTY NAILS' }),
  phone: z.string().max(20).nullish().openapi({ example: '021-62888888' }),
  address: z
    .string()
    .max(200)
    .nullish()
    .openapi({ example: '南京西路 1788 号 3 楼' }),
  hours: z.string().max(50).nullish().openapi({ example: '10:00 - 20:00' }),
  latitude: z.number().min(-90).max(90).nullish().openapi({ example: 31.229 }),
  longitude: z
    .number()
    .min(-180)
    .max(180)
    .nullish()
    .openapi({ example: 121.455 }),
  notice: z
    .string()
    .max(500)
    .nullish()
    .openapi({ description: '公告 / 到店须知' }),
  timezone: z
    .string()
    .max(64)
    .nullish()
    .openapi({ description: '门店时区（留空 = 用全局 biz.booking.timezone）' }),
  status: z.enum(['active', 'disabled']).optional(),
  sort: z.number().int().min(0).optional(),
  isDefault: z
    .boolean()
    .optional()
    .openapi({ description: '设为默认门店（同顾客最多一个，事务保证）' }),
  remark: z.string().max(200).nullish(),
});

const updateSchema = createSchema.partial();

/** 与其它后台 controller 同款：只取审计需要的当前用户 / 门店上下文 */
type AuthRequest = { user: RequestActor };

registerComponent('CreateStoreRequest', createSchema);
registerComponent('UpdateStoreRequest', updateSchema);

/**
 * 门店档案（连锁直营）。
 *
 * 权限点用 `system:store:*`：门店是**总部配置**（店长自己改不了自己门店的名称/坐标）。
 * 例外是 `GET /stores/mine` —— 顶栏门店切换器要用，登录即可访问（见方法注释）。
 */
@ApiTags('门店')
@ApiBearerAuth('access-token')
@Controller('stores')
export class StoresController {
  constructor(private readonly stores: StoresService) {}

  @Get()
  @RequirePermissions('system:store:list')
  @ApiOperation({ summary: '门店列表（含停用，默认门店排最前）' })
  @ApiQuery({ name: 'page', required: false, description: '页码', example: 1 })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: '每页条数',
    example: 20,
  })
  @ApiResponse({ status: 200, description: '成功' })
  list(
    @Query('page') rawPage?: string,
    @Query('pageSize') rawPageSize?: string,
  ) {
    const { page, pageSize } = parsePagination(rawPage, rawPageSize);
    return this.stores.list(page, pageSize);
  }

  @Get('mine')
  @ApiOperation({
    summary: '我可见的门店（后台顶栏门店切换器）',
    description:
      '登录即可访问，**不需要** `system:store:list`：店长也要在顶栏看到自己门店的名字。\n\n' +
      '- `scope=all`：可看全部门店（超管 / `system:store:all`），选项里会多一个「全部门店」\n' +
      '- `scope=stores`：只回授权的门店；`scope=none`：一家可用的都没有（前端常驻提示）\n' +
      '- `activeStoreId`：当前选中的门店（来自 `x-store-id` 头），已复核可见性；' +
      '门店被停用/删除或授权被收回时归一回 `null`\n' +
      '- **不传 `x-store-id` 时，列表口径与升级前完全一致**（超管看全部、店长看可见集合）',
  })
  @ApiResponse({ status: 200, description: '成功' })
  listMine(@Req() request: AuthRequest) {
    return this.stores.listMine(request.user);
  }

  @Post()
  @RequirePermissions('system:store:create')
  @ApiOperation({
    summary: '新建门店',
    description: '第一条门店**自动成为默认门店**；`code` 唯一。',
  })
  @ApiBody({ schema: { $ref: '#/components/schemas/CreateStoreRequest' } })
  @ApiResponse({ status: 201, description: '成功' })
  create(@Body() body: unknown, @Req() request: AuthRequest) {
    return this.stores.create(createSchema.parse(body), request.user.id);
  }

  @Patch(':id')
  @RequirePermissions('system:store:update')
  @ApiOperation({ summary: '修改门店' })
  @ApiParam({ name: 'id', description: '门店 ID', example: 1 })
  @ApiBody({ schema: { $ref: '#/components/schemas/UpdateStoreRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    await this.stores.update(id, updateSchema.parse(body), request.user.id);
    return { ok: true };
  }

  @Post(':id/default')
  @HttpCode(200)
  @RequirePermissions('system:store:update')
  @ApiOperation({
    summary: '设为默认门店',
    description: '把该门店设为默认，并清掉原本的默认（同一事务）。',
  })
  @ApiParam({ name: 'id', description: '门店 ID', example: 1 })
  @ApiResponse({ status: 200, description: '成功' })
  async setDefault(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: AuthRequest,
  ) {
    await this.stores.setDefault(id, request.user.id);
    return { ok: true };
  }

  @Delete(':id')
  @RequirePermissions('system:store:delete')
  @ApiOperation({
    summary: '删除门店（软删）',
    description: '默认门店不允许删除 —— 删了就没有兜底门店了，先切默认再删。',
  })
  @ApiParam({ name: 'id', description: '门店 ID', example: 1 })
  @ApiResponse({ status: 200, description: '成功' })
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: AuthRequest,
  ) {
    await this.stores.remove(id, request.user.id);
    return { ok: true };
  }
}
