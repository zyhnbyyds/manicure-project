import { Injectable } from '@nestjs/common';
import { ApprovalPolicy, RiskLevel } from '../../ai.types';
import type { AiTool } from '../tool.interface';
import { READ_ONLY_LIMITS } from '../biz-common/biz-tool.util';
import { SchedulingService } from '../../../modules/biz/scheduling/scheduling.service';

/**
 * 排班域的 AI 只读工具。
 *
 * 排班的写操作（整体替换周模板、增删日期例外）**风险极高**：一次保存会让既有预约越界，
 * 后台都要弹冲突清单让人确认。AI 只负责**查**，改排班请回排班管理页。
 */

/** schedule.weekly —— 某美甲师的周模板 */
@Injectable()
export class ScheduleWeeklyTool implements AiTool<{
  staffId: number;
  storeId?: number;
}> {
  name = 'schedule.weekly';
  description =
    '查某位美甲师的**周模板**（周一~周日各有哪些班次段）。传 storeId 会返回该门店实际生效的模板' +
    '（门店专属优先、通用兜底），并用 source 说明这次用的是哪一层：store = 本店专属，shared = 通用模板。' +
    '不传 storeId 只看通用层。注意这里给的是**模板**，不是某一天的真实班次 —— 要真实生效结果用 schedule.calendar。';
  permission = 'biz:schedule:list';
  riskLevel = RiskLevel.L0;
  approvalPolicy = ApprovalPolicy.NONE;
  inputSchema = {
    type: 'object',
    properties: {
      staffId: { type: 'number', description: '美甲师 id' },
      storeId: { type: 'number', description: '门店 id；不传则只看通用模板' },
    },
    required: ['staffId'],
  };
  limits = READ_ONLY_LIMITS;

  constructor(private readonly scheduling: SchedulingService) {}

  async execute(input: { staffId: number; storeId?: number }) {
    return this.scheduling.getWeeklyShifts(
      Number(input.staffId),
      input.storeId ?? null,
    );
  }
}

/** schedule.overrides —— 日期例外（请假 / 自定义时段） */
@Injectable()
export class ScheduleOverridesTool implements AiTool<{
  staffId: number;
  from?: string;
  to?: string;
  storeId?: number;
}> {
  name = 'schedule.overrides';
  description =
    '查某位美甲师的**日期例外**列表：type=off 表示请假（那天的模板班次全部作废），' +
    'type=custom 表示当天改成 startTime~endTime。可按日期区间 from/to（YYYY-MM-DD）过滤。' +
    '想知道某人某天为什么不上班 / 为什么改了时间，就查这个。';
  permission = 'biz:schedule:list';
  riskLevel = RiskLevel.L0;
  approvalPolicy = ApprovalPolicy.NONE;
  inputSchema = {
    type: 'object',
    properties: {
      staffId: { type: 'number', description: '美甲师 id' },
      from: { type: 'string', description: '起始日 YYYY-MM-DD（含）' },
      to: { type: 'string', description: '结束日 YYYY-MM-DD（含）' },
      storeId: { type: 'number', description: '门店 id' },
    },
    required: ['staffId'],
  };
  limits = READ_ONLY_LIMITS;

  constructor(private readonly scheduling: SchedulingService) {}

  async execute(input: {
    staffId: number;
    from?: string;
    to?: string;
    storeId?: number;
  }) {
    return this.scheduling.listOverrides(Number(input.staffId), {
      from: input.from,
      to: input.to,
      storeId: input.storeId,
    });
  }
}

/** schedule.calendar —— 排班日历矩阵（日期 × 美甲师的实际生效班次） */
@Injectable()
export class ScheduleCalendarTool implements AiTool<{
  from: string;
  to: string;
  staffIds?: number[];
  storeId?: number;
}> {
  name = 'schedule.calendar';
  description =
    '一次取出「日期区间 × 全部美甲师」的**实际生效班次**矩阵（已把周模板与日期例外合并求值），' +
    '后台排班页的日历视图用的就是它。返回 cells（staffId + date + off + source + segments）' +
    '与 staffs（行标签）。问「这周谁上班」「某天有几个人在店」用它最省 —— 别去逐个美甲师调 schedule.weekly。' +
    '区间最长 62 天，美甲师最多 50 人。';
  permission = 'biz:schedule:list';
  riskLevel = RiskLevel.L0;
  approvalPolicy = ApprovalPolicy.NONE;
  inputSchema = {
    type: 'object',
    properties: {
      from: { type: 'string', description: '起始日 YYYY-MM-DD（含）' },
      to: { type: 'string', description: '结束日 YYYY-MM-DD（含）' },
      staffIds: {
        type: 'array',
        items: { type: 'number' },
        description: '只看指定美甲师；不传 = 全部',
      },
      storeId: { type: 'number', description: '门店 id；不传则只看通用层' },
    },
    required: ['from', 'to'],
  };
  limits = READ_ONLY_LIMITS;

  constructor(private readonly scheduling: SchedulingService) {}

  async execute(input: {
    from: string;
    to: string;
    staffIds?: number[];
    storeId?: number;
  }) {
    return this.scheduling.getCalendar({
      from: input.from,
      to: input.to,
      staffIds: input.staffIds,
      storeId: input.storeId,
    });
  }
}
