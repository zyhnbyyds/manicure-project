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
import { RequirePermissions } from '../../../../common/auth/permissions.decorator.js';
import { registerComponent } from '../../../../common/swagger/zod-schema.helper.js';
import { parsePagination } from '../../common/query.js';
import { SETTLE_CHANNELS, ReceivablesService } from './receivables.service.js';

const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ example: '2026-09-30', description: '店内本地日 YYYY-MM-DD' });

const listQuerySchema = z.object({
  creditAccountId: z.coerce.number().int().positive().optional(),
  status: z
    .enum(['open', 'partial', 'settled', 'overdue', 'cancelled'])
    .optional(),
  dueDateFrom: localDate.optional(),
  dueDateTo: localDate.optional(),
  overdue: z.enum(['true', 'false', '1', '0']).optional(),
});

const settleSchema = z.object({
  payments: z
    .array(
      z.object({
        channel: z.enum(SETTLE_CHANNELS).openapi({
          example: 'cash',
          description:
            '销账渠道：现金/线下微信/线下支付宝/储值/微信 Native/支付宝当面付',
        }),
        amount: z
          .number()
          .int()
          .positive()
          .openapi({ example: 150000, description: '本次销账金额（分）' }),
        remark: z.string().max(200).nullable().optional(),
      }),
    )
    .min(1)
    .openapi({ description: '销账明细，支持多笔混合' }),
  remark: z
    .string()
    .max(200)
    .optional()
    .openapi({ example: '月底结清', description: '整单备注' }),
});

const cancelSchema = z.object({
  reason: z
    .string()
    .min(1)
    .max(200)
    .openapi({ example: '单据重复', description: '作废原因（必填）' }),
});

registerComponent('SettleReceivableRequest', settleSchema);
registerComponent('CancelReceivableRequest', cancelSchema);

type AuthRequest = { user: { id: number } };

@ApiTags('应收台账')
@ApiBearerAuth('access-token')
@Controller('biz/receivables')
export class ReceivablesController {
  constructor(private readonly receivables: ReceivablesService) {}

  // 注意：`summary` 必须声明在 `:id` 之前，否则会被 `:id` 路由吞掉
  @Get('summary')
  @RequirePermissions('biz:receivable:list')
  @ApiOperation({
    summary: '挂账汇总（按主体账龄 0-30 / 31-60 / 60+ 与逾期金额）',
  })
  @ApiResponse({ status: 200, description: '成功' })
  summary() {
    return this.receivables.summary();
  }

  @Get()
  @RequirePermissions('biz:receivable:list')
  @ApiOperation({ summary: '应收台账列表' })
  @ApiQuery({ name: 'page', required: false, description: '页码', example: 1 })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: '每页条数',
    example: 20,
  })
  @ApiQuery({
    name: 'creditAccountId',
    required: false,
    description: '挂账主体',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'open/partial/settled/overdue/cancelled',
  })
  @ApiQuery({
    name: 'dueDateFrom',
    required: false,
    description: '到期日起（YYYY-MM-DD）',
  })
  @ApiQuery({
    name: 'dueDateTo',
    required: false,
    description: '到期日止（YYYY-MM-DD）',
  })
  @ApiQuery({
    name: 'overdue',
    required: false,
    description: 'true → 只看已过到期日且未结',
  })
  @ApiResponse({ status: 200, description: '成功' })
  list(
    @Query('page') rawPage?: string,
    @Query('pageSize') rawPageSize?: string,
    @Query('creditAccountId') rawCreditAccountId?: string,
    @Query('status') status?: string,
    @Query('dueDateFrom') dueDateFrom?: string,
    @Query('dueDateTo') dueDateTo?: string,
    @Query('overdue') rawOverdue?: string,
  ) {
    const { page, pageSize } = parsePagination(rawPage, rawPageSize);
    const query = listQuerySchema.parse({
      creditAccountId: rawCreditAccountId,
      status,
      dueDateFrom,
      dueDateTo,
      overdue: rawOverdue,
    });
    return this.receivables.list(page, pageSize, {
      creditAccountId: query.creditAccountId,
      status: query.status,
      dueDateFrom: query.dueDateFrom,
      dueDateTo: query.dueDateTo,
      overdue: query.overdue === 'true' || query.overdue === '1',
    });
  }

  @Get(':id')
  @RequirePermissions('biz:receivable:list')
  @ApiOperation({ summary: '应收单详情（含销账记录）' })
  @ApiParam({ name: 'id', description: '应收单ID' })
  @ApiResponse({ status: 200, description: '成功' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.receivables.findOne(id);
  }

  @Post(':id/settle')
  @RequirePermissions('biz:receivable:settle')
  @ApiOperation({ summary: '销账（多笔混合；在线渠道返回二维码）' })
  @ApiParam({ name: 'id', description: '应收单ID' })
  @ApiBody({ schema: { $ref: '#/components/schemas/SettleReceivableRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  settle(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    const input = settleSchema.parse(body);
    return this.receivables.settle(id, {
      payments: input.payments,
      remark: input.remark,
      actorId: request.user.id,
    });
  }

  @Post(':id/cancel')
  @RequirePermissions('biz:receivable:cancel')
  @ApiOperation({ summary: '作废应收单（必填原因，仅未销账时）' })
  @ApiParam({ name: 'id', description: '应收单ID' })
  @ApiBody({ schema: { $ref: '#/components/schemas/CancelReceivableRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  cancel(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    const input = cancelSchema.parse(body);
    return this.receivables.cancel(id, input.reason, request.user.id);
  }
}
