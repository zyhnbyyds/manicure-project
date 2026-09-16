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
import { CreditAccountsService } from './credit-accounts.service';

const accountType = z
  .enum(['customer', 'company', 'staff'])
  .openapi({ example: 'company', description: '主体类型：顾客/公司/员工' });

const createSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(50)
    .openapi({ example: 'XX 传媒公司', description: '主体名称（全局唯一）' }),
  type: accountType,
  customerId: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .openapi({ example: 12, description: '关联顾客 ID（type=customer 时填）' }),
  contact: z
    .string()
    .max(50)
    .nullable()
    .optional()
    .openapi({ example: '李经理', description: '联系人' }),
  phone: z
    .string()
    .max(20)
    .nullable()
    .optional()
    .openapi({ example: '13800000000', description: '联系电话' }),
  creditLimit: z
    .number()
    .int()
    .min(0)
    .optional()
    .openapi({ example: 500000, description: '挂账额度（分），0 = 不限' }),
  settleDay: z
    .number()
    .int()
    .min(0)
    .max(28)
    .optional()
    .openapi({ example: 5, description: '月结日 1..28，0 = 不定期' }),
  status: z
    .enum(['active', 'disabled'])
    .optional()
    .openapi({ example: 'active', description: '状态' }),
  remark: z
    .string()
    .max(500)
    .nullable()
    .optional()
    .openapi({ example: '月结 30 天', description: '备注' }),
});

const updateSchema = createSchema.partial();

const listQuerySchema = z.object({
  type: accountType.optional(),
  status: z.enum(['active', 'disabled']).optional(),
  keyword: z.string().max(50).optional(),
});

registerComponent('CreateCreditAccountRequest', createSchema);
registerComponent('UpdateCreditAccountRequest', updateSchema);

type AuthRequest = { user: { id: number } };

@ApiTags('挂账主体')
@ApiBearerAuth('access-token')
@Controller('biz/credit-accounts')
export class CreditAccountsController {
  constructor(private readonly creditAccounts: CreditAccountsService) {}

  @Get()
  @RequirePermissions('biz:credit:list')
  @ApiOperation({ summary: '挂账主体列表（含额度与已挂未结金额）' })
  @ApiQuery({ name: 'page', required: false, description: '页码', example: 1 })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: '每页条数',
    example: 20,
  })
  @ApiQuery({
    name: 'keyword',
    required: false,
    description: '名称/电话关键字',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    description: '主体类型 customer/company/staff',
  })
  @ApiQuery({ name: 'status', required: false, description: 'active/disabled' })
  @ApiResponse({ status: 200, description: '成功' })
  list(
    @Query('page') rawPage?: string,
    @Query('pageSize') rawPageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
  ) {
    const { page, pageSize } = parsePagination(rawPage, rawPageSize);
    const query = listQuerySchema.parse({ keyword, type, status });
    return this.creditAccounts.list(page, pageSize, query);
  }

  @Post()
  @RequirePermissions('biz:credit:create')
  @ApiOperation({ summary: '新增挂账主体' })
  @ApiBody({
    schema: { $ref: '#/components/schemas/CreateCreditAccountRequest' },
  })
  @ApiResponse({ status: 200, description: '成功' })
  create(@Body() body: unknown, @Req() request: AuthRequest) {
    return this.creditAccounts.create(
      createSchema.parse(body),
      request.user.id,
    );
  }

  @Patch(':id')
  @RequirePermissions('biz:credit:update')
  @ApiOperation({ summary: '修改挂账主体' })
  @ApiParam({ name: 'id', description: '挂账主体ID' })
  @ApiBody({
    schema: { $ref: '#/components/schemas/UpdateCreditAccountRequest' },
  })
  @ApiResponse({ status: 200, description: '成功' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    return this.creditAccounts.update(
      id,
      updateSchema.parse(body),
      request.user.id,
    );
  }

  @Delete(':id')
  @RequirePermissions('biz:credit:delete')
  @ApiOperation({ summary: '删除挂账主体（有未结应收时拒绝）' })
  @ApiParam({ name: 'id', description: '挂账主体ID' })
  @ApiResponse({ status: 200, description: '成功' })
  remove(@Param('id', ParseIntPipe) id: number, @Req() request: AuthRequest) {
    return this.creditAccounts.remove(id, request.user.id);
  }
}
