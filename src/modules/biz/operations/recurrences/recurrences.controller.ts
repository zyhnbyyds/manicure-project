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
import { MAX_PAGE_SIZE } from '../../common/query.js';
import { RecurrencesService } from './recurrences.service.js';

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME = /^\d{2}:\d{2}(:\d{2})?$/;

const createSchema = z.object({
  name: z
    .string()
    .max(50)
    .nullable()
    .optional()
    .openapi({ example: '张女士每周三', description: '备注名' }),
  customerId: z.coerce.number().int().positive(),
  staffId: z.coerce.number().int().positive(),
  serviceItemIds: z
    .array(z.coerce.number().int().positive())
    .min(1)
    .max(3)
    .openapi({ description: '项目 id 数组，顺序即服务顺序' }),
  weekday: z.coerce
    .number()
    .int()
    .min(1)
    .max(7)
    .openapi({ example: 3, description: '1=周一 … 7=周日（ISO 8601）' }),
  startTime: z
    .string()
    .regex(LOCAL_TIME)
    .openapi({ example: '15:00', description: '店内本地开始时间' }),
  startDate: z.string().regex(LOCAL_DATE).openapi({ example: '2026-09-16' }),
  endDate: z
    .string()
    .regex(LOCAL_DATE)
    .nullable()
    .optional()
    .openapi({ description: '生效截止日，空 = 不限期' }),
  generateDays: z.coerce
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .openapi({ example: 30, description: '滚动生成天数' }),
  conflictPolicy: z
    .enum(['skip', 'notify'])
    .optional()
    .openapi({ description: '撞已有预约：跳过 / 照旧生成并标记待人工处理' }),
  remark: z.string().max(200).nullable().optional(),
});

const updateSchema = createSchema.partial();

/** 列表筛选项：前端清空下拉框会发空字符串，统一按「不筛选」处理 */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (value) => (value === '' || value === null ? undefined : value),
    schema.optional(),
  );

const listQuerySchema = z.object({
  page: optional(z.coerce.number().int().min(1)),
  pageSize: optional(z.coerce.number().int().min(1).max(MAX_PAGE_SIZE)),
  status: optional(z.enum(['active', 'paused', 'stopped'])),
  customerId: optional(z.coerce.number().int().positive()),
  staffId: optional(z.coerce.number().int().positive()),
});

const bookingsQuerySchema = z.object({
  page: optional(z.coerce.number().int().min(1)),
  pageSize: optional(z.coerce.number().int().min(1).max(MAX_PAGE_SIZE)),
});

registerComponent('CreateRecurrenceRequest', createSchema);
registerComponent('UpdateRecurrenceRequest', updateSchema);

type AuthRequest = { user: { id: number } };

@ApiTags('周期预约')
@ApiBearerAuth('access-token')
@Controller('biz/recurrences')
export class RecurrencesController {
  constructor(private readonly recurrences: RecurrencesService) {}

  @Get()
  @RequirePermissions('biz:recurrence:list')
  @ApiOperation({ summary: '周期规则列表（含 generatedUntil 与下次生成日）' })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'active / paused / stopped',
  })
  @ApiResponse({ status: 200, description: '成功' })
  list(@Query() query: unknown) {
    const filter = listQuerySchema.parse(query);
    return this.recurrences.list(
      filter.page ?? 1,
      filter.pageSize ?? 20,
      filter,
    );
  }

  @Post()
  @RequirePermissions('biz:recurrence:create')
  @ApiOperation({ summary: '创建周期规则并立即生成第一个窗口' })
  @ApiBody({ schema: { $ref: '#/components/schemas/CreateRecurrenceRequest' } })
  @ApiResponse({
    status: 200,
    description: '返回 { id, generated, skipped, conflicts }',
  })
  create(@Body() body: unknown, @Req() request: AuthRequest) {
    return this.recurrences.create(createSchema.parse(body), request.user.id);
  }

  @Get(':id/bookings')
  @RequirePermissions('biz:recurrence:list')
  @ApiOperation({ summary: '该规则已生成的预约' })
  @ApiParam({ name: 'id', description: '规则ID' })
  @ApiResponse({ status: 200, description: '成功' })
  listBookings(@Param('id', ParseIntPipe) id: number, @Query() query: unknown) {
    const filter = bookingsQuerySchema.parse(query);
    return this.recurrences.listBookings(
      id,
      filter.page ?? 1,
      filter.pageSize ?? 20,
    );
  }

  @Patch(':id')
  @RequirePermissions('biz:recurrence:update')
  @ApiOperation({ summary: '改规则（只影响未来生成，不回溯已生成的单）' })
  @ApiParam({ name: 'id', description: '规则ID' })
  @ApiBody({ schema: { $ref: '#/components/schemas/UpdateRecurrenceRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    return this.recurrences.update(
      id,
      updateSchema.parse(body),
      request.user.id,
    );
  }

  @Post(':id/pause')
  @RequirePermissions('biz:recurrence:update')
  @ApiOperation({ summary: '暂停生成（已生成的单不受影响）' })
  @ApiParam({ name: 'id', description: '规则ID' })
  @ApiResponse({ status: 200, description: '成功' })
  pause(@Param('id', ParseIntPipe) id: number, @Req() request: AuthRequest) {
    return this.recurrences.pause(id, request.user.id);
  }

  @Post(':id/resume')
  @RequirePermissions('biz:recurrence:update')
  @ApiOperation({ summary: '恢复生成' })
  @ApiParam({ name: 'id', description: '规则ID' })
  @ApiResponse({ status: 200, description: '成功' })
  resume(@Param('id', ParseIntPipe) id: number, @Req() request: AuthRequest) {
    return this.recurrences.resume(id, request.user.id);
  }

  @Post(':id/stop')
  @RequirePermissions('biz:recurrence:update')
  @ApiOperation({ summary: '停止生成（终态）' })
  @ApiParam({ name: 'id', description: '规则ID' })
  @ApiResponse({ status: 200, description: '成功' })
  stop(@Param('id', ParseIntPipe) id: number, @Req() request: AuthRequest) {
    return this.recurrences.stop(id, request.user.id);
  }

  @Post(':id/revoke-window')
  @RequirePermissions('biz:recurrence:update')
  @ApiOperation({ summary: '撤销本窗口生成的单（仅限未被收款的单）' })
  @ApiParam({ name: 'id', description: '规则ID' })
  @ApiResponse({ status: 200, description: '返回 { revoked, from }' })
  revokeWindow(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: AuthRequest,
  ) {
    return this.recurrences.revokeWindow(id, request.user.id);
  }

  @Delete(':id')
  @RequirePermissions('biz:recurrence:delete')
  @ApiOperation({
    summary: '停止并软删规则（已生成的预约保留，recurrence_id 置空）',
  })
  @ApiParam({ name: 'id', description: '规则ID' })
  @ApiResponse({ status: 200, description: '成功' })
  remove(@Param('id', ParseIntPipe) id: number, @Req() request: AuthRequest) {
    return this.recurrences.remove(id, request.user.id);
  }
}
