import {
  Body,
  Controller,
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
import { MAX_PAGE_SIZE, parsePagination } from '../../common/query';
import {
  PaymentDiffsService,
  type PaymentDiffListFilter,
} from './payment-diffs.service';

type AuthRequest = { user: { id: number } };

const DIFF_CHANNELS = ['wxpay_native', 'alipay_qr'] as const;
const DIFF_TYPES = [
  'missing_in_system',
  'missing_in_channel',
  'amount_mismatch',
  'status_mismatch',
] as const;
const DIFF_STATUSES = ['pending', 'resolved', 'ignored'] as const;

const reconcileSchema = z.object({
  billDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, '对账日期格式应为 YYYY-MM-DD')
    .optional()
    .openapi({
      example: '2026-09-10',
      description: '渠道账单日期（默认前一天）',
    }),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  billDate: z.string().optional(),
  channel: z.enum(DIFF_CHANNELS).optional(),
  status: z.enum(DIFF_STATUSES).optional(),
  diffType: z.enum(DIFF_TYPES).optional(),
});

const handleSchema = z.object({
  status: z
    .enum(['resolved', 'ignored'])
    .openapi({ example: 'resolved', description: '已处理 / 忽略' }),
  remark: z
    .string()
    .min(2)
    .max(200)
    .openapi({ example: '已联系渠道补单', description: '处理备注（必填）' }),
});

registerComponent('ReconcileRequest', reconcileSchema);
registerComponent('HandlePaymentDiffRequest', handleSchema);

@ApiTags('收银-对账差异')
@ApiBearerAuth('access-token')
@Controller('biz/payment-diffs')
export class PaymentDiffsController {
  constructor(private readonly diffs: PaymentDiffsService) {}

  @Get()
  @RequirePermissions('biz:payment:reconcile')
  @ApiOperation({ summary: '对账差异列表' })
  @ApiQuery({ name: 'page', required: false, description: '页码', example: 1 })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: '每页条数',
    example: 20,
  })
  @ApiResponse({ status: 200, description: '成功' })
  list(@Query() rawQuery: unknown) {
    const query = listQuerySchema.parse(rawQuery ?? {});
    const { page, pageSize } = parsePagination(query.page, query.pageSize);
    const filter: PaymentDiffListFilter = {
      billDate: query.billDate,
      channel: query.channel,
      status: query.status,
      diffType: query.diffType,
    };
    return this.diffs.list(page, pageSize, filter);
  }

  @Post('reconcile')
  @RequirePermissions('biz:payment:reconcile')
  @ApiOperation({ summary: '触发指定日期对账（可重入，不产生重复差异）' })
  @ApiBody({ schema: { $ref: '#/components/schemas/ReconcileRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  reconcile(@Body() body: unknown) {
    const input = reconcileSchema.parse(body ?? {});
    return this.diffs.reconcile(input.billDate);
  }

  @Patch(':id')
  @RequirePermissions('biz:payment:reconcile')
  @ApiOperation({ summary: '标记差异已处理 / 忽略（必须填备注）' })
  @ApiParam({ name: 'id', description: '差异 ID' })
  @ApiBody({
    schema: { $ref: '#/components/schemas/HandlePaymentDiffRequest' },
  })
  @ApiResponse({ status: 200, description: '成功' })
  async handle(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ): Promise<{ success: true }> {
    const input = handleSchema.parse(body);
    await this.diffs.handle(id, input, request.user.id);
    return { success: true };
  }
}
