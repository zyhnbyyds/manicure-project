import {
  BadRequestException,
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
import { parsePagination } from '../../common/query';
import { PointsGoodsService } from '../points-goods/points-goods.service';

const previewSchema = z.object({
  customerId: z.number().int().positive(),
  serviceItemIds: z
    .array(z.number().int().positive())
    .min(1)
    .max(3)
    .describe('本单项目（1~3 个，服务端重算可抵上限）'),
});

const revertRedeemSchema = z.object({
  reason: z.string().min(1).max(200),
});

const redeemSchema = z.object({
  goodsId: z.number().int().positive(),
});

registerComponent('PointsPreviewRequest', previewSchema);
registerComponent('RedeemPointsRequest', redeemSchema);
registerComponent('RevertPointsRedeemRequest', revertRedeemSchema);

type AuthRequest = { user: { id: number } };

const REDEEM_STATUS = ['success', 'reverted'] as const;

/**
 * 积分接口（§9.10）：抵扣试算 / 兑换 / 兑换记录 / 撤销兑换。
 *
 * 兑换入口挂在 `/biz/members/:id/redeem`（契约如此），但归属积分域，所以和
 * `/biz/points/**`、`/biz/points-redeems/**` 放在同一个 controller 里。
 */
@ApiTags('积分')
@ApiBearerAuth('access-token')
@Controller('biz')
export class PointsController {
  constructor(private readonly goods: PointsGoodsService) {}

  @Post('points/preview')
  @RequirePermissions('biz:member:list')
  @ApiOperation({ summary: '积分抵扣试算（服务端按 §5.7 复算上限）' })
  @ApiBody({ schema: { $ref: '#/components/schemas/PointsPreviewRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  preview(@Body() body: unknown) {
    const input = previewSchema.parse(body);
    return this.goods.preview(input.customerId, input.serviceItemIds);
  }

  @Post('members/:id/redeem')
  @RequirePermissions('biz:points:redeem')
  @ApiOperation({ summary: '积分兑换（同事务扣积分 + 发次卡）' })
  @ApiParam({ name: 'id', description: '会员（顾客）ID' })
  @ApiBody({ schema: { $ref: '#/components/schemas/RedeemPointsRequest' } })
  @ApiQuery({
    name: 'goodsId',
    required: false,
    description: '兑换品ID（兼容 query 传参，优先取 body）',
  })
  @ApiResponse({ status: 200, description: '成功' })
  redeem(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
    @Query('goodsId') rawGoodsId?: string,
  ) {
    const parsed = redeemSchema.safeParse(body);
    const goodsId = parsed.success
      ? parsed.data.goodsId
      : toPositiveInt(rawGoodsId);
    if (goodsId === undefined)
      throw new BadRequestException('请提供兑换品 goodsId');
    return this.goods.redeem(id, goodsId, request.user.id);
  }

  @Get('points-redeems')
  @RequirePermissions('biz:points:redeem')
  @ApiOperation({ summary: '兑换记录列表' })
  @ApiQuery({ name: 'page', required: false, description: '页码' })
  @ApiQuery({ name: 'pageSize', required: false, description: '每页条数' })
  @ApiQuery({ name: 'customerId', required: false, description: '会员ID' })
  @ApiQuery({ name: 'goodsId', required: false, description: '兑换品ID' })
  @ApiQuery({ name: 'status', required: false, description: '状态' })
  @ApiResponse({ status: 200, description: '成功' })
  listRedeems(
    @Query('page') rawPage?: string,
    @Query('pageSize') rawPageSize?: string,
    @Query('customerId') rawCustomerId?: string,
    @Query('goodsId') rawGoodsId?: string,
    @Query('status') status?: string,
  ) {
    const { page, pageSize } = parsePagination(rawPage, rawPageSize);
    return this.goods.listRedeems(page, pageSize, {
      customerId: toPositiveInt(rawCustomerId),
      goodsId: toPositiveInt(rawGoodsId),
      status: REDEEM_STATUS.find((item) => item === status),
    });
  }

  @Post('points-redeems/:id/revert')
  @RequirePermissions('biz:points:revert')
  @ApiOperation({ summary: '撤销兑换（回补积分 + 废卡，必填原因）' })
  @ApiParam({ name: 'id', description: '兑换记录ID' })
  @ApiBody({
    schema: { $ref: '#/components/schemas/RevertPointsRedeemRequest' },
  })
  @ApiResponse({ status: 200, description: '成功' })
  revertRedeem(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    const input = revertRedeemSchema.parse(body);
    return this.goods.revertRedeem(id, input.reason, request.user.id);
  }
}

function toPositiveInt(raw?: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
