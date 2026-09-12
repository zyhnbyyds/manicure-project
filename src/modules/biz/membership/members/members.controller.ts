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
import { RequirePermissions } from '../../../../common/auth/permissions.decorator';
import { registerComponent } from '../../../../common/swagger/zod-schema.helper';
import { parsePagination } from '../../common/query.js';
import { MemberAccountsService } from '../member-accounts/member-accounts.service.js';
import { MemberCardsService } from '../member-cards/member-cards.service.js';
import { CouponsService } from '../coupons/coupons.service.js';

const ensureMemberSchema = z.object({
  customerId: z.number().int().positive(),
});

const rechargeSchema = z
  .object({
    planId: z.number().int().positive().optional(),
    payAmount: z.number().int().min(1).optional(),
    payChannel: z.enum([
      'cash',
      'wechat',
      'wechat_offline',
      'alipay',
      'alipay_offline',
    ]),
    remark: z.string().max(200).nullable().optional(),
  })
  .refine(
    (value) => value.planId !== undefined || value.payAmount !== undefined,
    {
      message: '请选择充值方案或填写充值金额',
    },
  );

const refundSchema = z.object({
  mode: z.enum(['balance', 'cash']),
  amount: z.number().int().min(1),
  reason: z.string().max(200).nullable().optional(),
  reversalOf: z.number().int().positive().nullable().optional(),
});

const adjustSchema = z.object({
  levelId: z.number().int().positive().nullable().optional(),
  pointsDelta: z.number().int().optional(),
  balancePrincipalDelta: z.number().int().optional(),
  balanceBonusDelta: z.number().int().optional(),
  reason: z.string().min(1).max(200),
});

registerComponent('EnsureMemberRequest', ensureMemberSchema);
registerComponent('RechargeMemberRequest', rechargeSchema);
registerComponent('RefundMemberRequest', refundSchema);
registerComponent('AdjustMemberRequest', adjustSchema);

type AuthRequest = { user: { id: number } };

const LEDGER_TYPES = [
  'recharge',
  'consume',
  'refund',
  'card_buy',
  'card_use',
  'card_revert',
  'points_earn',
  'points_spend',
  'points_redeem',
  'level_change',
  'adjust',
] as const;

@ApiTags('会员')
@ApiBearerAuth('access-token')
@Controller('biz/members')
export class MembersController {
  constructor(
    private readonly accounts: MemberAccountsService,
    private readonly cards: MemberCardsService,
    private readonly coupons: CouponsService,
  ) {}

  @Get()
  @RequirePermissions('biz:member:list')
  @ApiOperation({ summary: '会员列表（姓名/手机号/会员号 + 等级 + 余额筛选）' })
  @ApiQuery({ name: 'page', required: false, description: '页码' })
  @ApiQuery({ name: 'pageSize', required: false, description: '每页条数' })
  @ApiQuery({
    name: 'keyword',
    required: false,
    description: '姓名/手机号/会员号',
  })
  @ApiQuery({ name: 'levelId', required: false, description: '等级ID' })
  @ApiQuery({
    name: 'hasBalance',
    required: false,
    description: '是否有储值余额',
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
    return this.accounts.listMembers(page, pageSize, {
      keyword: keyword?.trim() || undefined,
      levelId: toPositiveInt(rawLevelId),
      hasBalance:
        rawHasBalance === undefined || rawHasBalance === ''
          ? undefined
          : rawHasBalance === 'true' || rawHasBalance === '1',
    });
  }

  @Post()
  @RequirePermissions('biz:member:update')
  @ApiOperation({
    summary: '把已有顾客纳为会员（建会员号 / 入会时间 / 初始等级）',
  })
  @ApiBody({ schema: { $ref: '#/components/schemas/EnsureMemberRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  ensureMember(@Body() body: unknown, @Req() request: AuthRequest) {
    const input = ensureMemberSchema.parse(body);
    return this.accounts.ensureMember(input.customerId, request.user.id);
  }

  @Get(':id')
  @RequirePermissions('biz:member:list')
  @ApiOperation({ summary: '会员详情（档案 + 等级 + 余额 + 积分 + 次卡）' })
  @ApiParam({ name: 'id', description: '会员（顾客）ID' })
  @ApiResponse({ status: 200, description: '成功' })
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const [detail, cards] = await Promise.all([
      this.accounts.memberDetail(id),
      this.cards.listByCustomer(id),
    ]);
    return { ...detail, cards };
  }

  @Get(':id/transactions')
  @RequirePermissions('biz:member:list')
  @ApiOperation({ summary: '会员账务流水（只读、分页）' })
  @ApiParam({ name: 'id', description: '会员（顾客）ID' })
  @ApiQuery({ name: 'page', required: false, description: '页码' })
  @ApiQuery({ name: 'pageSize', required: false, description: '每页条数' })
  @ApiQuery({ name: 'type', required: false, description: '流水类型' })
  @ApiQuery({ name: 'dateFrom', required: false, description: '开始日期' })
  @ApiQuery({ name: 'dateTo', required: false, description: '结束日期' })
  @ApiResponse({ status: 200, description: '成功' })
  transactions(
    @Param('id', ParseIntPipe) id: number,
    @Query('page') rawPage?: string,
    @Query('pageSize') rawPageSize?: string,
    @Query('type') type?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    const { page, pageSize } = parsePagination(rawPage, rawPageSize);
    return this.accounts.listTransactions(id, page, pageSize, {
      type: LEDGER_TYPES.find((item) => item === type),
      dateFrom: dateFrom?.trim() || undefined,
      dateTo: dateTo?.trim() || undefined,
    });
  }

  @Post(':id/recharge')
  @RequirePermissions('biz:member:recharge')
  @ApiOperation({ summary: '充值（方案或自定义金额；赠送比例上限校验）' })
  @ApiParam({ name: 'id', description: '会员（顾客）ID' })
  @ApiBody({ schema: { $ref: '#/components/schemas/RechargeMemberRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  recharge(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    return this.accounts.recharge(
      id,
      rechargeSchema.parse(body),
      request.user.id,
    );
  }

  @Post(':id/refund')
  @RequirePermissions('biz:member:refund')
  @ApiOperation({
    summary: '冲正 / 退款（写反向流水 + reversal_of，原流水不动）',
  })
  @ApiParam({ name: 'id', description: '会员（顾客）ID' })
  @ApiBody({ schema: { $ref: '#/components/schemas/RefundMemberRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  refund(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    return this.accounts.refundMember(
      id,
      refundSchema.parse(body),
      request.user.id,
    );
  }

  @Post(':id/adjust')
  @RequirePermissions('biz:member:adjust')
  @ApiOperation({ summary: '手工调级 / 调积分 / 调余额（必填原因，写流水）' })
  @ApiParam({ name: 'id', description: '会员（顾客）ID' })
  @ApiBody({ schema: { $ref: '#/components/schemas/AdjustMemberRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  adjust(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    return this.accounts.adjustMember(
      id,
      adjustSchema.parse(body),
      request.user.id,
    );
  }

  /**
   * 给指定顾客发券。
   *
   * **允许重复发放**（补偿、活动补发都是正常诉求）—— 这里**不做「已持有就拒绝」**，
   * 那会把合法诉求也挡掉。防重复提交交给前端按钮态；发完可用 GET :id/coupons 核对。
   *
   * 停用的模板**不能发放**（issue() 里拦），需要时先把模板改回启用。
   */
  @Post(':id/coupons')
  @RequirePermissions('biz:member:coupon')
  @ApiOperation({ summary: '给顾客发券（面额/门槛按下发时快照）' })
  @ApiParam({ name: 'id', description: '会员（顾客）ID' })
  @ApiBody({ schema: { $ref: '#/components/schemas/IssueCouponRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  @ApiResponse({ status: 404, description: '模板不存在' })
  @ApiResponse({ status: 409, description: '模板已停用' })
  issueCoupon(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    const input = issueCouponSchema.parse(body);
    return this.coupons.issue({
      customerId: id,
      templateId: input.templateId,
      actorId: request.user.id,
      source: 'admin',
    });
  }

  /** 该顾客持有的券（发券后核对；会员详情也可用） */
  @Get(':id/coupons')
  @RequirePermissions('biz:member:list')
  @ApiOperation({ summary: '顾客的优惠券列表' })
  @ApiParam({ name: 'id', description: '会员（顾客）ID' })
  @ApiQuery({ name: 'page', required: false, description: '页码' })
  @ApiQuery({ name: 'pageSize', required: false, description: '每页条数' })
  @ApiResponse({ status: 200, description: '成功' })
  listCoupons(
    @Param('id', ParseIntPipe) id: number,
    @Query('page') rawPage?: string,
    @Query('pageSize') rawPageSize?: string,
  ) {
    const { page, pageSize } = parsePagination(rawPage, rawPageSize);
    return this.coupons.listByCustomer(id, page, pageSize);
  }

  @Post(':id/recount')
  @RequirePermissions('biz:member:recount')
  @ApiOperation({
    summary: '按流水重算余额 / 积分 / 累计消费 / 等级（对账修复）',
  })
  @ApiParam({ name: 'id', description: '会员（顾客）ID' })
  @ApiResponse({ status: 200, description: '成功' })
  async recount(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: AuthRequest,
  ) {
    await this.accounts.recount(id, request.user.id);
    return { ok: true };
  }
}

/** 发券入参：只收 templateId（顾客来自路径参数） */
const issueCouponSchema = z.object({
  templateId: z.number().int().positive(),
});
registerComponent('IssueCouponRequest', issueCouponSchema);

function toPositiveInt(raw?: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
