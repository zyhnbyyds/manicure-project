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
import { MAX_PAGE_SIZE } from '../../common/query';
import { ReviewsService } from './reviews.service';

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

const createSchema = z.object({
  bookingId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ example: 1, description: '预约ID（必须已完成，且未被评价）' }),
  score: z.coerce
    .number()
    .int()
    .min(1)
    .max(5)
    .openapi({ example: 5, description: '评分 1..5' }),
  content: z
    .string()
    .max(1000)
    .nullable()
    .optional()
    .openapi({ example: '手法很好', description: '评价内容' }),
  images: z
    .array(z.string().max(500))
    .nullable()
    .optional()
    .openapi({ description: '图片地址数组' }),
  isPublic: z
    .boolean()
    .optional()
    .openapi({ example: true, description: '是否公开展示' }),
});

const replySchema = z.object({
  reply: z
    .string()
    .min(1)
    .max(500)
    .openapi({ example: '感谢您的支持！', description: '店家回复' }),
});

const visibilitySchema = z.object({
  status: z
    .enum(['published', 'hidden'])
    .optional()
    .openapi({ example: 'hidden', description: '隐藏用于处理恶意评价' }),
  isPublic: z.boolean().optional().openapi({ description: '是否公开展示' }),
});

/** 列表筛选项：前端清空下拉框会发空字符串，统一按「不筛选」处理 */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (value) => (value === '' || value === null ? undefined : value),
    schema.optional(),
  );

const listQuerySchema = z.object({
  page: optional(z.coerce.number().int().min(1)),
  pageSize: optional(z.coerce.number().int().min(1).max(MAX_PAGE_SIZE)),
  staffId: optional(z.coerce.number().int().positive()),
  customerId: optional(z.coerce.number().int().positive()),
  score: optional(z.coerce.number().int().min(1).max(5)),
  status: optional(z.enum(['published', 'hidden'])),
  dateFrom: optional(z.string().regex(LOCAL_DATE)),
  dateTo: optional(z.string().regex(LOCAL_DATE)),
});

registerComponent('CreateReviewRequest', createSchema);
registerComponent('ReplyReviewRequest', replySchema);
registerComponent('UpdateReviewRequest', visibilitySchema);

type AuthRequest = {
  user: { id: number; permissions: string[] };
};

@ApiTags('服务评价')
@ApiBearerAuth('access-token')
@Controller('biz/reviews')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  @RequirePermissions('biz:review:list')
  @ApiOperation({ summary: '评价列表（美甲师只能看自己的评价）' })
  @ApiQuery({ name: 'staffId', required: false, description: '美甲师ID' })
  @ApiQuery({ name: 'score', required: false, description: '评分 1..5' })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'published / hidden',
  })
  @ApiQuery({ name: 'dateFrom', required: false, description: '店内本地日' })
  @ApiQuery({ name: 'dateTo', required: false, description: '店内本地日' })
  @ApiResponse({ status: 200, description: '成功' })
  list(@Query() query: unknown, @Req() request: AuthRequest) {
    const filter = listQuerySchema.parse(query);
    return this.reviews.list(filter.page ?? 1, filter.pageSize ?? 20, filter, {
      userId: request.user.id,
      permissions: request.user.permissions,
    });
  }

  @Post()
  @RequirePermissions('biz:review:create')
  @ApiOperation({ summary: '后台代录评价（一单一评）' })
  @ApiBody({ schema: { $ref: '#/components/schemas/CreateReviewRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  create(@Body() body: unknown, @Req() request: AuthRequest) {
    return this.reviews.create(createSchema.parse(body), request.user.id);
  }

  @Post(':id/reply')
  @RequirePermissions('biz:review:reply')
  @ApiOperation({ summary: '店家回复评价' })
  @ApiParam({ name: 'id', description: '评价ID' })
  @ApiBody({ schema: { $ref: '#/components/schemas/ReplyReviewRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  reply(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    const input = replySchema.parse(body);
    return this.reviews.reply(id, input.reply, request.user.id);
  }

  @Patch(':id')
  @RequirePermissions('biz:review:hide')
  @ApiOperation({ summary: '隐藏 / 公开评价' })
  @ApiParam({ name: 'id', description: '评价ID' })
  @ApiBody({ schema: { $ref: '#/components/schemas/UpdateReviewRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    return this.reviews.updateVisibility(
      id,
      visibilitySchema.parse(body),
      request.user.id,
    );
  }

  @Delete(':id')
  @RequirePermissions('biz:review:delete')
  @ApiOperation({ summary: '删除评价（软删）' })
  @ApiParam({ name: 'id', description: '评价ID' })
  @ApiResponse({ status: 200, description: '成功' })
  remove(@Param('id', ParseIntPipe) id: number, @Req() request: AuthRequest) {
    return this.reviews.remove(id, request.user.id);
  }
}
