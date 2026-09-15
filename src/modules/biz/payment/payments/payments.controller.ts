import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
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
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { RequirePermissions } from '../../../../common/auth/permissions.decorator.js';
import { Public } from '../../../../common/auth/public.decorator.js';
import { registerComponent } from '../../../../common/swagger/zod-schema.helper.js';
import { MAX_PAGE_SIZE, parsePagination } from '../../common/query.js';
import type { PaymentDraft } from '../../common/ports.js';
import { PaymentsService, type PaymentListFilter } from './payments.service.js';

type AuthRequest = {
  user: { id: number; roles: string[]; permissions: string[] };
};
type NotifyRequest = {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody?: string | undefined;
};

const CHANNELS = [
  'wxpay_native',
  'alipay_qr',
  'cash',
  'wechat_offline',
  'alipay_offline',
  'balance',
  'card',
  'credit',
] as const;
const PURPOSES = [
  'deposit',
  'final',
  'recharge',
  'card_buy',
  'credit_settle',
] as const;
const STATUSES = [
  'pending',
  'success',
  'failed',
  'closed',
  'refunded',
  'partial_refunded',
] as const;

const createPaymentSchema = z.object({
  storeId: z.coerce.number().int().positive().optional().openapi({
    example: 1,
    description:
      '门店：不传 = 当前账号的门店（超管可指定任意门店）；普通账号指定别人的门店 → 403',
  }),
  customerId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ example: 1, description: '顾客 ID' }),
  bookingId: z.coerce
    .number()
    .int()
    .positive()
    .nullish()
    .openapi({ example: 12, description: '预约 ID（充值 / 购卡类为空）' }),
  purpose: z
    .enum(PURPOSES)
    .openapi({ example: 'final', description: '款项用途' }),
  channel: z
    .enum(CHANNELS)
    .openapi({ example: 'cash', description: '支付方式' }),
  amount: z.coerce
    .number()
    .int()
    .min(0)
    .openapi({ example: 10000, description: '应收金额（分）' }),
  receivedAmount: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .openapi({ example: 10000, description: '实收金额（分，默认等于应收）' }),
  memberCardId: z.coerce
    .number()
    .int()
    .positive()
    .nullish()
    .openapi({ example: 3, description: '次卡核销时的会员卡 ID' }),
  remark: z
    .string()
    .max(200)
    .nullish()
    .openapi({ example: '前台收款', description: '备注' }),
});

const listPaymentQuerySchema = z.object({
  storeId: z.coerce.number().int().positive().optional().openapi({
    description:
      '门店筛选：超管/`system:store:all` 可查任意门店；普通账号只能筛可见门店（否则 403）',
  }),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  channel: z.enum(CHANNELS).optional(),
  status: z.enum(STATUSES).optional(),
  purpose: z.enum(PURPOSES).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  bookingNo: z.string().optional(),
  customerId: z.coerce.number().int().positive().optional(),
  bookingId: z.coerce.number().int().positive().optional(),
});

registerComponent('CreatePaymentRequest', createPaymentSchema);

@ApiTags('收银-支付单')
@ApiBearerAuth('access-token')
@Controller('biz/payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('notify/wxpay')
  @Public()
  @ApiOperation({ summary: '微信支付回调（公开端点，自行验签 + 幂等）' })
  @ApiResponse({ status: 200, description: '渠道应答体' })
  async notifyWxpay(
    @Req() request: NotifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const result = await this.payments.handleNotify('wxpay_native', {
      headers: request.headers,
      body: request.body,
      rawBody: request.rawBody,
    });
    reply
      .status(result.statusCode)
      .header('content-type', 'application/json; charset=utf-8')
      .send(result.body);
  }

  @Post('notify/alipay')
  @Public()
  @ApiOperation({ summary: '支付宝回调（公开端点，自行验签 + 幂等）' })
  @ApiResponse({ status: 200, description: '渠道应答体' })
  async notifyAlipay(
    @Req() request: NotifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const result = await this.payments.handleNotify('alipay_qr', {
      headers: request.headers,
      body: request.body,
      rawBody: request.rawBody,
    });
    reply
      .status(result.statusCode)
      .header('content-type', 'text/plain; charset=utf-8')
      .send(result.body);
  }

  @Get()
  @RequirePermissions('biz:payment:list')
  @ApiOperation({ summary: '支付单列表' })
  @ApiQuery({ name: 'page', required: false, description: '页码', example: 1 })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: '每页条数',
    example: 20,
  })
  @ApiResponse({ status: 200, description: '成功' })
  list(@Query() rawQuery: unknown, @Req() request: AuthRequest) {
    const query = listPaymentQuerySchema.parse(rawQuery ?? {});
    const { page, pageSize } = parsePagination(query.page, query.pageSize);
    const filter: PaymentListFilter = {
      storeId: query.storeId,
      channel: query.channel,
      status: query.status,
      purpose: query.purpose,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      bookingNo: query.bookingNo,
      customerId: query.customerId,
      bookingId: query.bookingId,
    };
    return this.payments.list(page, pageSize, filter, request.user);
  }

  @Post()
  @RequirePermissions('biz:payment:create')
  @ApiOperation({
    summary: '发起收款（现金 / 线下扫码直接成功，在线渠道返回二维码）',
  })
  @ApiBody({ schema: { $ref: '#/components/schemas/CreatePaymentRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  create(@Body() body: unknown, @Req() request: AuthRequest) {
    const input = createPaymentSchema.parse(body);
    const draft: PaymentDraft = {
      // 门店由入口解析：请求显式指定优先，否则当前账号的门店（未分配门店 → 403）
      storeId: input.storeId ?? 0,
      customerId: input.customerId,
      bookingId: input.bookingId ?? null,
      purpose: input.purpose,
      channel: input.channel,
      amount: input.amount,
      ...(input.receivedAmount === undefined
        ? {}
        : { receivedAmount: input.receivedAmount }),
      memberCardId: input.memberCardId ?? null,
      remark: input.remark ?? null,
    };
    return this.payments.create(draft, request.user);
  }

  @Get(':id')
  @RequirePermissions('biz:payment:list')
  @ApiOperation({ summary: '支付单详情（含 payment_log 轨迹）' })
  @ApiParam({ name: 'id', description: '支付单 ID' })
  @ApiResponse({ status: 200, description: '成功' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.payments.findOne(id);
  }

  @Get(':id/status')
  @RequirePermissions('biz:payment:list')
  @ApiOperation({ summary: '收银台轮询支付状态（轻量）' })
  @ApiParam({ name: 'id', description: '支付单 ID' })
  @ApiResponse({ status: 200, description: '成功' })
  status(@Param('id', ParseIntPipe) id: number) {
    return this.payments.statusOf(id);
  }

  @Post(':id/query')
  @RequirePermissions('biz:payment:create')
  @ApiOperation({ summary: '主动向渠道查单（回调丢失时兜底）' })
  @ApiParam({ name: 'id', description: '支付单 ID' })
  @ApiResponse({ status: 200, description: '成功' })
  query(@Param('id', ParseIntPipe) id: number, @Req() request: AuthRequest) {
    return this.payments.queryChannel(id, request.user.id);
  }

  @Post(':id/close')
  @RequirePermissions('biz:payment:close')
  @ApiOperation({ summary: '关单（仅待支付）' })
  @ApiParam({ name: 'id', description: '支付单 ID' })
  @ApiResponse({ status: 200, description: '成功' })
  async close(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: AuthRequest,
  ): Promise<{ success: true }> {
    await this.payments.close(id, request.user.id);
    return { success: true };
  }
}
