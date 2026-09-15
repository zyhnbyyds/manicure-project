import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
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
import { RequirePermissions } from '../../../common/auth/permissions.decorator.js';
import { registerComponent } from '../../../common/swagger/zod-schema.helper.js';
import {
  SchedulingService,
  type ScheduleOverrideFilter,
} from './scheduling.service.js';

const TIME_PATTERN = /^\d{2}:\d{2}(:\d{2})?$/;

const shiftSchema = z.object({
  weekday: z
    .number()
    .int()
    .min(1)
    .max(7)
    .openapi({ example: 1, description: '1=周一 … 7=周日' }),
  startTime: z
    .string()
    .regex(TIME_PATTERN)
    .openapi({ example: '10:00:00', description: '开始时间 HH:MM:SS' }),
  endTime: z
    .string()
    .regex(TIME_PATTERN)
    .openapi({ example: '12:00:00', description: '结束时间 HH:MM:SS' }),
});

/** 兼容 `{ shifts: [...] }` 与裸数组两种写法 */
const replaceWeeklyShiftsSchema = z.union([
  z.array(shiftSchema).max(70),
  z.object({ shifts: z.array(shiftSchema).max(70) }),
]);

const createOverrideSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .openapi({ example: '2026-09-12', description: '生效日期 YYYY-MM-DD' }),
  type: z.enum(['off', 'custom']).openapi({
    example: 'off',
    description: 'off=整天休息；custom=自定义时段',
  }),
  startTime: z
    .string()
    .regex(TIME_PATTERN)
    .nullish()
    .openapi({ example: '10:00:00', description: 'type=custom 时必填' }),
  endTime: z
    .string()
    .regex(TIME_PATTERN)
    .nullish()
    .openapi({ example: '18:00:00', description: 'type=custom 时必填' }),
  reason: z
    .string()
    .max(200)
    .nullish()
    .openapi({ example: '调休', description: '原因' }),
  force: z.boolean().optional().openapi({
    example: false,
    description: '该日已有预约落在新班次外时，true 才强制落库（§6.4）',
  }),
});

registerComponent('ReplaceWeeklyShiftsRequest', replaceWeeklyShiftsSchema);
registerComponent('CreateScheduleOverrideRequest', createOverrideSchema);

type AuthRequest = { user: { id: number } };

/** `?storeId=` → 门店 id；不传 / 非法 = `null`（= 通用层） */
function parseStoreId(raw?: string): number | null {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

@ApiTags('排班')
@ApiBearerAuth('access-token')
@Controller('biz/staffs')
export class SchedulingController {
  constructor(private readonly scheduling: SchedulingService) {}

  @Get(':id/weekly-shifts')
  @RequirePermissions('biz:schedule:list')
  @ApiOperation({ summary: '美甲师周模板班次（7 天全部段）' })
  @ApiParam({ name: 'id', description: '美甲师ID' })
  @ApiQuery({
    name: 'storeId',
    required: false,
    description:
      '门店ID。传了返回**该门店实际生效**的模板（门店专属优先、通用兜底），' +
      '响应里的 `source` 说明用的是哪一层；不传 = 只看通用模板',
  })
  @ApiResponse({ status: 200, description: '成功' })
  getWeeklyShifts(
    @Param('id', ParseIntPipe) id: number,
    @Query('storeId') rawStoreId?: string,
  ) {
    return this.scheduling.getWeeklyShifts(id, parseStoreId(rawStoreId));
  }

  @Put(':id/weekly-shifts')
  @RequirePermissions('biz:schedule:update')
  @ApiOperation({
    summary:
      '整体替换周模板（事务内先删后插；越界预约会让保存 409）。**只替换指定那一层**',
  })
  @ApiParam({ name: 'id', description: '美甲师ID' })
  @ApiQuery({
    name: 'storeId',
    required: false,
    description:
      '门店ID：传了就替换该门店的**专属模板**，不传则替换**通用模板**（两者互不影响）',
  })
  @ApiBody({
    schema: { $ref: '#/components/schemas/ReplaceWeeklyShiftsRequest' },
  })
  @ApiResponse({ status: 200, description: '成功' })
  @ApiResponse({
    status: 409,
    description: '既有预约超出新班次，响应带 conflicts 清单',
  })
  async replaceWeeklyShifts(
    @Param('id', ParseIntPipe) id: number,
    @Query('storeId') rawStoreId: string | undefined,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    const parsed = replaceWeeklyShiftsSchema.parse(body);
    const shifts = Array.isArray(parsed) ? parsed : parsed.shifts;
    await this.scheduling.replaceWeeklyShifts(
      id,
      parseStoreId(rawStoreId),
      shifts,
      request.user.id,
    );
    return { success: true, count: shifts.length };
  }

  @Get(':id/overrides')
  @RequirePermissions('biz:schedule:list')
  @ApiOperation({ summary: '日期例外列表' })
  @ApiParam({ name: 'id', description: '美甲师ID' })
  @ApiQuery({ name: 'from', required: false, description: '起始日 YYYY-MM-DD' })
  @ApiQuery({ name: 'to', required: false, description: '结束日 YYYY-MM-DD' })
  @ApiResponse({ status: 200, description: '成功' })
  listOverrides(
    @Param('id', ParseIntPipe) id: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const filter: ScheduleOverrideFilter = {};
    if (from) filter.from = from;
    if (to) filter.to = to;
    return this.scheduling.listOverrides(id, filter);
  }

  @Post(':id/overrides')
  @RequirePermissions('biz:schedule:update')
  @ApiOperation({ summary: '新增日期例外（请假 / 自定义时段）' })
  @ApiParam({ name: 'id', description: '美甲师ID' })
  @ApiBody({
    schema: { $ref: '#/components/schemas/CreateScheduleOverrideRequest' },
  })
  @ApiResponse({ status: 200, description: '成功' })
  @ApiResponse({
    status: 409,
    description: '该日既有预约落在新班次外，响应带 conflicts 清单',
  })
  createOverride(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    const { force, ...input } = createOverrideSchema.parse(body);
    return this.scheduling.createOverride(id, input, request.user.id, force);
  }

  @Delete(':id/overrides/:overrideId')
  @RequirePermissions('biz:schedule:update')
  @ApiOperation({ summary: '删除日期例外' })
  @ApiParam({ name: 'id', description: '美甲师ID' })
  @ApiParam({ name: 'overrideId', description: '例外ID' })
  @ApiQuery({
    name: 'force',
    required: false,
    description: 'true 时忽略冲突强制删除',
  })
  @ApiResponse({ status: 200, description: '成功' })
  @ApiResponse({
    status: 409,
    description: '删除后有预约落在班次外，响应带 conflicts 清单',
  })
  deleteOverride(
    @Param('id', ParseIntPipe) id: number,
    @Param('overrideId', ParseIntPipe) overrideId: number,
    @Req() request: AuthRequest,
    @Query('force') rawForce?: string,
  ) {
    return this.scheduling.deleteOverride(
      id,
      overrideId,
      request.user.id,
      rawForce === 'true' || rawForce === '1',
    );
  }
}

const calendarQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** `?staffIds=1,2,3` → `number[]`；空串/非法值一律丢弃 */
function parseStaffIds(raw?: string): number[] | undefined {
  if (!raw) return undefined;
  const ids = raw
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  return ids.length ? ids : undefined;
}

/**
 * 排班日历（§4.3）：日期区间 × 美甲师的**实际生效班次矩阵**。
 *
 * 单独开一个 `biz/schedules` controller 而不是塞进 `biz/staffs/:id/*`：
 * 一是避开路由歧义（`calendar` 会被 `:id` 吃掉），二是语义上更贴「按日历看排班」。
 */
@ApiTags('排班')
@ApiBearerAuth('access-token')
@Controller('biz/schedules')
export class ScheduleCalendarController {
  constructor(private readonly scheduling: SchedulingService) {}

  @Get('calendar')
  @RequirePermissions('biz:schedule:list')
  @ApiOperation({
    summary: '排班日历矩阵（日期区间 × 美甲师，实际生效班次）',
  })
  @ApiQuery({
    name: 'from',
    required: true,
    description: '起始日 YYYY-MM-DD（含）',
  })
  @ApiQuery({
    name: 'to',
    required: true,
    description: '结束日 YYYY-MM-DD（含），与 from 最多相差 62 天',
  })
  @ApiQuery({
    name: 'staffIds',
    required: false,
    description: '美甲师ID，逗号分隔；不传 = 全部美甲师',
  })
  @ApiQuery({
    name: 'storeId',
    required: false,
    description:
      '门店ID：按该门店求值（专属优先、通用兜底）；不传 = 只看通用层',
  })
  @ApiResponse({ status: 200, description: '成功' })
  calendar(
    @Query('from') rawFrom?: string,
    @Query('to') rawTo?: string,
    @Query('staffIds') rawStaffIds?: string,
    @Query('storeId') rawStoreId?: string,
  ) {
    const { from, to } = calendarQuerySchema.parse({
      from: rawFrom,
      to: rawTo,
    });
    return this.scheduling.getCalendar({
      from,
      to,
      staffIds: parseStaffIds(rawStaffIds),
      storeId: parseStoreId(rawStoreId),
    });
  }
}
