/**
 * 提成接口（§9.11 / §20.3）。
 *
 * 规则维护 `biz:commission:rule`；计提记录 `biz:commission:list`；
 * 结算与冲销 `biz:commission:settle`（默认只给店长）。
 */
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
import type { RequestActor } from '../../../../common/data-scope/data-scope';
import { registerComponent } from '../../../../common/swagger/zod-schema.helper';
import { parsePagination } from '../../common/query';
import {
  CommissionService,
  type CommissionRuleInput,
  type CommissionRulePatch,
} from './commission.service';

const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ example: '2026-09-01', description: '生效日（店内本地日）' });
const period = z
  .string()
  .regex(/^\d{6}$/)
  .openapi({ example: '202609', description: '结算期间 yyyyMM' });

const ruleCreateSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(50)
    .openapi({ example: '美甲 10% + 固定 5 元', description: '规则名称' }),
  scope: z.enum(['staff', 'category', 'service_item']).openapi({
    example: 'category',
    description: '优先级：service_item > category > staff',
  }),
  targetId: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .openapi({ example: 3, description: 'scope=service_item 时的项目ID' }),
  staffId: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .openapi({ example: 2, description: 'scope=staff 时的美甲师ID' }),
  category: z
    .string()
    .max(30)
    .nullable()
    .optional()
    .openapi({ example: '美甲', description: 'scope=category 时的分类名' }),
  permille: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .optional()
    .openapi({ example: 100, description: '比例千分比（100 = 10%）' }),
  fixedAmount: z
    .number()
    .int()
    .min(0)
    .optional()
    .openapi({ example: 500, description: '固定额（分），与比例可叠加' }),
  base: z
    .enum(['payable', 'paid', 'original'])
    .optional()
    .openapi({ example: 'paid', description: '计提基数，默认 paid（实收）' }),
  effectiveFrom: localDate,
  effectiveTo: localDate.nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  sort: z.number().int().min(0).optional(),
  remark: z.string().max(200).nullable().optional(),
});

const ruleUpdateSchema = ruleCreateSchema.partial();

const settleSchema = z.object({ period });
const reverseSchema = z.object({
  reason: z.string().min(1).max(200).openapi({
    example: '顾客退款，冲销提成',
    description: '冲销原因（必填）',
  }),
});

registerComponent('CreateCommissionRuleRequest', ruleCreateSchema);
registerComponent('UpdateCommissionRuleRequest', ruleUpdateSchema);
registerComponent('SettleCommissionRequest', settleSchema);
registerComponent('ReverseCommissionRequest', reverseSchema);

/** 空字符串一律当「没传」 */
function emptyToUndefined(value: unknown): unknown {
  return value === '' || value === undefined ? undefined : value;
}

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(emptyToUndefined, schema.optional());

const ruleQuerySchema = z.object({
  scope: optional(z.enum(['staff', 'category', 'service_item'])),
  staffId: optional(z.coerce.number().int().positive()),
  category: optional(z.string().max(30)),
  status: optional(z.enum(['active', 'disabled'])),
  keyword: optional(z.string().max(50)),
});

const recordQuerySchema = z.object({
  staffId: optional(z.coerce.number().int().positive()),
  period: optional(period),
  status: optional(z.enum(['accrued', 'settled', 'reversed'])),
  bookingId: optional(z.coerce.number().int().positive()),
  storeId: optional(z.coerce.number().int().positive()),
});

type AuthRequest = { user: RequestActor };

@ApiTags('提成管理')
@ApiBearerAuth('access-token')
@Controller('biz')
export class CommissionController {
  constructor(private readonly commission: CommissionService) {}

  /* ---------------- 规则 ---------------- */

  @Get('commission-rules')
  @RequirePermissions('biz:commission:rule')
  @ApiOperation({ summary: '提成规则列表' })
  @ApiQuery({ name: 'page', required: false, description: '页码', example: 1 })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: '每页条数',
    example: 20,
  })
  @ApiQuery({
    name: 'scope',
    required: false,
    description: 'staff | category | service_item',
  })
  @ApiQuery({ name: 'staffId', required: false, description: '美甲师' })
  @ApiQuery({ name: 'category', required: false, description: '项目分类' })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'active | disabled',
  })
  @ApiQuery({ name: 'keyword', required: false, description: '规则名称模糊' })
  @ApiResponse({ status: 200, description: '成功' })
  listRules(
    @Query('page') rawPage?: string,
    @Query('pageSize') rawPageSize?: string,
    @Query() raw: Record<string, unknown> = {},
  ) {
    const { page, pageSize } = parsePagination(rawPage, rawPageSize);
    const query = ruleQuerySchema.parse({ ...raw });
    return this.commission.listRules(page, pageSize, {
      scope: query.scope,
      staffId: query.staffId,
      category: query.category,
      status: query.status,
      keyword: query.keyword,
    });
  }

  @Post('commission-rules')
  @RequirePermissions('biz:commission:rule')
  @ApiOperation({
    summary: '新增提成规则（比例与固定额可叠加，默认基数 paid）',
  })
  @ApiBody({
    schema: { $ref: '#/components/schemas/CreateCommissionRuleRequest' },
  })
  @ApiResponse({ status: 200, description: '成功' })
  createRule(@Body() body: unknown, @Req() request: AuthRequest) {
    const input: CommissionRuleInput = ruleCreateSchema.parse(body);
    return this.commission.createRule(input, request.user.id);
  }

  @Patch('commission-rules/:id')
  @RequirePermissions('biz:commission:rule')
  @ApiOperation({ summary: '修改提成规则（只影响之后计提，不回溯）' })
  @ApiParam({ name: 'id', description: '规则ID' })
  @ApiBody({
    schema: { $ref: '#/components/schemas/UpdateCommissionRuleRequest' },
  })
  @ApiResponse({ status: 200, description: '成功' })
  updateRule(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    const patch: CommissionRulePatch = ruleUpdateSchema.parse(body);
    return this.commission.updateRule(id, patch, request.user.id);
  }

  @Delete('commission-rules/:id')
  @RequirePermissions('biz:commission:rule')
  @ApiOperation({ summary: '删除提成规则（软删，历史计提记录保留 rule_id）' })
  @ApiParam({ name: 'id', description: '规则ID' })
  @ApiResponse({ status: 200, description: '成功' })
  removeRule(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: AuthRequest,
  ) {
    return this.commission.removeRule(id, request.user.id);
  }

  /* ---------------- 计提记录 ---------------- */

  @Get('commission-records')
  @RequirePermissions('biz:commission:list')
  @ApiOperation({ summary: '计提记录列表（staffId / period / status）' })
  @ApiQuery({ name: 'page', required: false, description: '页码', example: 1 })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: '每页条数',
    example: 20,
  })
  @ApiQuery({ name: 'staffId', required: false, description: '美甲师' })
  @ApiQuery({ name: 'period', required: false, description: '期间 yyyyMM' })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'accrued | settled | reversed',
  })
  @ApiQuery({ name: 'bookingId', required: false, description: '预约ID' })
  @ApiQuery({
    name: 'storeId',
    required: false,
    description:
      '门店维度：计提记录自己没有 store_id，按关联预约的门店归属过滤；' +
      '不传 = 用顶栏切换器的门店（店长不传也自动限本店）',
  })
  @ApiResponse({ status: 200, description: '成功' })
  listRecords(
    @Req() request: AuthRequest,
    @Query('page') rawPage?: string,
    @Query('pageSize') rawPageSize?: string,
    @Query() raw: Record<string, unknown> = {},
  ) {
    const { page, pageSize } = parsePagination(rawPage, rawPageSize);
    const query = recordQuerySchema.parse({ ...raw });
    return this.commission.listRecords(
      page,
      pageSize,
      {
        staffId: query.staffId,
        period: query.period,
        status: query.status,
        bookingId: query.bookingId,
        storeId: query.storeId,
      },
      request.user,
    );
  }

  @Get('commission-records/summary')
  @RequirePermissions('biz:commission:list')
  @ApiOperation({
    summary: '计提记录期间汇总（按状态分桶，不受单页上限影响）',
  })
  @ApiQuery({ name: 'period', required: false, description: '期间 yyyyMM' })
  @ApiQuery({ name: 'staffId', required: false, description: '美甲师' })
  @ApiQuery({ name: 'bookingId', required: false, description: '预约ID' })
  @ApiQuery({
    name: 'storeId',
    required: false,
    description: '门店维度（同列表接口，按关联预约的门店归属过滤）',
  })
  @ApiResponse({ status: 200, description: '成功' })
  summaryRecords(
    @Req() request: AuthRequest,
    @Query() raw: Record<string, unknown> = {},
  ) {
    const query = recordQuerySchema.parse({ ...raw });
    return this.commission.summaryRecords(
      {
        staffId: query.staffId,
        period: query.period,
        bookingId: query.bookingId,
        storeId: query.storeId,
      },
      request.user,
    );
  }

  /* ---------------- 结算 / 冲销 ---------------- */

  @Post('commission-settle')
  @RequirePermissions('biz:commission:settle')
  @ApiOperation({
    summary: '按期间结算（生成批次号并把 accrued 置 settled，结算后不可修改）',
  })
  @ApiBody({ schema: { $ref: '#/components/schemas/SettleCommissionRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  settle(@Body() body: unknown, @Req() request: AuthRequest) {
    const input = settleSchema.parse(body);
    return this.commission.settle(input.period, request.user.id);
  }

  @Post('commission-records/:id/reverse')
  @RequirePermissions('biz:commission:settle')
  @ApiOperation({ summary: '单笔冲销（必填原因，只有 accrued 可冲销）' })
  @ApiParam({ name: 'id', description: '计提记录ID' })
  @ApiBody({
    schema: { $ref: '#/components/schemas/ReverseCommissionRequest' },
  })
  @ApiResponse({ status: 200, description: '成功' })
  reverseRecord(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    const input = reverseSchema.parse(body);
    return this.commission.reverseRecord(id, input.reason, request.user.id);
  }
}
