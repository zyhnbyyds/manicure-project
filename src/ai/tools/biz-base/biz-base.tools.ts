import { Injectable } from '@nestjs/common';
import { ApprovalPolicy, RiskLevel } from '../../ai.types';
import type { AiTool, ToolContext } from '../tool.interface';
import {
  READ_ONLY_LIMITS,
  actorOf,
  clampPage,
  defined,
} from '../biz-common/biz-tool.util';
import { CustomersService } from '../../../modules/biz/base-data/customers/customers.service';
import { ServiceItemsService } from '../../../modules/biz/base-data/service-items/service-items.service';
import { StaffsService } from '../../../modules/biz/base-data/staffs/staffs.service';
import { StoresService } from '../../../modules/biz/base-data/stores/stores.service';

/**
 * 基础数据域的 AI 只读工具：美甲师、服务项目、门店、顾客档案。
 *
 * 这些是「回答任何业务问题前先要知道的东西」—— 模型得先查清 id 与名字的对应关系，
 * 才不至于把 staffId=3 说成「小美」而其实是「小雅」。
 */

/** staff.list —— 美甲师列表 */
@Injectable()
export class StaffListTool implements AiTool<{
  keyword?: string;
  status?: 'active' | 'disabled';
  storeId?: number;
  page?: number;
  pageSize?: number;
}> {
  name = 'staff.list';
  description =
    '查美甲师列表（分页）。返回每位美甲师的档案与所属门店 stores。' +
    '回答「有哪几位美甲师」「小美的 id 是多少」先用它 —— 其它工具基本都要 staffId，' +
    '**不要凭名字猜 id**。status=active 只看在职。';
  permission = 'biz:staff:list';
  riskLevel = RiskLevel.L0;
  approvalPolicy = ApprovalPolicy.NONE;
  inputSchema = {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '姓名 / 手机号 模糊匹配' },
      status: {
        type: 'string',
        enum: ['active', 'disabled'],
        description: '在职状态',
      },
      storeId: { type: 'number', description: '只看服务于该门店的美甲师' },
      page: { type: 'number', description: '页码，默认 1' },
      pageSize: { type: 'number', description: '每页条数，默认 20，最多 100' },
    },
  };
  limits = READ_ONLY_LIMITS;

  constructor(private readonly staffs: StaffsService) {}

  async execute(
    input: {
      keyword?: string;
      status?: 'active' | 'disabled';
      storeId?: number;
      page?: number;
      pageSize?: number;
    },
    context: ToolContext,
  ) {
    const { page, pageSize } = clampPage(input.page, input.pageSize);
    return this.staffs.list(
      page,
      pageSize,
      defined({
        keyword: input.keyword,
        status: input.status,
        storeId: input.storeId,
      }),
      actorOf(context),
    );
  }
}

/** service-item.list —— 服务项目列表 */
@Injectable()
export class ServiceItemListTool implements AiTool<{
  keyword?: string;
  status?: 'active' | 'disabled';
  page?: number;
  pageSize?: number;
}> {
  name = 'service-item.list';
  description =
    '查服务项目（美甲种类）列表：名称、时长（决定占用几个时段）、价格、是否可做。' +
    '回答「做个法式多少钱 / 要多久」、或需要 serviceItemIds 去算可约时段时用它。' +
    'status=active 只看启用的项目。';
  permission = 'biz:serviceitem:list';
  riskLevel = RiskLevel.L0;
  approvalPolicy = ApprovalPolicy.NONE;
  inputSchema = {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '项目名模糊匹配' },
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

  constructor(private readonly serviceItems: ServiceItemsService) {}

  async execute(input: {
    keyword?: string;
    status?: 'active' | 'disabled';
    page?: number;
    pageSize?: number;
  }) {
    const { page, pageSize } = clampPage(input.page, input.pageSize);
    return this.serviceItems.list(
      page,
      pageSize,
      defined({ keyword: input.keyword, status: input.status }),
    );
  }
}

/** store.list —— 门店列表 */
@Injectable()
export class StoreListTool implements AiTool<Record<string, never>> {
  name = 'store.list';
  description =
    '查全部门店（启用中的）列表：id、名称、地址、电话。' +
    '多店场景下几乎所有查询都要先确定 storeId —— 先调它，再把 storeId 传给其它工具。';
  permission = 'system:store:list';
  riskLevel = RiskLevel.L0;
  approvalPolicy = ApprovalPolicy.NONE;
  inputSchema = { type: 'object', properties: {} };
  limits = READ_ONLY_LIMITS;

  constructor(private readonly stores: StoresService) {}

  async execute() {
    const items = await this.stores.listActive();
    return { items, page: 1, pageSize: items.length };
  }
}

/** customer.list —— 顾客档案列表 */
@Injectable()
export class CustomerListTool implements AiTool<{
  keyword?: string;
  levelId?: number;
  hasBalance?: boolean;
  status?: 'active' | 'deleted';
  page?: number;
  pageSize?: number;
}> {
  name = 'customer.list';
  description =
    '查顾客档案（分页）。支持按姓名 / 手机号关键字、会员等级、是否有储值余额筛选。' +
    '**手机号在系统内唯一**，用它定位顾客最准。status 默认只看 active（未删除）。';
  permission = 'biz:customer:list';
  riskLevel = RiskLevel.L0;
  approvalPolicy = ApprovalPolicy.NONE;
  inputSchema = {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '姓名 / 手机号 模糊匹配' },
      levelId: { type: 'number', description: '会员等级 id' },
      hasBalance: { type: 'boolean', description: 'true 只看有储值余额的' },
      status: {
        type: 'string',
        enum: ['active', 'deleted'],
        description: '档案状态',
      },
      page: { type: 'number', description: '页码，默认 1' },
      pageSize: { type: 'number', description: '每页条数，默认 20，最多 100' },
    },
  };
  limits = READ_ONLY_LIMITS;

  constructor(private readonly customers: CustomersService) {}

  async execute(input: {
    keyword?: string;
    levelId?: number;
    hasBalance?: boolean;
    status?: 'active' | 'deleted';
    page?: number;
    pageSize?: number;
  }) {
    const { page, pageSize } = clampPage(input.page, input.pageSize);
    return this.customers.list(
      page,
      pageSize,
      defined({
        keyword: input.keyword,
        levelId: input.levelId,
        hasBalance: input.hasBalance,
        status: input.status,
      }),
    );
  }
}

/** customer.get —— 顾客档案详情 */
@Injectable()
export class CustomerGetTool implements AiTool<{ id: number }> {
  name = 'customer.get';
  description =
    '按 id 查单个顾客的档案详情（联系方式、会员等级、储值余额与积分、累计消费等）。' +
    '注意这里给的是**档案面**：要账务流水用 member.transactions，要次卡用 member.card.list。';
  permission = 'biz:customer:list';
  riskLevel = RiskLevel.L0;
  approvalPolicy = ApprovalPolicy.NONE;
  inputSchema = {
    type: 'object',
    properties: { id: { type: 'number', description: '顾客 id' } },
    required: ['id'],
  };
  limits = READ_ONLY_LIMITS;

  constructor(private readonly customers: CustomersService) {}

  async execute(input: { id: number }) {
    return this.customers.findOne(Number(input.id));
  }
}
