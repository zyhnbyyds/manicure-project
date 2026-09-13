import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { menus, roleMenus, roles } from '../schema/index';

/**
 * 初始化菜单数据（与 web 前端页面一一对应）
 * 运行：bun run db:seed:menus
 *
 * 幂等策略：按 `name` 查已有行 → 有则改（改前逐字段比对，值没变不发 UPDATE）、无则插；
 * 重复执行不产生重复行；角色授权只补缺失项，不清掉运营已分配的其它菜单。
 */
type MenuSeed = {
  parentKey?: string | undefined; // 父菜单的 name，用于建立父子关系
  name: string;
  title: string;
  type: 'M' | 'C' | 'F';
  path?: string | undefined;
  component?: string | undefined;
  permission?: string | undefined;
  icon?: string | undefined;
  sort: number;
};

/**
 * 权限点声明：一个页面（资源）下挂多个按钮权限。
 * `resource` 是权限点前缀（如 `biz:booking`），`actions` 是动作段（如 `list` / `arrive`）。
 * 各段全小写、不用驼峰（§8.1）。
 */
type BizPermissionSeed = {
  resource: string;
  actions: string[];
};

/** 一个业务页面：目录下 25 个 `C` 页面中的一条（含 §12.5 追加的「工作台授权」） */
type BizPageSeed = {
  /** 菜单唯一 name（子菜单与按钮的 parentKey 都指向它） */
  name: string;
  /** 页面中文名（§10.1 表格「菜单名」列） */
  title: string;
  /** 路由 path（§10.1 表格「路径」列，必须完全一致） */
  path: string;
  /** 组件路径（§10.1 表格「组件」列，必须完全一致） */
  component: string;
  icon: string;
  /** 页面自身的 list 权限点；留空则该页面对「有菜单授权」的账号直接可见（按钮权限仍单独校验） */
  permission?: string;
  /** 该页面下挂的按钮权限（除 list 外的动作） */
  permissions: BizPermissionSeed[];
};

/**
 * 「美甲预约」下的 25 个页面，顺序即菜单 sort。
 * path / component **必须**与 spec §10.1 表格逐字一致。
 */
const BIZ_PAGES: BizPageSeed[] = [
  {
    name: 'biz_service_items',
    title: '服务项目',
    path: '/biz/service-items',
    component: 'biz/service-items/index',
    icon: 'files',
    permission: 'biz:serviceitem:list',
    permissions: [
      { resource: 'biz:serviceitem', actions: ['create', 'update', 'delete'] },
    ],
  },
  {
    name: 'biz_staffs',
    title: '美甲师',
    path: '/biz/staffs',
    component: 'biz/staffs/index',
    icon: 'user',
    permission: 'biz:staff:list',
    permissions: [
      // items：维护「某美甲师可做哪些项目」（§22，不单独建页）
      {
        resource: 'biz:staff',
        actions: ['create', 'update', 'delete', 'items'],
      },
    ],
  },
  {
    // 施工单 §12.5：美甲师工作台开通申请由店长在后台确认（H19 决策：放后台，复用 RBAC）
    name: 'biz_app_staff_grants',
    title: '工作台授权',
    path: '/biz/app-staff-grants',
    component: 'biz/app-staff-grants/index',
    icon: 'user',
    // 一个权限点管整个页面（列表 + 通过 + 驳回）：这三件事只能同一个人做，
    // 拆成三个点只会让授权更容易配漏。
    permission: 'biz:staff:grant',
    permissions: [],
  },
  {
    name: 'biz_schedules',
    title: '排班管理',
    path: '/biz/schedules',
    component: 'biz/schedules/index',
    icon: 'clock',
    permission: 'biz:schedule:list',
    permissions: [{ resource: 'biz:schedule', actions: ['update'] }],
  },
  {
    name: 'biz_customers',
    title: '顾客档案',
    path: '/biz/customers',
    component: 'biz/customers/index',
    icon: 'user',
    permission: 'biz:customer:list',
    permissions: [
      { resource: 'biz:customer', actions: ['create', 'update', 'delete'] },
    ],
  },
  {
    name: 'biz_bookings',
    title: '预约管理',
    path: '/biz/bookings',
    component: 'biz/bookings/index',
    icon: 'activity',
    permission: 'biz:booking:list',
    permissions: [
      {
        resource: 'biz:booking',
        actions: [
          'create',
          'update',
          'cancel',
          'arrive',
          'complete',
          'noshow',
          'delete',
          'manageall',
          // 改价：独立权限点，必须填原因（§5.7）
          'adjust',
        ],
      },
    ],
  },
  {
    name: 'biz_member_levels',
    title: '会员等级',
    path: '/biz/member-levels',
    component: 'biz/member-levels/index',
    icon: 'role',
    permission: 'biz:memberlevel:list',
    permissions: [
      { resource: 'biz:memberlevel', actions: ['create', 'update', 'delete'] },
    ],
  },
  {
    name: 'biz_recharge_plans',
    title: '充值方案',
    path: '/biz/recharge-plans',
    component: 'biz/recharge-plans/index',
    icon: 'config',
    permission: 'biz:rechargeplan:list',
    permissions: [
      { resource: 'biz:rechargeplan', actions: ['create', 'update', 'delete'] },
    ],
  },
  {
    name: 'biz_card_types',
    title: '次卡卡种',
    path: '/biz/card-types',
    component: 'biz/card-types/index',
    icon: 'dict',
    permission: 'biz:cardtype:list',
    permissions: [
      { resource: 'biz:cardtype', actions: ['create', 'update', 'delete'] },
    ],
  },
  {
    name: 'biz_members',
    title: '会员管理',
    path: '/biz/members',
    component: 'biz/members/index',
    icon: 'online',
    permission: 'biz:member:list',
    permissions: [
      // 充值 / 冲正退款默认只给店长（§8.1 钱的权限收窄）
      {
        resource: 'biz:member',
        // coupon = 给顾客发券（运营动作，复用券模板）
        actions: [
          'update',
          'adjust',
          'recount',
          'recharge',
          'refund',
          'coupon',
        ],
      },
      // 发卡 / 核销也从会员详情发起
      { resource: 'biz:card', actions: ['issue', 'use'] },
    ],
  },
  {
    name: 'biz_member_cards',
    title: '会员次卡',
    path: '/biz/member-cards',
    component: 'biz/member-cards/index',
    icon: 'generator',
    permission: 'biz:card:list',
    permissions: [{ resource: 'biz:card', actions: ['revoke', 'refund'] }],
  },
  {
    name: 'biz_cashier',
    title: '收银台',
    path: '/biz/cashier',
    component: 'biz/cashier/index',
    icon: 'gauge',
    // 页面级 permission 留空：收银台的资金动作由下面三个按钮权限点控制，
    // 且 `sys_menu.permission` 有唯一索引，`biz:payment:list` 归「支付流水」页面所有。
    permissions: [
      { resource: 'biz:payment', actions: ['create', 'close'] },
      // 前台可申请退款，审批只给店长（申请/审批分离）
      { resource: 'biz:refund', actions: ['apply'] },
      { resource: 'biz:receivable', actions: ['settle'] },
    ],
  },
  {
    name: 'biz_payments',
    title: '支付流水',
    path: '/biz/payments',
    component: 'biz/payments/index',
    icon: 'code',
    permission: 'biz:payment:list',
    permissions: [{ resource: 'biz:payment', actions: ['reconcile'] }],
  },
  {
    name: 'biz_refunds',
    title: '退款审批',
    path: '/biz/refunds',
    component: 'biz/refunds/index',
    icon: 'operlog',
    permission: 'biz:refund:list',
    permissions: [{ resource: 'biz:refund', actions: ['approve'] }],
  },
  {
    name: 'biz_payment_diffs',
    title: '支付对账',
    path: '/biz/payment-diffs',
    component: 'biz/payment-diffs/index',
    icon: 'server',
    permission: 'biz:payment:reconcile',
    permissions: [{ resource: 'biz:payment', actions: ['reconcile'] }],
  },
  {
    name: 'biz_credit_accounts',
    title: '挂账主体',
    path: '/biz/credit-accounts',
    component: 'biz/credit-accounts/index',
    icon: 'dept',
    permission: 'biz:credit:list',
    permissions: [
      { resource: 'biz:credit', actions: ['create', 'update', 'delete'] },
    ],
  },
  {
    name: 'biz_receivables',
    title: '应收台账',
    path: '/biz/receivables',
    component: 'biz/receivables/index',
    icon: 'folder',
    permission: 'biz:receivable:list',
    permissions: [
      { resource: 'biz:receivable', actions: ['settle', 'cancel'] },
    ],
  },
  {
    name: 'biz_points_goods',
    title: '积分兑换品',
    path: '/biz/points-goods',
    component: 'biz/points-goods/index',
    icon: 'post',
    permission: 'biz:pointsgoods:list',
    permissions: [
      { resource: 'biz:pointsgoods', actions: ['create', 'update', 'delete'] },
      { resource: 'biz:points', actions: ['redeem', 'revert'] },
    ],
  },
  {
    name: 'biz_coupons',
    title: '优惠券模板',
    path: '/biz/coupons',
    component: 'biz/coupons/index',
    icon: 'coupon',
    permission: 'biz:coupon:list',
    permissions: [
      { resource: 'biz:coupon', actions: ['create', 'update', 'delete'] },
    ],
  },
  {
    name: 'biz_reviews',
    title: '评价管理',
    path: '/biz/reviews',
    component: 'biz/reviews/index',
    icon: 'menu',
    permission: 'biz:review:list',
    permissions: [
      {
        resource: 'biz:review',
        actions: ['create', 'reply', 'hide', 'delete'],
      },
    ],
  },
  {
    name: 'biz_reports',
    title: '报表中心',
    path: '/biz/reports',
    component: 'biz/reports/index',
    icon: 'dashboard',
    permission: 'biz:report:view',
    permissions: [{ resource: 'biz:report', actions: ['export'] }],
  },
  {
    name: 'biz_commission_rules',
    title: '提成规则',
    path: '/biz/commission-rules',
    component: 'biz/commission-rules/index',
    icon: 'key',
    // 提成规则页的动作权限是 `biz:commission:rule`（唯一索引下不能与下方按钮重复）
    permissions: [{ resource: 'biz:commission', actions: ['rule'] }],
  },
  {
    name: 'biz_commission_records',
    title: '提成结算',
    path: '/biz/commission-records',
    component: 'biz/commission-records/index',
    icon: 'profile',
    permission: 'biz:commission:list',
    permissions: [{ resource: 'biz:commission', actions: ['settle'] }],
  },
  {
    name: 'biz_recurrences',
    title: '周期预约',
    path: '/biz/recurrences',
    component: 'biz/recurrences/index',
    icon: 'loginlog',
    permission: 'biz:recurrence:list',
    permissions: [
      { resource: 'biz:recurrence', actions: ['create', 'update', 'delete'] },
    ],
  },
  {
    name: 'biz_notice_templates',
    title: '通知模板',
    path: '/biz/notice-templates',
    component: 'biz/notice-templates/index',
    icon: 'dict',
    permission: 'biz:notice:template',
    permissions: [{ resource: 'biz:notice', actions: ['template', 'send'] }],
  },
  {
    name: 'biz_notice_logs',
    title: '通知记录',
    path: '/biz/notice-logs',
    component: 'biz/notice-logs/index',
    icon: 'cache',
    permission: 'biz:notice:log',
    permissions: [],
  },
];

/** 把页面声明展开成「页面 + 按钮」的菜单 seed */
function buildBizMenus(): MenuSeed[] {
  const rows: MenuSeed[] = [
    {
      name: 'biz',
      title: '美甲预约',
      type: 'M',
      path: '/biz',
      icon: 'activity',
      sort: 8,
    },
  ];

  // `sys_menu.permission` 有唯一索引（NULL 可重复），同一个权限点只能落在**一行**菜单上。
  // 页面级 permission 先占位；若该权限点同时还要作为按钮挂在别的页面上（如
  // `biz:payment:reconcile` 既是「支付对账」的入口，又挂在「支付流水」下），
  // 页面行让位给按钮行——前端路由靠 role_menu 授权生成，不依赖页面 permission。
  const claimed = new Set<string>();

  BIZ_PAGES.forEach((page, pageIndex) => {
    let pagePermission: string | undefined = page.permission;
    if (pagePermission) {
      if (claimed.has(pagePermission)) pagePermission = undefined;
      else claimed.add(pagePermission);
    }

    rows.push({
      parentKey: 'biz',
      name: page.name,
      title: page.title,
      type: 'C',
      path: page.path,
      component: page.component,
      permission: pagePermission,
      icon: page.icon,
      sort: pageIndex + 1,
    });

    // 页面下的按钮权限：resource 去掉 `biz:` 前缀作为 name 段，保证全局唯一
    const buttons: { name: string; title: string; permission: string }[] = [];
    for (const group of page.permissions) {
      for (const action of group.actions) {
        const permission = `${group.resource}:${action}`;
        if (claimed.has(permission)) continue;
        claimed.add(permission);
        const key = permission.slice('biz:'.length).replace(/:/g, '_');
        buttons.push({
          name: `biz_${key}`,
          title: `${page.title}-${action}`,
          permission,
        });
      }
    }
    buttons.forEach((button, buttonIndex) => {
      rows.push({
        parentKey: page.name,
        name: button.name,
        title: button.title,
        type: 'F',
        permission: button.permission,
        sort: buttonIndex + 1,
      });
    });
  });

  return rows;
}

export const MENU_SEEDS: MenuSeed[] = [
  // ===== 首页 =====
  {
    name: 'dashboard',
    title: '首页',
    type: 'C',
    path: '/dashboard',
    component: 'dashboard/index',
    icon: 'home',
    sort: 1,
  },
  // ===== 系统管理（目录）=====
  {
    name: 'system',
    title: '系统管理',
    type: 'M',
    path: '/system',
    icon: 'setting',
    sort: 2,
  },
  {
    parentKey: 'system',
    name: 'system_users',
    title: '用户管理',
    type: 'C',
    path: '/system/users',
    component: 'system/users/index',
    permission: 'system:user:list',
    icon: 'user',
    sort: 1,
  },
  {
    parentKey: 'system',
    name: 'system_roles',
    title: '角色管理',
    type: 'C',
    path: '/system/roles',
    component: 'system/roles/index',
    permission: 'system:role:list',
    icon: 'role',
    sort: 2,
  },
  {
    parentKey: 'system',
    name: 'system_menus',
    title: '菜单管理',
    type: 'C',
    path: '/system/menus',
    component: 'system/menus/index',
    permission: 'system:menu:list',
    icon: 'menu',
    sort: 3,
  },
  {
    parentKey: 'system',
    name: 'system_depts',
    title: '部门管理',
    type: 'C',
    path: '/system/depts',
    component: 'system/depts/index',
    permission: 'system:dept:list',
    icon: 'dept',
    sort: 4,
  },
  {
    parentKey: 'system',
    name: 'system_posts',
    title: '岗位管理',
    type: 'C',
    path: '/system/posts',
    component: 'system/posts/index',
    permission: 'system:post:list',
    icon: 'post',
    sort: 5,
  },
  {
    parentKey: 'system',
    name: 'system_dicts',
    title: '字典管理',
    type: 'C',
    path: '/system/dicts',
    component: 'system/dicts/index',
    permission: 'system:dict:list',
    icon: 'dict',
    sort: 6,
  },
  {
    parentKey: 'system',
    name: 'system_configs',
    title: '参数配置',
    type: 'C',
    path: '/system/configs',
    component: 'system/configs/index',
    permission: 'system:config:list',
    icon: 'config',
    sort: 7,
  },
  // ===== 系统监控（目录）=====
  {
    name: 'monitor',
    title: '系统监控',
    type: 'M',
    path: '/monitor',
    icon: 'monitor',
    sort: 3,
  },
  {
    parentKey: 'monitor',
    name: 'monitor_login_logs',
    title: '登录日志',
    type: 'C',
    path: '/monitor/login-logs',
    component: 'monitor/login-logs/index',
    permission: 'monitor:loginlog:list',
    icon: 'loginlog',
    sort: 1,
  },
  {
    parentKey: 'monitor',
    name: 'monitor_operation_logs',
    title: '操作日志',
    type: 'C',
    path: '/monitor/operation-logs',
    component: 'monitor/operation-logs/index',
    permission: 'monitor:operlog:list',
    icon: 'operlog',
    sort: 2,
  },
  {
    parentKey: 'monitor',
    name: 'monitor_online',
    title: '在线用户',
    type: 'C',
    path: '/monitor/online',
    component: 'monitor/online/index',
    permission: 'monitor:online:list',
    icon: 'online',
    sort: 3,
  },
  {
    parentKey: 'monitor',
    name: 'monitor_cache',
    title: '缓存监控',
    type: 'C',
    path: '/monitor/cache',
    component: 'monitor/cache/index',
    permission: 'monitor:cache:list',
    icon: 'cache',
    sort: 4,
  },
  // ===== 定时任务 =====
  {
    name: 'jobs',
    title: '定时任务',
    type: 'C',
    path: '/jobs',
    component: 'jobs/index',
    permission: 'system:job:list',
    icon: 'clock',
    sort: 4,
  },
  // ===== 文件管理 =====
  {
    name: 'files',
    title: '文件管理',
    type: 'C',
    path: '/files',
    component: 'files/index',
    permission: 'system:file:list',
    icon: 'file',
    sort: 5,
  },
  // ===== 代码生成器 =====
  {
    name: 'generator',
    title: '代码生成器',
    type: 'C',
    path: '/generator',
    component: 'generator/index',
    permission: 'system:generator:list',
    icon: 'code',
    sort: 6,
  },
  // ===== AI 操作 =====
  {
    name: 'ai',
    title: 'AI 操作',
    type: 'C',
    path: '/ai',
    component: 'ai/index',
    permission: 'ai:chat',
    icon: 'bot',
    sort: 7,
  },
  // ===== 美甲预约（目录 + 25 个页面 + 按钮权限）=====
  ...buildBizMenus(),
];

/** 单个菜单 seed 期望落库的所有字段（用于「值没变就不发 UPDATE」的比对） */
function desiredValues(seed: MenuSeed, parentId: number) {
  return {
    parentId,
    title: seed.title,
    type: seed.type,
    path: seed.path ?? null,
    component: seed.component ?? null,
    permission: seed.permission ?? null,
    icon: seed.icon ?? null,
    sort: seed.sort,
    visible: true,
    cacheable: false,
    external: false,
    status: 'active' as const,
    deletedAt: null,
  };
}

type Db = ReturnType<typeof drizzle>;
type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];
type DbLike = Db | DbTx;

/** 幂等写入菜单树，返回 name → menuId 映射 */
async function upsertMenus(db: DbLike): Promise<Map<string, number>> {
  const allRows = await db.select().from(menus);
  const byName = new Map(allRows.map((row) => [row.name, row]));

  const idMap = new Map<string, number>(
    allRows.map((row) => [row.name, row.id]),
  );
  let inserted = 0;
  let updated = 0;

  for (const seed of MENU_SEEDS) {
    const parentId = seed.parentKey ? (idMap.get(seed.parentKey) ?? 0) : 0;
    const wanted = desiredValues(seed, parentId);
    const current = byName.get(seed.name);

    if (!current) {
      const result = await db.insert(menus).values({
        ...wanted,
        name: seed.name,
      });
      idMap.set(seed.name, Number(result[0].insertId));
      inserted += 1;
      continue;
    }

    idMap.set(seed.name, current.id);
    const changed =
      current.parentId !== wanted.parentId ||
      current.title !== wanted.title ||
      current.type !== wanted.type ||
      current.path !== wanted.path ||
      current.component !== wanted.component ||
      current.permission !== wanted.permission ||
      current.icon !== wanted.icon ||
      current.sort !== wanted.sort ||
      current.visible !== wanted.visible ||
      current.cacheable !== wanted.cacheable ||
      current.external !== wanted.external ||
      current.status !== wanted.status ||
      current.deletedAt !== wanted.deletedAt;

    if (changed) {
      await db.update(menus).set(wanted).where(eq(menus.id, current.id));
      byName.set(seed.name, { ...current, ...wanted });
      updated += 1;
    }
  }

  console.log(`[seed:menus] menus inserted=${inserted} updated=${updated}`);
  return idMap;
}

/* ------------------------------------------------------------------ *
 * §15.9「角色建议」的落地：默认角色 + 菜单授权
 *
 * ## 为什么必须建这几个角色
 *
 * 在此之前只有 `admin`（靠 `*:*:*` 通配）与 `user`（零授权）两个角色，
 * **§15.9 明确列出的「店长 / 前台 / 美甲师」一个都没落地**，而 `role_menu`
 * 也只写给 `admin` —— 于是除 admin 外任何角色、包括你自己新建的角色，
 * 权限集都是空的。后果最明显的一处：收银台要靠 `biz:member:list` 读会员余额
 * （`GET /biz/members/:id` 的权限点），读不到时页面**静默降级**成余额 0、
 * 报「储值余额不足」，把「店员没权限」伪装成「顾客没充钱」。
 *
 * ## 授权口径（严格照 spec；spec 没写的按最小权限，不隐式放权）
 *
 * - **店长**：§15.9「全部（含 recharge / refund / adjust / card:issue / card:refund）」，
 *   且 §8.1「payment:create / refund:approve / recharge / card:issue / booking:adjust /
 *   receivable:settle / commission:settle 默认只给店长」→ 业务域全量。
 * - **前台**：§15.9「`member:list` / `card:list` / `card:use`」+ §8.1 注释里的
 *   `manageall`（店长/前台应有）、`arrive`（前台能点到店）、`refund:apply`（可以给前台），
 *   并**剔除**上面那批钱权限。
 * - **美甲师**：§15.9「只读本人相关（会员列表按需，无任何资金动作）」→ 只给只读页面，
 *   一个按钮都不给。日常在**小程序工作台**，后台只用于查自己的排班/预约/评价。
 *
 * 三个角色都**不是** `isSystem`（不设 `isSystem`，否则会被当成超级管理员拿到 `*:*:*`）。
 * ------------------------------------------------------------------ */

/** 业务域菜单：`biz` 目录本身 + 它的 26 个页面 + 页面下的按钮 */
function isBizMenu(seed: MenuSeed): boolean {
  return (
    seed.name === 'biz' ||
    seed.parentKey === 'biz' ||
    (seed.parentKey?.startsWith('biz_') ?? false)
  );
}

/**
 * 前台的权限**白名单**（§15.9 + §8.1 注释）。
 *
 * ## 为什么用白名单而不是「扣掉钱权限」
 *
 * 先写的版本是「业务域全量 − 钱权限」，跑出来前台拿到 **79 个权限点**，
 * 里面照样有支付对账、应收台账、提成结算、挂账主体 —— 因为「钱权限」只拦住了
 * `xxx:settle` / `xxx:approve` 这类**动作**，拦不住 `biz:payment:list`、
 * `biz:receivable:list` 这些**页面读权限**。而 §8.1 的意图是钱这块整体收窄。
 * 白名单是唯一能保证「没写进去的一定没有」的写法，也符合「不做隐式默认」。
 *
 * 每一条都能在 spec 里找到出处；没出处的（如评价回复、通知模板）**一律不给**，
 * 由店长按需在角色管理里单独勾。
 */
export const FRONTDESK_PERMISSIONS: readonly string[] = [
  // 预约（本职）：§8.1 注释「店长/前台应有 manageall」「前台能点到店」→ arrive
  'biz:booking:list',
  'biz:booking:create',
  'biz:booking:update',
  'biz:booking:cancel',
  'biz:booking:arrive',
  'biz:booking:manageall',
  // 顾客档案：开单前要建档/改档
  'biz:customer:list',
  'biz:customer:create',
  'biz:customer:update',
  // 基础资料：只读
  'biz:serviceitem:list',
  'biz:staff:list',
  'biz:schedule:list',
  // 会员：§15.9 前台只有 member:list；收银台读余额也靠它
  'biz:member:list',
  // 次卡：§15.9 给 card:list / card:use
  'biz:card:list',
  'biz:card:use',
  // 退款：§8.1 注释「refund:apply 可以给前台」，approve 不给
  'biz:refund:list',
  'biz:refund:apply',
  // 评价：只看（回复按钮不给，需要时店长单独放）
  'biz:review:list',
];

/**
 * §8.1 点名「默认只给店长」的那批钱权限 —— 前台白名单里天然没有它们，
 * 这里单列出来是为了让「收窄口径」这件事在代码里看得见，并被单测钉住。
 */
export const MONEY_PERMISSIONS: readonly string[] = [
  'biz:payment:create', // 发起收款
  'biz:refund:approve', // 退款审批（与申请分离）
  'biz:member:recharge', // 充值
  'biz:member:refund', // 冲正退款
  'biz:card:issue', // 发卡
  'biz:booking:adjust', // 手动改价
  'biz:receivable:settle', // 销账
  'biz:commission:settle', // 提成结算
];

/** 美甲师可看的只读页面（不含任何按钮：F 菜单一律不匹配） */
const STYLIST_READONLY_MENUS: readonly string[] = [
  'biz_bookings', // 本人预约（数据范围由后端按 staff 限死）
  'biz_schedules', // 本人排班
  'biz_reviews', // 本人评价
  'biz_commission_records', // 本人提成（只读，结算按钮不给）
];

export type RoleSeed = {
  key: string;
  name: string;
  /** 这条口径来自 spec 的哪一句（便于复核，不用去翻文档） */
  basis: string;
  pick: (seed: MenuSeed) => boolean;
};

export const ROLE_SEEDS: RoleSeed[] = [
  {
    key: 'manager',
    name: '店长',
    basis: '§15.9 店长=全部；§8.1 钱的权限默认只给店长',
    pick: (seed) => seed.name === 'dashboard' || isBizMenu(seed),
  },
  {
    key: 'frontdesk',
    name: '前台',
    basis: '§15.9 前台=member:list/card:list/card:use；§8.1 前台不授予钱的权限',
    pick: (seed) =>
      seed.name === 'dashboard' ||
      seed.name === 'biz' ||
      // 白名单：菜单带 permission 才算命中；`biz_cashier` 这类 permission 为空的
      // 页面**不在白名单里**，所以天然不会被授予 —— 这正是白名单的好处
      (typeof seed.permission === 'string' &&
        FRONTDESK_PERMISSIONS.includes(seed.permission)),
  },
  {
    key: 'stylist',
    name: '美甲师',
    basis: '§15.9 美甲师=只读本人相关，无任何资金动作',
    pick: (seed) =>
      seed.name === 'dashboard' ||
      seed.name === 'biz' || // 父目录：不授的话子页面在路由树里成孤儿
      (seed.type === 'C' && STYLIST_READONLY_MENUS.includes(seed.name)),
  },
];

/**
 * 写入默认角色与其菜单授权。**幂等**：只补缺失的授权，不删已有
 * （运营自己在界面上调过的授权不会被 seed 覆盖掉）。
 */
async function grantRoleMenus(
  db: DbLike,
  idMap: Map<string, number>,
): Promise<void> {
  for (const role of ROLE_SEEDS) {
    await db
      .insert(roles)
      .values({ name: role.name, key: role.key })
      .onDuplicateKeyUpdate({ set: { name: role.name } });
    const [row] = await db
      .select()
      .from(roles)
      .where(eq(roles.key, role.key))
      .limit(1);
    if (!row) throw new Error(`角色写入失败：${role.key}`);

    const wanted = MENU_SEEDS.filter(role.pick)
      .map((seed) => idMap.get(seed.name))
      .filter((id): id is number => typeof id === 'number');

    const existing = await db
      .select()
      .from(roleMenus)
      .where(eq(roleMenus.roleId, row.id));
    const granted = new Set(existing.map((item) => item.menuId));
    const missing = wanted.filter((menuId) => !granted.has(menuId));
    if (missing.length > 0) {
      await db
        .insert(roleMenus)
        .values(missing.map((menuId) => ({ roleId: row.id, menuId })));
    }

    console.log(
      `[seed:menus] role ${role.key}(${role.name}) granted=${missing.length} total=${wanted.length} —— ${role.basis}`,
    );
  }
}

/** 给 admin 角色补齐菜单授权（只补缺失的，不删除已有授权） */
async function grantAdminMenus(db: DbLike, menuIds: number[]): Promise<void> {
  const [adminRole] = await db
    .select()
    .from(roles)
    .where(eq(roles.key, 'admin'))
    .limit(1);
  if (!adminRole) throw new Error('Admin role not found, run db:seed first');

  const existing = await db
    .select()
    .from(roleMenus)
    .where(eq(roleMenus.roleId, adminRole.id));
  const granted = new Set(existing.map((row) => row.menuId));
  const missing = menuIds.filter((menuId) => !granted.has(menuId));
  if (missing.length > 0) {
    await db
      .insert(roleMenus)
      .values(missing.map((menuId) => ({ roleId: adminRole.id, menuId })));
  }

  console.log(
    `[seed:menus] admin role granted=${missing.length} (total menus=${menuIds.length})`,
  );
}

/**
 * 写入菜单与权限点。
 *
 * - 默认自行建连并结束（供 `bun run db:seed:menus` / `bun src/database/seed/menus.ts` 使用）。
 * - 传入 `pool` 时复用调用方的连接（供 `seed/index.ts` 串联调用），不会 `end()` 掉别人的连接池。
 */
export async function seedMenus(pool?: mysql.Pool): Promise<void> {
  const url = Bun.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const owned = !pool;
  const target = pool ?? mysql.createPool(url);
  const db = drizzle({ client: target });

  try {
    let idMap = new Map<string, number>();
    await db.transaction(async (tx) => {
      idMap = await upsertMenus(tx);
      await grantAdminMenus(tx, [...idMap.values()]);
      // §15.9 的店长 / 前台 / 美甲师：不让「除 admin 外人人零权限」
      await grantRoleMenus(tx, idMap);
    });
    console.log(
      `[seed:menus] Done. ${MENU_SEEDS.length} menu rows (M/C/F) in place`,
    );
  } finally {
    if (owned) await target.end();
  }
}

if (import.meta.main) {
  await seedMenus();
}
