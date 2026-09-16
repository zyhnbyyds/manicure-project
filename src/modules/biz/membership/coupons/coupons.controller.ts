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
import { registerComponent } from '../../../../common/swagger/zod-schema.helper';
import { parsePagination } from '../../common/query';
import { CouponsService } from './coupons.service';

/**
 * 券模板的字段规则。
 *
 * 与 `CouponsService.assertTemplateInput` 是**两层**：这里是「入参形状」，
 * 那里是「业务规则」（面额不得大于门槛、生效时间先后等）——
 * 两边都要有，因为业务规则也要保护非 HTTP 入口（后台脚本、以后的活动发券）。
 */
const createSchema = z.object({
  name: z.string().min(1).max(50),
  /** 使用门槛（分）；0 = 无门槛 */
  thresholdAmount: z.number().int().min(0).optional(),
  /** 面额（分） */
  discountAmount: z.number().int().min(1),
  /** 领取后有效天数；0 = 用 validFrom/validTo 的绝对区间 */
  validDays: z.number().int().min(0).optional(),
  validFrom: z.string().datetime().nullable().optional(),
  validTo: z.string().datetime().nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  sort: z.number().int().min(0).optional(),
  remark: z.string().max(200).nullable().optional(),
});
const updateSchema = createSchema.partial();

registerComponent('CreateCouponTemplateRequest', createSchema);
registerComponent('UpdateCouponTemplateRequest', updateSchema);

type AuthRequest = { user: { id: number } };

/**
 * 优惠券模板维护（后台）。
 *
 * 术语对齐：**模板**是"以后还发不发"的开关，**券**是顾客手里那张。
 * 停用/删除模板**不影响已发出的券** —— 面额与门槛在发券时就快照到持有行了，
 * 所以列表里给出 `claimedCount`，让运营知道停用的影响面。
 */
@ApiTags('优惠券模板')
@ApiBearerAuth('access-token')
@Controller('biz/coupon-templates')
export class CouponsController {
  constructor(private readonly coupons: CouponsService) {}

  @Get()
  @RequirePermissions('biz:coupon:list')
  @ApiOperation({ summary: '券模板列表（含已发出张数）' })
  @ApiQuery({ name: 'page', required: false, description: '页码' })
  @ApiQuery({ name: 'pageSize', required: false, description: '每页条数' })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'active / disabled',
  })
  @ApiQuery({ name: 'keyword', required: false, description: '名称（模糊）' })
  @ApiResponse({ status: 200, description: '成功' })
  list(
    @Query('page') rawPage?: string,
    @Query('pageSize') rawPageSize?: string,
    @Query('status') status?: string,
    @Query('keyword') keyword?: string,
  ) {
    const { page, pageSize } = parsePagination(rawPage, rawPageSize);
    return this.coupons.listTemplates(page, pageSize, {
      status: status === 'active' || status === 'disabled' ? status : undefined,
      keyword: keyword?.trim() || undefined,
    });
  }

  @Get(':id')
  @RequirePermissions('biz:coupon:list')
  @ApiOperation({ summary: '券模板详情' })
  @ApiParam({ name: 'id', description: '模板 ID' })
  @ApiResponse({ status: 200, description: '成功' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.coupons.findTemplate(id);
  }

  @Post()
  @RequirePermissions('biz:coupon:create')
  @ApiOperation({ summary: '新增券模板' })
  @ApiBody({
    schema: { $ref: '#/components/schemas/CreateCouponTemplateRequest' },
  })
  @ApiResponse({ status: 200, description: '成功' })
  @ApiResponse({ status: 409, description: '同名模板已存在' })
  create(@Body() body: unknown, @Req() request: AuthRequest) {
    return this.coupons.createTemplate(
      createSchema.parse(body),
      request.user.id,
    );
  }

  @Patch(':id')
  @RequirePermissions('biz:coupon:update')
  @ApiOperation({ summary: '修改券模板' })
  @ApiParam({ name: 'id', description: '模板 ID' })
  @ApiBody({
    schema: { $ref: '#/components/schemas/UpdateCouponTemplateRequest' },
  })
  @ApiResponse({ status: 200, description: '成功' })
  @ApiResponse({ status: 409, description: '同名模板已存在' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    return this.coupons.updateTemplate(
      id,
      updateSchema.parse(body),
      request.user.id,
    );
  }

  /**
   * 停用（软删）模板。
   *
   * **已发出的券不受影响**（面额/门槛已快照），所以这里是安全操作；
   * 但如果运营的意图是「不再让新顾客领到」，改成 `PATCH status=disabled` 更合适 ——
   * 软删会让它从可领列表里彻底消失。
   */
  @Delete(':id')
  @RequirePermissions('biz:coupon:delete')
  @ApiOperation({ summary: '停用券模板（软删，不影响已发出的券）' })
  @ApiParam({ name: 'id', description: '模板 ID' })
  @ApiResponse({ status: 200, description: '成功' })
  remove(@Param('id', ParseIntPipe) id: number, @Req() request: AuthRequest) {
    return this.coupons.removeTemplate(id, request.user.id);
  }
}
