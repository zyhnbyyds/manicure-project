import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../../common/auth/public.decorator.js';
import { BookingPort } from '../../biz/common/ports.js';
import { AppStaffWorkbenchService } from './app-staff-workbench.service.js';
import {
  APP_STAFF_GUARDS,
  type AppStaffRequest,
} from './app-staff-scope.guard.js';

/**
 * 美甲师工作台（S3 只读 + S4 写，施工单 §12.5）。
 *
 * `@Public()` 是为了跳过**后台** admin 守卫（本域只有 app token），
 * 真正的准入由 `APP_STAFF_GUARDS` 保证：app token + 每请求复查美甲师身份。
 */
@ApiTags('小程序端 - 美甲师工作台')
@ApiBearerAuth('app-token')
@Public()
@UseGuards(...APP_STAFF_GUARDS)
@Controller('app/staff')
export class AppStaffWorkbenchController {
  constructor(
    private readonly workbench: AppStaffWorkbenchService,
    private readonly bookingPort: BookingPort,
  ) {}

  private staffIdOf(request: AppStaffRequest): number {
    const staffId = request.appStaff?.staffId;
    if (!staffId) throw new UnauthorizedException();
    return staffId;
  }

  @Get('me')
  @ApiOperation({
    summary: '我的美甲师档案',
    description: '档案 + 授权状态 + 可做项目白名单（null = 全部可做）。',
  })
  @ApiResponse({ status: 200, description: '成功' })
  @ApiResponse({ status: 401, description: '未登录' })
  @ApiResponse({ status: 403, description: '工作台未开通或已失效' })
  me(@Req() request: AppStaffRequest) {
    return this.workbench.me(this.staffIdOf(request));
  }

  @Get('bookings')
  @ApiOperation({
    summary: '我的预约',
    description:
      '硬限定本人 `staff_id`；顾客手机号一律脱敏（小程序端只拨号，不展示明文）。',
  })
  @ApiQuery({ name: 'page', required: false, description: '页码', example: 1 })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: '每页条数',
    example: 20,
  })
  @ApiQuery({
    name: 'date',
    required: false,
    description: '店内本地日 YYYY-MM-DD（今日日程）',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: '预约状态过滤',
  })
  @ApiResponse({ status: 200, description: '成功' })
  bookings(
    @Req() request: AppStaffRequest,
    @Query('page') rawPage?: string,
    @Query('pageSize') rawPageSize?: string,
    @Query('date') date?: string,
    @Query('status') status?: string,
  ) {
    const page = Math.max(Number(rawPage ?? 1) || 1, 1);
    const pageSize = Math.min(
      Math.max(Number(rawPageSize ?? 20) || 20, 1),
      100,
    );
    return this.workbench.bookings(this.staffIdOf(request), page, pageSize, {
      date,
      status,
    });
  }

  @Get('schedule')
  @ApiOperation({
    summary: '我的排班',
    description: '当天的生效班次（周模板 / 日期例外）与休息标记。',
  })
  @ApiQuery({
    name: 'date',
    required: true,
    description: '店内本地日 YYYY-MM-DD',
  })
  @ApiResponse({ status: 200, description: '成功' })
  @ApiResponse({ status: 400, description: 'date 缺失或格式错误' })
  schedule(@Req() request: AppStaffRequest, @Query('date') date?: string) {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw new BadRequestException('date 必须是 YYYY-MM-DD');
    return this.workbench.schedule(this.staffIdOf(request), date);
  }

  @Get('performance')
  @ApiOperation({
    summary: '我的业绩',
    description:
      '完成单量 / 实收合计 / 提成汇总（待结算·已结算·已冲销）/ 平均评分，' +
      '外加**逐单提成明细**（D9：全见）。period 为 yyyyMM，默认当月。',
  })
  @ApiQuery({
    name: 'period',
    required: false,
    description: 'yyyyMM，如 202609；不传 = 当月',
    example: '202609',
  })
  @ApiResponse({ status: 200, description: '成功' })
  performance(
    @Req() request: AppStaffRequest,
    @Query('period') period?: string,
  ) {
    return this.workbench.performance(this.staffIdOf(request), period);
  }

  @Get('reviews')
  @ApiOperation({
    summary: '我的评价',
    description: '只出已公开的评价；隐藏的不给本人看（§20.1）。',
  })
  @ApiQuery({ name: 'page', required: false, description: '页码', example: 1 })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: '每页条数',
    example: 20,
  })
  @ApiResponse({ status: 200, description: '成功' })
  reviews(
    @Req() request: AppStaffRequest,
    @Query('page') rawPage?: string,
    @Query('pageSize') rawPageSize?: string,
  ) {
    const page = Math.max(Number(rawPage ?? 1) || 1, 1);
    const pageSize = Math.min(
      Math.max(Number(rawPageSize ?? 20) || 20, 1),
      100,
    );
    return this.workbench.reviews(this.staffIdOf(request), page, pageSize);
  }

  @Get('bookings/:id/phone')
  @ApiOperation({
    summary: '取顾客真号（仅供拨号）',
    description:
      '列表里只给脱敏值（D11），真号**点一次取一次**且限本人单 —— ' +
      '抓包 / 截图拿不到批量号码，只有真要打电话的那一瞬间才取。',
  })
  @ApiParam({ name: 'id', description: '预约ID' })
  @ApiResponse({ status: 200, description: '成功' })
  @ApiResponse({ status: 403, description: '只能查看本人的预约' })
  @ApiResponse({ status: 404, description: '预约不存在' })
  phone(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: AppStaffRequest,
  ) {
    return this.bookingPort.phoneForStaff(id, this.staffIdOf(request));
  }

  @Post('bookings/:id/arrived')
  @ApiOperation({
    summary: '标记顾客已到店',
    description: '非本人单 403；已到店再点返回 `changed:false`（幂等）。',
  })
  @ApiParam({ name: 'id', description: '预约ID' })
  @ApiResponse({ status: 201, description: '成功' })
  @ApiResponse({ status: 403, description: '只能操作本人的预约' })
  @ApiResponse({ status: 404, description: '预约不存在' })
  @ApiResponse({ status: 409, description: '当前状态不允许该操作' })
  arrive(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: AppStaffRequest,
  ) {
    return this.bookingPort.arriveForStaff(id, this.staffIdOf(request), null);
  }

  @Post('bookings/:id/complete')
  @ApiOperation({
    summary: '标记服务完成',
    description:
      '走既有完成动作（提成计提 + 到店次数 + 幂等闸门），app 域不自己改状态。' +
      '早于 `start_at` 会被拒绝（§12.4-3，防提前刷提成）。',
  })
  @ApiParam({ name: 'id', description: '预约ID' })
  @ApiResponse({ status: 201, description: '成功' })
  @ApiResponse({ status: 400, description: '服务尚未开始' })
  @ApiResponse({ status: 403, description: '只能操作本人的预约' })
  @ApiResponse({ status: 404, description: '预约不存在' })
  complete(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: AppStaffRequest,
  ) {
    return this.bookingPort.completeForStaff(id, this.staffIdOf(request), null);
  }
}
