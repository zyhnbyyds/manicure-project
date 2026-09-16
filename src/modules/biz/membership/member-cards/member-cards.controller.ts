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
import type { RequestActor } from '../../../../common/data-scope/data-scope';
import { registerComponent } from '../../../../common/swagger/zod-schema.helper';
import { parsePagination } from '../../common/query';
import { MemberCardsService } from './member-cards.service';

const issueSchema = z.object({
  customerId: z.number().int().positive(),
  cardTypeId: z.number().int().positive(),
  payChannel: z.enum(['cash', 'wechat', 'alipay', 'balance']),
  price: z.number().int().min(0).optional(),
  remark: z.string().max(200).nullable().optional(),
});
const useSchema = z.object({
  serviceItemId: z.number().int().positive(),
  bookingId: z.number().int().positive().nullable().optional(),
  remark: z.string().max(200).nullable().optional(),
});
const revertSchema = z.object({
  bookingId: z.number().int().positive().nullable().optional(),
  reason: z.string().min(1).max(200),
});
const refundSchema = z.object({
  amount: z.number().int().min(0),
  reason: z.string().min(1).max(200),
});

registerComponent('IssueMemberCardRequest', issueSchema);
registerComponent('UseMemberCardRequest', useSchema);
registerComponent('RevertMemberCardRequest', revertSchema);
registerComponent('RefundMemberCardRequest', refundSchema);

type AuthRequest = { user: RequestActor };

const CARD_STATUS = ['active', 'used_up', 'expired', 'refunded'] as const;

@ApiTags('会员次卡')
@ApiBearerAuth('access-token')
@Controller('biz/member-cards')
export class MemberCardsController {
  constructor(private readonly cards: MemberCardsService) {}

  @Get()
  @RequirePermissions('biz:card:list')
  @ApiOperation({ summary: '次卡列表' })
  @ApiQuery({ name: 'page', required: false, description: '页码' })
  @ApiQuery({ name: 'pageSize', required: false, description: '每页条数' })
  @ApiQuery({ name: 'customerId', required: false, description: '会员ID' })
  @ApiQuery({ name: 'cardTypeId', required: false, description: '卡种ID' })
  @ApiQuery({ name: 'status', required: false, description: '卡状态' })
  @ApiQuery({ name: 'keyword', required: false, description: '卡号（模糊）' })
  @ApiResponse({ status: 200, description: '成功' })
  list(
    @Query('page') rawPage?: string,
    @Query('pageSize') rawPageSize?: string,
    @Query('customerId') rawCustomerId?: string,
    @Query('cardTypeId') rawCardTypeId?: string,
    @Query('status') status?: string,
    @Query('keyword') keyword?: string,
  ) {
    const { page, pageSize } = parsePagination(rawPage, rawPageSize);
    return this.cards.list(page, pageSize, {
      customerId: toPositiveInt(rawCustomerId),
      cardTypeId: toPositiveInt(rawCardTypeId),
      status: CARD_STATUS.find((item) => item === status),
      keyword: keyword?.trim() || undefined,
    });
  }

  @Get(':id')
  @RequirePermissions('biz:card:list')
  @ApiOperation({ summary: '次卡详情（含适用项目与核销记录）' })
  @ApiParam({ name: 'id', description: '次卡ID' })
  @ApiResponse({ status: 200, description: '成功' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.cards.findOne(id);
  }

  @Post()
  @RequirePermissions('biz:card:issue')
  @ApiOperation({
    summary: '发卡（储值支付时同事务条件扣款；余额不足 409）',
  })
  @ApiBody({ schema: { $ref: '#/components/schemas/IssueMemberCardRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  issue(@Body() body: unknown, @Req() request: AuthRequest) {
    return this.cards.issue(issueSchema.parse(body), request.user);
  }

  @Post(':id/use')
  @RequirePermissions('biz:card:use')
  @ApiOperation({
    summary: '核销一次（条件更新，次数用完 / 过期 / 项目不适配拒绝）',
  })
  @ApiParam({ name: 'id', description: '次卡ID' })
  @ApiBody({ schema: { $ref: '#/components/schemas/UseMemberCardRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  use(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    return this.cards.use(
      { cardId: id, ...useSchema.parse(body) },
      request.user.id,
    );
  }

  @Post(':id/revert')
  @RequirePermissions('biz:card:revoke')
  @ApiOperation({ summary: '撤销一次核销（回补次数，必填原因）' })
  @ApiParam({ name: 'id', description: '次卡ID' })
  @ApiBody({ schema: { $ref: '#/components/schemas/RevertMemberCardRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  revert(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    const input = revertSchema.parse(body);
    return this.cards.revert(
      { cardId: id, bookingId: input.bookingId ?? null, reason: input.reason },
      request.user.id,
    );
  }

  @Post(':id/refund')
  @RequirePermissions('biz:card:refund')
  @ApiOperation({ summary: '退卡（人工填退款金额，置 refunded 并写流水）' })
  @ApiParam({ name: 'id', description: '次卡ID' })
  @ApiBody({ schema: { $ref: '#/components/schemas/RefundMemberCardRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  refund(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    const input = refundSchema.parse(body);
    return this.cards.refund(id, input.amount, input.reason, request.user);
  }
}

function toPositiveInt(raw?: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
