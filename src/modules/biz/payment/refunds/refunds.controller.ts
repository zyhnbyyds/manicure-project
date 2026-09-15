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
import {
  RefundsService,
  type RefundApplyInput,
  type RefundListFilter,
} from './refunds.service.js';

type AuthRequest = {
  user: { id: number; roles: string[]; permissions: string[] };
};

const LIABLES = ['store', 'customer', 'force_majeure'] as const;
const MODES = ['original', 'cash', 'balance'] as const;
const STAGES = ['before_start', 'in_service'] as const;
const REFUND_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'success',
  'failed',
] as const;

const previewSchema = z.object({
  bookingId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ example: 12, description: '预约 ID' }),
  cancelAt: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), '取消时间格式不正确')
    .optional()
    .openapi({
      example: '2026-09-11T10:00:00+08:00',
      description: '取消时点（缺省取当前时间）',
    }),
  liable: z
    .enum(LIABLES)
    .optional()
    .openapi({ example: 'customer', description: '责任归属（默认 customer）' }),
});

const applySchema = z.object({
  paymentId: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .openapi({ example: 33, description: '支付单 ID（与 bookingId 二选一）' }),
  bookingId: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .openapi({ example: 12, description: '预约 ID' }),
  amount: z.coerce.number().int().positive().optional().openapi({
    example: 10000,
    description:
      '退款金额（分）。服务开始前忽略（强制全额退）；服务中为店长手动填写的金额',
  }),
  actualAmount: z.coerce.number().int().min(0).optional().openapi({
    example: 10000,
    description: '同 amount（服务中手动退款时二者相同）',
  }),
  mode: z.enum(MODES).openapi({ example: 'original', description: '退款去向' }),
  reason: z.string().min(2).max(200).openapi({
    example: '顾客取消预约',
    description: '退款原因（必填）',
  }),
  liable: z.enum(LIABLES).optional().openapi({
    example: 'store',
    description: '责任归属（服务开始前固定 store；服务中由店长指定）',
  }),
  policyId: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .openapi({ example: 2, description: '指定判责规则（可选）' }),
});

const listQuerySchema = z.object({
  storeId: z.coerce.number().int().positive().optional().openapi({
    description:
      '门店筛选：超管/`system:store:all` 可查任意门店；普通账号只能筛可见门店（否则 403）',
  }),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum(REFUND_STATUSES).optional(),
  mode: z.enum(MODES).optional(),
  stage: z.enum(STAGES).optional().openapi({
    description: '退款阶段：before_start 服务开始前 / in_service 服务中',
  }),
  liable: z.enum(LIABLES).optional(),
  paymentId: z.coerce.number().int().positive().optional(),
  bookingId: z.coerce.number().int().positive().optional(),
  customerId: z.coerce.number().int().positive().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

const rejectSchema = z.object({
  reason: z.string().min(2).max(200).openapi({
    example: '金额与规则不符，需重新试算',
    description: '驳回原因（必填）',
  }),
});

registerComponent('RefundPreviewRequest', previewSchema);
registerComponent('CreateRefundRequest', applySchema);
registerComponent('RejectRefundRequest', rejectSchema);

@ApiTags('收银-退款')
@ApiBearerAuth('access-token')
@Controller('biz/refunds')
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Post('preview')
  @RequirePermissions('biz:refund:apply')
  @ApiOperation({
    summary: '退款试算（只读）：判定服务阶段并给出建议退款额',
    description:
      '服务开始前 → 无理由全额退（金额锁定）；服务中 → 需店长手动填金额。' +
      '老判责规则降级为参考值 policySuggestAmount。',
  })
  @ApiBody({ schema: { $ref: '#/components/schemas/RefundPreviewRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  preview(@Body() body: unknown) {
    return this.refunds.preview(previewSchema.parse(body));
  }

  @Post()
  @RequirePermissions('biz:refund:apply')
  @ApiOperation({
    summary: '发起退款（建单后直接执行，无需审批）',
    description:
      '服务开始前：无理由全额退，金额由服务端锁定；' +
      '服务中：仅店长（biz:refund:approve）可发起，金额必须手动填写。',
  })
  @ApiBody({ schema: { $ref: '#/components/schemas/CreateRefundRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  apply(@Body() body: unknown, @Req() request: AuthRequest) {
    const input = applySchema.parse(body);
    const payload: RefundApplyInput = {
      paymentId: input.paymentId,
      bookingId: input.bookingId,
      amount: input.amount,
      actualAmount: input.actualAmount,
      mode: input.mode,
      reason: input.reason,
      liable: input.liable,
      policyId: input.policyId,
    };
    return this.refunds.apply(payload, request.user);
  }

  @Get()
  @RequirePermissions('biz:refund:list')
  @ApiOperation({ summary: '退款单列表' })
  @ApiQuery({ name: 'page', required: false, description: '页码', example: 1 })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: '每页条数',
    example: 20,
  })
  @ApiResponse({ status: 200, description: '成功' })
  list(@Query() rawQuery: unknown, @Req() request: AuthRequest) {
    const query = listQuerySchema.parse(rawQuery ?? {});
    const { page, pageSize } = parsePagination(query.page, query.pageSize);
    const filter: RefundListFilter = {
      storeId: query.storeId,
      status: query.status,
      mode: query.mode,
      stage: query.stage,
      liable: query.liable,
      paymentId: query.paymentId,
      bookingId: query.bookingId,
      customerId: query.customerId,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    };
    return this.refunds.list(page, pageSize, filter, request.user);
  }

  @Post(':id/approve')
  @RequirePermissions('biz:refund:approve')
  @ApiOperation({
    summary: '审批通过并执行（只执行一次，重复调用返回「已处理」）',
  })
  @ApiParam({ name: 'id', description: '退款单 ID' })
  @ApiResponse({ status: 200, description: '成功' })
  approve(@Param('id', ParseIntPipe) id: number, @Req() request: AuthRequest) {
    return this.refunds.approve(id, request.user.id);
  }

  @Post(':id/reject')
  @RequirePermissions('biz:refund:approve')
  @ApiOperation({ summary: '驳回退款申请（必填原因）' })
  @ApiParam({ name: 'id', description: '退款单 ID' })
  @ApiBody({ schema: { $ref: '#/components/schemas/RejectRefundRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  async reject(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ): Promise<{ success: true }> {
    const input = rejectSchema.parse(body);
    await this.refunds.reject(id, input.reason, request.user.id);
    return { success: true };
  }
}
