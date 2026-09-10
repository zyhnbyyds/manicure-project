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
import { RequirePermissions } from '../../../../common/auth/permissions.decorator.js';
import { registerComponent } from '../../../../common/swagger/zod-schema.helper.js';
import { NoticesService } from './notices.service.js';

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

const templateVariablesSchema = z.union([
  z.array(z.string()),
  z.array(z.record(z.string(), z.unknown())),
  z.record(z.string(), z.unknown()),
]);

const createTemplateSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9_]+$/)
    .openapi({ example: 'booking_remind', description: '模板编码（唯一）' }),
  name: z
    .string()
    .min(1)
    .max(50)
    .openapi({ example: '次日预约提醒', description: '模板名称' }),
  channel: z
    .enum(['sms', 'site', 'both'])
    .optional()
    .openapi({ example: 'both', description: '发送渠道' }),
  title: z
    .string()
    .max(100)
    .nullable()
    .optional()
    .openapi({ example: '预约提醒', description: '站内消息标题' }),
  content: z.string().min(1).max(1000).openapi({
    example: '{customerName} 您好，您明天 {time} 有预约',
    description: '模板内容，支持 {变量}',
  }),
  variables: templateVariablesSchema
    .optional()
    .openapi({ description: '变量声明（字符串数组 / 对象数组 / 对象映射）' }),
  status: z
    .enum(['active', 'disabled'])
    .optional()
    .openapi({ example: 'active', description: '状态' }),
  remark: z
    .string()
    .max(200)
    .nullable()
    .optional()
    .openapi({ description: '备注' }),
});
const updateTemplateSchema = createTemplateSchema.partial();

/**
 * 列表筛选项统一口径：前端下拉框清空时会发空字符串（`status=''`），
 * 一律按「不筛选」处理，避免 400（`web/src/api/biz/*.ts` 的 `X | ''` 就是这种用法）。
 */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (value) => (value === '' || value === null ? undefined : value),
    schema.optional(),
  );

const templateQuerySchema = z.object({
  page: optional(z.coerce.number().int().min(1)),
  pageSize: optional(z.coerce.number().int().min(1).max(100)),
  channel: optional(z.enum(['sms', 'site', 'both'])),
  status: optional(z.enum(['active', 'disabled'])),
  keyword: optional(z.string().max(50)),
});

const logQuerySchema = z.object({
  page: optional(z.coerce.number().int().min(1)),
  pageSize: optional(z.coerce.number().int().min(1).max(100)),
  channel: optional(z.enum(['sms', 'site'])),
  status: optional(z.enum(['pending', 'success', 'failed', 'skipped'])),
  templateCode: optional(z.string().max(50)),
  recipientType: optional(z.enum(['customer', 'user'])),
  recipientId: optional(z.coerce.number().int().positive()),
  dateFrom: optional(z.string().regex(LOCAL_DATE)),
  dateTo: optional(z.string().regex(LOCAL_DATE)),
});

const sendSchema = z.object({
  templateCode: z.string().min(1).max(50),
  recipientType: z.enum(['customer', 'user']),
  recipientIds: z.array(z.coerce.number().int().positive()).min(1).max(200),
  variables: z
    .record(z.string(), z.union([z.string(), z.number()]))
    .default({}),
  channels: z.array(z.enum(['sms', 'site'])).optional(),
  bookingId: z.coerce.number().int().positive().nullable().optional(),
});

const inboxQuerySchema = z.object({
  page: optional(z.coerce.number().int().min(1)),
  pageSize: optional(z.coerce.number().int().min(1).max(100)),
});

const inboxReadSchema = z.object({
  ids: z.array(z.coerce.number().int().positive()).max(200).optional(),
});

registerComponent('CreateNoticeTemplateRequest', createTemplateSchema);
registerComponent('UpdateNoticeTemplateRequest', updateTemplateSchema);
registerComponent('SendNoticeRequest', sendSchema);
registerComponent('ReadNoticeInboxRequest', inboxReadSchema);

type AuthRequest = { user: { id: number } };

@ApiTags('通知（模板 / 发送日志 / 站内消息）')
@ApiBearerAuth('access-token')
@Controller('biz')
export class NoticesController {
  constructor(private readonly notices: NoticesService) {}

  @Get('notice-templates')
  @RequirePermissions('biz:notice:template')
  @ApiOperation({ summary: '通知模板列表' })
  @ApiResponse({ status: 200, description: '成功' })
  listTemplates(@Query() query: unknown) {
    const filter = templateQuerySchema.parse(query);
    return this.notices.listTemplates(
      filter.page ?? 1,
      filter.pageSize ?? 20,
      filter,
    );
  }

  @Post('notice-templates')
  @RequirePermissions('biz:notice:template')
  @ApiOperation({ summary: '新增通知模板（校验 {变量} 都已声明）' })
  @ApiBody({
    schema: { $ref: '#/components/schemas/CreateNoticeTemplateRequest' },
  })
  @ApiResponse({ status: 200, description: '成功' })
  createTemplate(@Body() body: unknown, @Req() request: AuthRequest) {
    return this.notices.createTemplate(
      createTemplateSchema.parse(body),
      request.user.id,
    );
  }

  @Patch('notice-templates/:id')
  @RequirePermissions('biz:notice:template')
  @ApiOperation({ summary: '修改通知模板' })
  @ApiParam({ name: 'id', description: '模板ID' })
  @ApiBody({
    schema: { $ref: '#/components/schemas/UpdateNoticeTemplateRequest' },
  })
  @ApiResponse({ status: 200, description: '成功' })
  updateTemplate(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    return this.notices.updateTemplate(
      id,
      updateTemplateSchema.parse(body),
      request.user.id,
    );
  }

  @Delete('notice-templates/:id')
  @RequirePermissions('biz:notice:template')
  @ApiOperation({ summary: '删除通知模板（软删，历史日志保留）' })
  @ApiParam({ name: 'id', description: '模板ID' })
  @ApiResponse({ status: 200, description: '成功' })
  removeTemplate(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: AuthRequest,
  ) {
    return this.notices.removeTemplate(id, request.user.id);
  }

  @Get('notice-logs')
  @RequirePermissions('biz:notice:log')
  @ApiOperation({ summary: '通知发送记录' })
  @ApiQuery({ name: 'channel', required: false, description: '渠道 sms/site' })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'pending/success/failed/skipped',
  })
  @ApiQuery({ name: 'templateCode', required: false, description: '模板编码' })
  @ApiQuery({ name: 'dateFrom', required: false, description: '店内本地日' })
  @ApiQuery({ name: 'dateTo', required: false, description: '店内本地日' })
  @ApiResponse({ status: 200, description: '成功' })
  listLogs(@Query() query: unknown) {
    const filter = logQuerySchema.parse(query);
    return this.notices.listLogs(
      filter.page ?? 1,
      filter.pageSize ?? 20,
      filter,
    );
  }

  @Get('notice-logs/:id')
  @RequirePermissions('biz:notice:log')
  @ApiOperation({ summary: '通知记录详情（渲染后内容 + 供应商消息号 + 错误）' })
  @ApiParam({ name: 'id', description: '日志ID' })
  @ApiResponse({ status: 200, description: '成功' })
  findLog(@Param('id', ParseIntPipe) id: number) {
    return this.notices.findLog(id);
  }

  @Post('notice-logs/:id/resend')
  @RequirePermissions('biz:notice:send')
  @ApiOperation({ summary: '重发单条通知' })
  @ApiParam({ name: 'id', description: '日志ID' })
  @ApiResponse({ status: 200, description: '成功' })
  resend(@Param('id', ParseIntPipe) id: number) {
    return this.notices.resend(id);
  }

  @Post('notice/send')
  @RequirePermissions('biz:notice:send')
  @ApiOperation({ summary: '手动发送通知' })
  @ApiBody({ schema: { $ref: '#/components/schemas/SendNoticeRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  async send(@Body() body: unknown) {
    const input = sendSchema.parse(body);
    // 打错模板 code 时给 404，而不是静默降级成兜底站内消息
    await this.notices.assertTemplateExists(input.templateCode);
    return this.notices.sendToMany({
      templateCode: input.templateCode,
      recipientType: input.recipientType,
      recipientIds: input.recipientIds,
      variables: input.variables,
      channels: input.channels,
      bookingId: input.bookingId ?? null,
    });
  }

  /** 站内消息：**登录即可，不加权限点**（§19.4） */
  @Get('notice/inbox')
  @ApiOperation({ summary: '当前后台用户的站内消息（未读 = read_at IS NULL）' })
  @ApiResponse({ status: 200, description: '成功' })
  inbox(@Query() query: unknown, @Req() request: AuthRequest) {
    const filter = inboxQuerySchema.parse(query);
    return this.notices.inbox(
      request.user.id,
      filter.page ?? 1,
      filter.pageSize ?? 20,
    );
  }

  @Post('notice/inbox/read')
  @ApiOperation({ summary: '批量标记站内消息已读（不传 ids 表示全部已读）' })
  @ApiBody({ schema: { $ref: '#/components/schemas/ReadNoticeInboxRequest' } })
  @ApiResponse({ status: 200, description: '成功' })
  markInboxRead(@Body() body: unknown, @Req() request: AuthRequest) {
    const input = inboxReadSchema.parse(body);
    return this.notices.markInboxRead(request.user.id, input.ids);
  }
}
