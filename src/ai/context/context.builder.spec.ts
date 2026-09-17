import { describe, expect, it } from 'bun:test';
import { ApprovalPolicy, RiskLevel } from '../ai.types';
import type { AiTool } from '../tools/tool.interface';
import type { ToolRegistry } from '../tools/tool.registry';
import { ContextBuilder } from './context.builder';
import { MONEY_UNIT_FEN } from './context.types';

/**
 * 系统提示词的「数据口径」断言。
 *
 * 背景：全库金额是整数「分」，模型只看 `{ net: 59576 }` 无法判断量纲，
 * 实测出现过把 595.76 元报成「59,576 元」（差 100 倍）的回答。口径段一旦被删掉，
 * 这类错误会静默回归 —— 所以用测试把它钉住。
 */

const fakeTool = (name: string): AiTool => ({
  name,
  description: `工具 ${name}`,
  permission: 'biz:report:view',
  riskLevel: RiskLevel.L0,
  approvalPolicy: ApprovalPolicy.NONE,
  inputSchema: { type: 'object' },
  execute: async () => ({}),
});

const builderWith = (tools: AiTool[]): ContextBuilder =>
  new ContextBuilder({
    getAvailableTools: () => tools,
  } as unknown as ToolRegistry);

const ACTOR = {
  id: 1,
  username: 'admin',
  roles: ['admin'],
  permissions: ['*:*:*'],
};

describe('ContextBuilder', () => {
  it('系统提示词声明金额单位为「分」且必须换算成元', () => {
    const context = builderWith([fakeTool('report.revenue')]).build(ACTOR);

    expect(context.systemPrompt).toContain(`一律是「${MONEY_UNIT_FEN}」`);
    expect(context.systemPrompt).toContain('÷100');
    // 必须带上反例，否则模型仍可能把分值当元
    expect(context.systemPrompt).toContain('59576 分 = 595.76 元');
    expect(context.systemPrompt).toContain('禁止');
    // 折扣率千分比的既有口径不能被挤掉
    expect(context.systemPrompt).toContain('千分比');
  });

  it('工具名点号转下划线，并保留反向映射', () => {
    const context = builderWith([
      fakeTool('report.revenue'),
      fakeTool('member.list'),
    ]).build(ACTOR);

    expect(context.tools.map((t) => t.name)).toEqual([
      'report_revenue',
      'member_list',
    ]);
    expect(context.toolNameMap.get('report_revenue')).toBe('report.revenue');
    expect(context.toolNameMap.get('member_list')).toBe('member.list');
  });
});
