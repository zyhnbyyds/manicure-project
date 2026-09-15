import { Injectable } from '@nestjs/common';
import { ApprovalPolicy, RiskLevel } from '../../ai.types';
import type { AiTool } from '../tool.interface';
import { READ_ONLY_LIMITS, clampPage } from '../biz-common/biz-tool.util';
import { MemberAccountsService } from '../../../modules/biz/membership/member-accounts/member-accounts.service';
import { MemberCardsService } from '../../../modules/biz/membership/member-cards/member-cards.service';
import { MemberLevelsService } from '../../../modules/biz/membership/member-levels/member-levels.service';

/**
 * 会员域的 AI 只读工具：会员账户、账务流水、次卡、等级。
 *
 * 会员体系的一切都与钱有关（余额、积分、次卡次数），所以这里**只读**。
 * 充值、扣减、次卡核销、积分兑换一律走后台页面 —— AI 不允许碰任何余额。
 *
 * 入参类型直接取 service 方法签名的参数类型（`Parameters<...>`），
 * 这样 filter 字段增删时工具会自动跟着变，不会悄悄落后于业务。
 */

type MemberListFilter = Parameters<MemberAccountsService['listMembers']>[2];
type TransactionListFilter = Parameters<
  MemberAccountsService['listTransactions']
>[3];
type MemberCardListFilter = Parameters<MemberCardsService['list']>[2];
type MemberLevelListFilter = Parameters<MemberLevelsService['list']>[2];

/** member.list —— 会员账户列表（余额 / 积分 / 等级） */
@Injectable()
export class MemberListTool implements AiTool<
  Partial<MemberListFilter> & { page?: number; pageSize?: number }
> {
  name = 'member.list';
  description =
    '查会员账户列表（分页）：顾客 + 会员等级 + 等级折扣率 + 储值余额 + 积分。' +
    '顾客即会员，所以这个列表和顾客档案是同一批人，但**多带了余额与积分**。' +
    'hasBalance=true 只看有储值余额的。要流水明细用 member.transactions。';
  permission = 'biz:member:list';
  riskLevel = RiskLevel.L0;
  approvalPolicy = ApprovalPolicy.NONE;
  inputSchema = {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '姓名 / 手机号 模糊匹配' },
      levelId: { type: 'number', description: '会员等级 id' },
      hasBalance: { type: 'boolean', description: 'true 只看有储值余额的会员' },
      page: { type: 'number', description: '页码，默认 1' },
      pageSize: { type: 'number', description: '每页条数，默认 20，最多 100' },
    },
  };
  limits = READ_ONLY_LIMITS;

  constructor(private readonly memberAccounts: MemberAccountsService) {}

  async execute(
    input: Partial<MemberListFilter> & { page?: number; pageSize?: number },
  ) {
    const { page, pageSize } = clampPage(input.page, input.pageSize);
    return this.memberAccounts.listMembers(page, pageSize, {
      keyword: input.keyword,
      levelId: input.levelId,
      hasBalance: input.hasBalance,
    });
  }
}

/** member.transactions —— 会员账务流水 */
@Injectable()
export class MemberTransactionsTool implements AiTool<
  Partial<TransactionListFilter> & {
    customerId: number;
    page?: number;
    pageSize?: number;
  }
> {
  name = 'member.transactions';
  description =
    '查某位顾客的**会员账务流水**（余额与积分的每一笔增减）：充值、消费扣减、退款回充、积分累计与抵扣、' +
    '次卡购买等。回答「这 200 元余额怎么没了」「积分什么时候扣的」必须用它。' +
    '注意流水是**只追加**的，退款不会改老记录，而是新增一条反向流水 —— 所以别把两条抵消看成重复。';
  permission = 'biz:member:list';
  riskLevel = RiskLevel.L0;
  approvalPolicy = ApprovalPolicy.NONE;
  inputSchema = {
    type: 'object',
    properties: {
      customerId: { type: 'number', description: '顾客 id（必填）' },
      type: { type: 'string', description: '流水类型，不传则全部' },
      dateFrom: { type: 'string', description: '起始日 YYYY-MM-DD（含）' },
      dateTo: { type: 'string', description: '结束日 YYYY-MM-DD（含）' },
      page: { type: 'number', description: '页码，默认 1' },
      pageSize: { type: 'number', description: '每页条数，默认 20，最多 100' },
    },
    required: ['customerId'],
  };
  limits = READ_ONLY_LIMITS;

  constructor(private readonly memberAccounts: MemberAccountsService) {}

  async execute(
    input: Partial<TransactionListFilter> & {
      customerId: number;
      page?: number;
      pageSize?: number;
    },
  ) {
    const { page, pageSize } = clampPage(input.page, input.pageSize);
    return this.memberAccounts.listTransactions(
      Number(input.customerId),
      page,
      pageSize,
      {
        type: input.type,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
      },
    );
  }
}

/** member.card.list —— 会员次卡 */
@Injectable()
export class MemberCardListTool implements AiTool<
  Partial<MemberCardListFilter> & { page?: number; pageSize?: number }
> {
  name = 'member.card.list';
  description =
    '查会员次卡列表（分页）：所属顾客、卡种、剩余次数、有效期、状态（active 使用中 / used_up 用完 / ' +
    'expired 已过期 / refunded 已退）。回答「这位顾客还有几次没用」用它。' +
    '传 customerId 可只看某位顾客的卡。**次卡核销记录不在这里** —— 那是账务流水，见 member.transactions。';
  permission = 'biz:card:list';
  riskLevel = RiskLevel.L0;
  approvalPolicy = ApprovalPolicy.NONE;
  inputSchema = {
    type: 'object',
    properties: {
      customerId: { type: 'number', description: '顾客 id' },
      cardTypeId: { type: 'number', description: '卡种 id' },
      status: {
        type: 'string',
        enum: ['active', 'used_up', 'expired', 'refunded'],
        description: '次卡状态',
      },
      keyword: {
        type: 'string',
        description: '顾客姓名 / 手机号 / 卡号 模糊匹配',
      },
      page: { type: 'number', description: '页码，默认 1' },
      pageSize: { type: 'number', description: '每页条数，默认 20，最多 100' },
    },
  };
  limits = READ_ONLY_LIMITS;

  constructor(private readonly memberCards: MemberCardsService) {}

  async execute(
    input: Partial<MemberCardListFilter> & { page?: number; pageSize?: number },
  ) {
    const { page, pageSize } = clampPage(input.page, input.pageSize);
    return this.memberCards.list(page, pageSize, {
      customerId: input.customerId,
      cardTypeId: input.cardTypeId,
      status: input.status,
      keyword: input.keyword,
    });
  }
}

/** member.level.list —— 会员等级 */
@Injectable()
export class MemberLevelListTool implements AiTool<
  Partial<MemberLevelListFilter> & { page?: number; pageSize?: number }
> {
  name = 'member.level.list';
  description =
    '查会员等级列表：等级名、门槛（累计消费 / 次数）、折扣率。' +
    '折扣率存的是**千分比**（如 880 = 8.8 折），算价时用「原价 × 折扣率 ÷ 1000」。' +
    '回答「她为什么能打 8.8 折」就用它对齐等级规则。';
  permission = 'biz:memberlevel:list';
  riskLevel = RiskLevel.L0;
  approvalPolicy = ApprovalPolicy.NONE;
  inputSchema = {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['active', 'disabled'],
        description: '启用状态',
      },
      page: { type: 'number', description: '页码，默认 1' },
      pageSize: { type: 'number', description: '每页条数，默认 20，最多 100' },
    },
  };
  limits = READ_ONLY_LIMITS;

  constructor(private readonly memberLevels: MemberLevelsService) {}

  async execute(
    input: Partial<MemberLevelListFilter> & {
      page?: number;
      pageSize?: number;
    },
  ) {
    const { page, pageSize } = clampPage(input.page, input.pageSize);
    return this.memberLevels.list(page, pageSize, { status: input.status });
  }
}
