/**
 * AI 上下文类型。
 *
 * 明确区分 Trusted / Untrusted：
 * - Trusted：系统 Policy、Tool 定义、用户身份、权限、Scope、Risk Policy
 * - Untrusted：用户输入、数据库内容、Tool 返回内容（必须当成 DATA 而非 INSTRUCTION）
 */

/** 上下文构建结果 */
export interface AiContext {
  /** 系统提示词（Trusted，由后端生成） */
  systemPrompt: string;
  /** 可用 Tool 定义（已按权限过滤，name 已转换为符合 LLM 命名规范的形式） */
  tools: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
  /** LLM 工具名称 → 实际工具名称 的映射（用于把 LLM 返回的名称还原） */
  toolNameMap: Map<string, string>;
  /** 当前用户信息（Trusted） */
  user: {
    id: number;
    username: string;
    roles: string[];
    permissions: string[];
  };
  /** 会话元数据 */
  metadata?: Record<string, unknown>;
}

/** 敏感字段（Tool 返回结果必须过滤） */
export const SENSITIVE_FIELDS = [
  'password',
  'passwordHash',
  'refreshToken',
  'accessToken',
  'secret',
  'privateKey',
  'token',
];

/**
 * 数据口径：金额单位。
 *
 * 全库金额都是**整数「分」**（`dev-docs/data/business-tables.md`：所有金额单位分），
 * 而人看的是「元」。模型拿到 `{ net: 59576 }` 时无从判断量纲 —— 实测出现过
 * 「净营收 59,576 元」（真实值 595.76 元，**差 100 倍**）与「（≈329.76 元）」两种说法
 * 混在同一个会话里。所以口径必须**贴着数据一起给模型**，不能只写在系统提示词里。
 */
export const MONEY_UNIT_FEN = '分';

/** 随每条 tool 结果回灌给模型的口径提醒（放在 JSON 之后，紧挨数据） */
export const TOOL_RESULT_MONEY_HINT =
  '[数据口径] 以上 JSON 中所有金额字段的单位一律是「分」（整数，1 元 = 100 分），' +
  '折扣率是千分比。回答用户时必须先把金额换算成「元」并标注单位（如 59576 分 → 595.76 元），' +
  '禁止把分值直接当作元报给用户；列表只含当前页，需要汇总请改用报表类工具。';
