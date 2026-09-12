import { defineRelations, sql } from 'drizzle-orm';
import {
  boolean,
  char,
  date,
  datetime,
  foreignKey,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  time,
  timestamp,
  tinyint,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

/**
 * 审计列。**新增表用到它时必须检查生成的迁移 SQL**：drizzle-orm 1.0.0-rc 会把
 * `.default(sql\`CURRENT_TIMESTAMP\`)` 渲染成 `DEFAULT (CURRENT_TIMESTAMP)`，
 * MySQL 8.0.23 建表时放行、但随后任何重建表的语句（`CREATE INDEX` / `ALTER`）
 * 会报 `Invalid default value for 'created_at'`。手工去掉括号即可，
 * 且 `drizzle-kit generate` 不会因此认为有漂移（快照里存的是表达式，不是字面量）。
 */
const auditColumns = {
  createdAt: timestamp('created_at')
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  updatedAt: timestamp('updated_at')
    .default(sql`CURRENT_TIMESTAMP`)
    .onUpdateNow()
    .notNull(),
  deletedAt: datetime('deleted_at'),
  createdBy: bigintId('created_by'),
  updatedBy: bigintId('updated_by'),
};

function bigintId(name: string) {
  return int(name, { unsigned: true });
}

export const departments = mysqlTable(
  'sys_dept',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    parentId: int('parent_id', { unsigned: true }).default(0).notNull(),
    ancestors: varchar('ancestors', { length: 500 }).default('0').notNull(),
    name: varchar('name', { length: 50 }).notNull(),
    sort: int('sort').default(0).notNull(),
    phone: varchar('phone', { length: 20 }),
    email: varchar('email', { length: 100 }),
    status: mysqlEnum('status', ['active', 'disabled'])
      .default('active')
      .notNull(),
    ...auditColumns,
  },
  (table) => [index('idx_dept_parent').on(table.parentId)],
);

export const users = mysqlTable(
  'sys_user',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    deptId: int('dept_id', { unsigned: true }),
    username: varchar('username', { length: 64 }).notNull(),
    displayName: varchar('display_name', { length: 64 }).notNull(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    email: varchar('email', { length: 100 }),
    phone: varchar('phone', { length: 20 }),
    avatar: varchar('avatar', { length: 500 }),
    status: mysqlEnum('status', ['active', 'disabled'])
      .default('active')
      .notNull(),
    loginAt: datetime('login_at'),
    loginIp: varchar('login_ip', { length: 45 }),
    passwordChangedAt: datetime('password_changed_at'),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('uq_user_username').on(table.username),
    index('idx_user_dept').on(table.deptId),
    foreignKey({
      columns: [table.deptId],
      foreignColumns: [departments.id],
      name: 'fk_user_dept',
    }).onDelete('set null'),
  ],
);

export const roles = mysqlTable(
  'sys_role',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    name: varchar('name', { length: 50 }).notNull(),
    key: varchar('role_key', { length: 100 }).notNull(),
    sort: int('sort').default(0).notNull(),
    dataScope: mysqlEnum('data_scope', [
      'all',
      'custom',
      'dept',
      'dept_and_children',
      'self',
    ])
      .default('all')
      .notNull(),
    status: mysqlEnum('status', ['active', 'disabled'])
      .default('active')
      .notNull(),
    isSystem: boolean('is_system').default(false).notNull(),
    remark: varchar('remark', { length: 500 }),
    ...auditColumns,
  },
  (table) => [uniqueIndex('uq_role_key').on(table.key)],
);

export const menus = mysqlTable(
  'sys_menu',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    parentId: int('parent_id', { unsigned: true }).default(0).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    title: varchar('title', { length: 100 }).notNull(),
    type: mysqlEnum('type', ['M', 'C', 'F']).notNull(),
    path: varchar('path', { length: 255 }),
    component: varchar('component', { length: 255 }),
    permission: varchar('permission', { length: 255 }),
    icon: varchar('icon', { length: 100 }),
    sort: int('sort').default(0).notNull(),
    visible: boolean('visible').default(true).notNull(),
    cacheable: boolean('cacheable').default(false).notNull(),
    external: boolean('external').default(false).notNull(),
    status: mysqlEnum('status', ['active', 'disabled'])
      .default('active')
      .notNull(),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('uq_menu_permission').on(table.permission),
    index('idx_menu_parent').on(table.parentId),
  ],
);

export const userRoles = mysqlTable(
  'sys_user_role',
  {
    userId: int('user_id', { unsigned: true }).notNull(),
    roleId: int('role_id', { unsigned: true }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_user_role').on(table.userId, table.roleId),
    index('idx_user_role_role').on(table.roleId),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: 'fk_user_role_user',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.roleId],
      foreignColumns: [roles.id],
      name: 'fk_user_role_role',
    }).onDelete('cascade'),
  ],
);

/** 角色-部门（自定义数据权限范围时指定可见部门） */
export const roleDepts = mysqlTable(
  'sys_role_dept',
  {
    roleId: int('role_id', { unsigned: true }).notNull(),
    deptId: int('dept_id', { unsigned: true }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_role_dept').on(table.roleId, table.deptId),
    index('idx_role_dept_dept').on(table.deptId),
    foreignKey({
      columns: [table.roleId],
      foreignColumns: [roles.id],
      name: 'fk_role_dept_role',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.deptId],
      foreignColumns: [departments.id],
      name: 'fk_role_dept_dept',
    }).onDelete('cascade'),
  ],
);
export const roleMenus = mysqlTable(
  'sys_role_menu',
  {
    roleId: int('role_id', { unsigned: true }).notNull(),
    menuId: int('menu_id', { unsigned: true }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_role_menu').on(table.roleId, table.menuId),
    index('idx_role_menu_menu').on(table.menuId),
    foreignKey({
      columns: [table.roleId],
      foreignColumns: [roles.id],
      name: 'fk_role_menu_role',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.menuId],
      foreignColumns: [menus.id],
      name: 'fk_role_menu_menu',
    }).onDelete('cascade'),
  ],
);
export const posts = mysqlTable(
  'sys_post',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    name: varchar('name', { length: 50 }).notNull(),
    key: varchar('post_key', { length: 100 }).notNull(),
    sort: int('sort').default(0).notNull(),
    status: mysqlEnum('status', ['active', 'disabled'])
      .default('active')
      .notNull(),
    remark: varchar('remark', { length: 500 }),
    ...auditColumns,
  },
  (table) => [uniqueIndex('uq_post_key').on(table.key)],
);
export const userPosts = mysqlTable(
  'sys_user_post',
  {
    userId: int('user_id', { unsigned: true }).notNull(),
    postId: int('post_id', { unsigned: true }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_user_post').on(table.userId, table.postId),
    index('idx_user_post_post').on(table.postId),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: 'fk_user_post_user',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.postId],
      foreignColumns: [posts.id],
      name: 'fk_user_post_post',
    }).onDelete('cascade'),
  ],
);
export const refreshTokens = mysqlTable(
  'sys_refresh_token',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    userId: int('user_id', { unsigned: true }).notNull(),
    tokenHash: varchar('token_hash', { length: 255 }).notNull(),
    expiresAt: datetime('expires_at').notNull(),
    revokedAt: datetime('revoked_at'),
    device: varchar('device', { length: 255 }),
    ip: varchar('ip', { length: 45 }),
    createdAt: timestamp('created_at')
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('uq_refresh_token_hash').on(table.tokenHash),
    index('idx_refresh_user').on(table.userId),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: 'fk_refresh_token_user',
    }).onDelete('cascade'),
  ],
);
export const dictionaries = mysqlTable(
  'sys_dict_data',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    type: varchar('dict_type', { length: 100 }).notNull(),
    label: varchar('label', { length: 100 }).notNull(),
    value: varchar('value', { length: 100 }).notNull(),
    sort: int('sort').default(0).notNull(),
    status: mysqlEnum('status', ['active', 'disabled'])
      .default('active')
      .notNull(),
    cssClass: varchar('css_class', { length: 100 }),
    listClass: varchar('list_class', { length: 100 }),
    ...auditColumns,
  },
  (table) => [uniqueIndex('uq_dict_type_value').on(table.type, table.value)],
);
export const dictTypes = mysqlTable(
  'sys_dict_type',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
    type: varchar('type', { length: 100 }).notNull(),
    status: mysqlEnum('status', ['active', 'disabled'])
      .default('active')
      .notNull(),
    remark: varchar('remark', { length: 500 }),
    ...auditColumns,
  },
  (table) => [uniqueIndex('uq_dict_type').on(table.type)],
);
export const configs = mysqlTable(
  'sys_config',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
    key: varchar('config_key', { length: 100 }).notNull(),
    value: varchar('value', { length: 500 }).notNull(),
    builtin: boolean('builtin').default(false).notNull(),
    remark: varchar('remark', { length: 500 }),
    ...auditColumns,
  },
  (table) => [uniqueIndex('uq_config_key').on(table.key)],
);
export const operationLogs = mysqlTable(
  'sys_operation_log',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    userId: int('user_id', { unsigned: true }),
    title: varchar('title', { length: 100 }).notNull(),
    businessType: varchar('business_type', { length: 50 }).notNull(),
    method: varchar('method', { length: 255 }).notNull(),
    requestMethod: varchar('request_method', { length: 10 }).notNull(),
    url: varchar('url', { length: 500 }).notNull(),
    ip: varchar('ip', { length: 45 }),
    requestBody: json('request_body'),
    responseBody: json('response_body'),
    status: mysqlEnum('status', ['success', 'failure']).notNull(),
    errorMessage: varchar('error_message', { length: 2000 }),
    durationMs: int('duration_ms', { unsigned: true }).notNull(),
    createdAt: timestamp('created_at')
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('idx_operation_log_user_time').on(table.userId, table.createdAt),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: 'fk_operation_log_user',
    }).onDelete('set null'),
  ],
);
export const loginLogs = mysqlTable(
  'sys_login_log',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    userId: int('user_id', { unsigned: true }),
    username: varchar('username', { length: 64 }).notNull(),
    ip: varchar('ip', { length: 45 }),
    userAgent: varchar('user_agent', { length: 500 }),
    status: mysqlEnum('status', ['success', 'failure']).notNull(),
    message: varchar('message', { length: 500 }),
    createdAt: timestamp('created_at')
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('idx_login_log_user').on(table.userId),
    index('idx_login_log_time').on(table.createdAt),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: 'fk_login_log_user',
    }).onDelete('set null'),
  ],
);
export const jobs = mysqlTable(
  'sys_job',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
    handler: varchar('handler', { length: 255 }).notNull(),
    cron: varchar('cron', { length: 100 }).notNull(),
    status: mysqlEnum('status', ['active', 'disabled'])
      .default('active')
      .notNull(),
    concurrent: boolean('concurrent').default(true).notNull(),
    remark: varchar('remark', { length: 500 }),
    ...auditColumns,
  },
  (table) => [uniqueIndex('uq_job_handler').on(table.handler)],
);
export const jobLogs = mysqlTable(
  'sys_job_log',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    jobId: int('job_id', { unsigned: true }).notNull(),
    jobName: varchar('job_name', { length: 100 }).notNull(),
    handler: varchar('handler', { length: 255 }).notNull(),
    status: mysqlEnum('status', ['success', 'failure']).notNull(),
    message: varchar('message', { length: 2000 }),
    startedAt: timestamp('started_at').notNull(),
    finishedAt: timestamp('finished_at').notNull(),
    durationMs: int('duration_ms', { unsigned: true }).notNull(),
  },
  (table) => [
    index('idx_job_log_job').on(table.jobId),
    foreignKey({
      columns: [table.jobId],
      foreignColumns: [jobs.id],
      name: 'fk_job_log_job',
    }).onDelete('cascade'),
  ],
);
export const files = mysqlTable(
  'sys_file',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    originalName: varchar('original_name', { length: 255 }).notNull(),
    path: varchar('path', { length: 500 }).notNull(),
    mime: varchar('mime', { length: 100 }).notNull(),
    ext: varchar('ext', { length: 20 }).notNull(),
    size: int('size', { unsigned: true }).notNull(),
    createdBy: int('created_by', { unsigned: true }),
    createdAt: timestamp('created_at')
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('idx_file_created_by').on(table.createdBy),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: 'fk_file_created_by',
    }).onDelete('set null'),
  ],
);

/** AI 会话：记录一次 AI 对话 */
export const aiSessions = mysqlTable(
  'ai_session',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    userId: int('user_id', { unsigned: true }).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    status: mysqlEnum('status', ['active', 'closed'])
      .default('active')
      .notNull(),
    createdAt: timestamp('created_at')
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp('updated_at')
      .default(sql`CURRENT_TIMESTAMP`)
      .onUpdateNow()
      .notNull(),
  },
  (table) => [
    index('idx_ai_session_user').on(table.userId),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: 'fk_ai_session_user',
    }).onDelete('cascade'),
  ],
);

/** AI 消息：记录一次对话中的每条消息（含 tool 调用与结果） */
export const aiMessages = mysqlTable(
  'ai_message',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    sessionId: int('session_id', { unsigned: true }).notNull(),
    role: mysqlEnum('role', ['user', 'assistant', 'tool', 'system']).notNull(),
    content: text('content'),
    toolCalls: json('tool_calls'),
    toolResults: json('tool_results'),
    createdAt: timestamp('created_at')
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('idx_ai_message_session').on(table.sessionId),
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [aiSessions.id],
      name: 'fk_ai_message_session',
    }).onDelete('cascade'),
  ],
);

/** AI 审计日志：记录 AI 操作全过程 */
export const aiAuditLogs = mysqlTable(
  'ai_audit_log',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    userId: int('user_id', { unsigned: true }),
    sessionId: int('session_id', { unsigned: true }),
    action: varchar('action', { length: 100 }).notNull(),
    toolName: varchar('tool_name', { length: 100 }),
    riskLevel: varchar('risk_level', { length: 10 }),
    permission: varchar('permission', { length: 100 }),
    scope: varchar('scope', { length: 100 }),
    result: mysqlEnum('result', ['allowed', 'denied', 'error']).notNull(),
    metadata: json('metadata'),
    createdAt: timestamp('created_at')
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('idx_ai_audit_user').on(table.userId),
    index('idx_ai_audit_session').on(table.sessionId),
    index('idx_ai_audit_time').on(table.createdAt),
  ],
);

/** AI 操作意图：记录待审批的 AI 操作 */
export const aiActionIntents = mysqlTable(
  'ai_action_intent',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    sessionId: int('session_id', { unsigned: true }),
    userId: int('user_id', { unsigned: true }).notNull(),
    toolName: varchar('tool_name', { length: 100 }).notNull(),
    input: json('input'),
    inputHash: varchar('input_hash', { length: 64 }).notNull(),
    beforeHash: varchar('before_hash', { length: 64 }),
    confirmToken: varchar('confirm_token', { length: 128 }),
    riskLevel: varchar('risk_level', { length: 10 }).notNull(),
    status: mysqlEnum('status', [
      'PENDING',
      'APPROVED',
      'REJECTED',
      'EXPIRED',
      'EXECUTED',
      'CANCELLED',
    ])
      .default('PENDING')
      .notNull(),
    /** 关联任务（审批操作也纳入任务时间线） */
    taskId: int('task_id', { unsigned: true }),
    /** 关联任务步骤（确认执行后更新步骤状态与 undo 快照） */
    taskStepId: int('task_step_id', { unsigned: true }),
    expiresAt: datetime('expires_at').notNull(),
    executedAt: datetime('executed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_ai_action_intent_user').on(table.userId),
    index('idx_ai_action_intent_status').on(table.status),
    index('idx_ai_action_intent_token').on(table.confirmToken),
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [aiSessions.id],
      name: 'fk_ai_action_intent_session',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: 'fk_ai_action_intent_user',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.taskId],
      foreignColumns: [aiTasks.id],
      name: 'fk_ai_action_intent_task',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.taskStepId],
      foreignColumns: [aiTaskSteps.id],
      name: 'fk_ai_action_intent_task_step',
    }).onDelete('set null'),
  ],
);

/** AI 审批记录 */
export const aiApprovals = mysqlTable(
  'ai_approval',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    actionIntentId: int('action_intent_id', { unsigned: true }).notNull(),
    approverId: int('approver_id', { unsigned: true }).notNull(),
    status: mysqlEnum('status', ['APPROVED', 'REJECTED']).notNull(),
    reason: varchar('reason', { length: 500 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_ai_approval_intent').on(table.actionIntentId),
    foreignKey({
      columns: [table.actionIntentId],
      foreignColumns: [aiActionIntents.id],
      name: 'fk_ai_approval_intent',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.approverId],
      foreignColumns: [users.id],
      name: 'fk_ai_approval_approver',
    }).onDelete('cascade'),
  ],
);

/** AI 任务：记录一个完整的 AI 多步任务 */
export const aiTasks = mysqlTable(
  'ai_task',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    sessionId: int('session_id', { unsigned: true }),
    userId: int('user_id', { unsigned: true }).notNull(),
    status: mysqlEnum('status', [
      'PENDING',
      'RUNNING',
      'SUCCESS',
      'FAILED',
      'CANCELLED',
    ])
      .default('PENDING')
      .notNull(),
    riskLevel: varchar('risk_level', { length: 10 }).notNull(),
    goal: varchar('goal', { length: 500 }).notNull(),
    error: varchar('error', { length: 1000 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    startedAt: timestamp('started_at'),
    completedAt: timestamp('completed_at'),
  },
  (table) => [
    index('idx_ai_task_session').on(table.sessionId),
    index('idx_ai_task_user').on(table.userId),
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [aiSessions.id],
      name: 'fk_ai_task_session',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: 'fk_ai_task_user',
    }).onDelete('cascade'),
  ],
);

/** AI 任务步骤：记录任务中的每一步 */
export const aiTaskSteps = mysqlTable(
  'ai_task_step',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    taskId: int('task_id', { unsigned: true }).notNull(),
    stepIndex: int('step_index').notNull(),
    toolName: varchar('tool_name', { length: 100 }).notNull(),
    input: json('input'),
    output: json('output'),
    status: mysqlEnum('status', [
      'PENDING',
      'RUNNING',
      'SUCCESS',
      'FAILED',
      'SKIPPED',
      'WAITING_APPROVAL',
    ])
      .default('PENDING')
      .notNull(),
    riskLevel: varchar('risk_level', { length: 10 }).notNull(),
    error: varchar('error', { length: 1000 }),
    startedAt: timestamp('started_at'),
    completedAt: timestamp('completed_at'),
  },
  (table) => [
    index('idx_ai_task_step_task').on(table.taskId),
    foreignKey({
      columns: [table.taskId],
      foreignColumns: [aiTasks.id],
      name: 'fk_ai_task_step_task',
    }).onDelete('cascade'),
  ],
);

/* ------------------------------------------------------------------ *
 * A. 预约主链路（§4.3）
 * ------------------------------------------------------------------ */

/** 服务项目：时长决定占用时段，缓冲参与冲突判定（§5.3） */
export const bizServiceItems = mysqlTable(
  'biz_service_item',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    name: varchar('name', { length: 50 }).notNull(),
    category: varchar('category', { length: 30 }),
    durationMinutes: int('duration_minutes', { unsigned: true }).notNull(),
    bufferMinutes: int('buffer_minutes', { unsigned: true })
      .default(0)
      .notNull(),
    price: int('price', { unsigned: true }).default(0).notNull(),
    description: varchar('description', { length: 500 }),
    /**
     * 图集：图片地址数组，顺序即展示顺序（§9.1）。
     * 与 `biz_review.images` 一样用 json 数组，不额外建关联表 —— 图片只做展示，
     * 不参与查询条件，也不需要引用完整性，建表只会白搭一次 join 与一套整体替换逻辑。
     */
    images: json('images').$type<string[]>(),
    /**
     * 封面图：**派生字段**，恒等于 `images[0] ?? null`，由 `ServiceItemsService` 统一回写。
     * 留着它是为了让列表页与小程序目录不必解析图集就能拿到封面；
     * 写入接口**不接受** `image`，避免出现「封面与图集首图不一致」的脏数据。
     */
    image: varchar('image', { length: 500 }),
    status: mysqlEnum('status', ['active', 'disabled'])
      .default('active')
      .notNull(),
    sort: int('sort').default(0).notNull(),
    remark: varchar('remark', { length: 500 }),
    ...auditColumns,
  },
  (table) => [index('idx_service_item_status').on(table.status, table.sort)],
);

/** 美甲师档案：未必有后台账号，故 user_id 可空 */
export const bizStaffs = mysqlTable(
  'biz_staff',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    userId: int('user_id', { unsigned: true }),
    nickname: varchar('nickname', { length: 50 }).notNull(),
    avatar: varchar('avatar', { length: 500 }),
    phone: varchar('phone', { length: 20 }),
    bio: varchar('bio', { length: 500 }),
    status: mysqlEnum('status', ['active', 'disabled'])
      .default('active')
      .notNull(),
    sort: int('sort').default(0).notNull(),
    remark: varchar('remark', { length: 500 }),
    ...auditColumns,
  },
  (table) => [
    index('idx_staff_user').on(table.userId),
    index('idx_staff_status').on(table.status, table.sort),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: 'fk_staff_user',
    }).onDelete('set null'),
  ],
);

/** 周模板班次（物理删：PUT 整体替换先删后插，§3 豁免） */
export const bizStaffWeeklyShifts = mysqlTable(
  'biz_staff_weekly_shift',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    staffId: int('staff_id', { unsigned: true }).notNull(),
    weekday: tinyint('weekday', { unsigned: true }).notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    ...auditColumns,
  },
  (table) => [
    index('idx_shift_staff_weekday').on(table.staffId, table.weekday),
    foreignKey({
      columns: [table.staffId],
      foreignColumns: [bizStaffs.id],
      name: 'fk_shift_staff',
    }).onDelete('cascade'),
  ],
);

/** 日期例外（物理删，§3 豁免）：off 整天休息 / custom 自定义时段 */
export const bizStaffScheduleOverrides = mysqlTable(
  'biz_staff_schedule_override',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    staffId: int('staff_id', { unsigned: true }).notNull(),
    date: date('date', { mode: 'string' }).notNull(),
    type: mysqlEnum('type', ['off', 'custom']).notNull(),
    startTime: time('start_time'),
    endTime: time('end_time'),
    reason: varchar('reason', { length: 200 }),
    ...auditColumns,
  },
  (table) => [
    index('idx_override_staff_date').on(table.staffId, table.date),
    foreignKey({
      columns: [table.staffId],
      foreignColumns: [bizStaffs.id],
      name: 'fk_override_staff',
    }).onDelete('cascade'),
  ],
);

/** 顾客档案（兼会员档案，§4.4）：level_id 以下字段全部由账务流水驱动 */
export const bizCustomers = mysqlTable(
  'biz_customer',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    name: varchar('name', { length: 50 }).notNull(),
    phone: varchar('phone', { length: 20 }),
    gender: mysqlEnum('gender', ['unknown', 'male', 'female'])
      .default('unknown')
      .notNull(),
    birthday: date('birthday', { mode: 'string' }),
    remark: varchar('remark', { length: 500 }),
    visitCount: int('visit_count', { unsigned: true }).default(0).notNull(),
    lastVisitAt: datetime('last_visit_at'),
    levelId: int('level_id', { unsigned: true }),
    memberNo: varchar('member_no', { length: 32 }),
    memberSince: datetime('member_since'),
    totalSpent: int('total_spent', { unsigned: true }).default(0).notNull(),
    points: int('points', { unsigned: true }).default(0).notNull(),
    pointsTotal: int('points_total', { unsigned: true }).default(0).notNull(),
    balancePrincipal: int('balance_principal', { unsigned: true })
      .default(0)
      .notNull(),
    balanceBonus: int('balance_bonus', { unsigned: true }).default(0).notNull(),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('uq_customer_phone').on(table.phone),
    uniqueIndex('uq_customer_member_no').on(table.memberNo),
    index('idx_customer_level').on(table.levelId),
    index('idx_customer_name').on(table.name),
    foreignKey({
      columns: [table.levelId],
      foreignColumns: [bizMemberLevels.id],
      name: 'fk_customer_level',
    }).onDelete('set null'),
  ],
);

/** 预约单：快照金额 + 支付/应收/周期来源（§4.3、§5.8、§7.4） */
export const bizBookings = mysqlTable(
  'biz_booking',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    bookingNo: varchar('booking_no', { length: 32 }).notNull(),
    customerId: int('customer_id', { unsigned: true }).notNull(),
    staffId: int('staff_id', { unsigned: true }).notNull(),
    startAt: datetime('start_at').notNull(),
    endAt: datetime('end_at').notNull(),
    durationMinutes: int('duration_minutes', { unsigned: true }).notNull(),
    bufferMinutes: int('buffer_minutes', { unsigned: true })
      .default(0)
      .notNull(),
    originalPrice: int('original_price', { unsigned: true })
      .default(0)
      .notNull(),
    levelDiscountPermille: int('level_discount_permille', { unsigned: true })
      .default(1000)
      .notNull(),
    levelDiscountAmount: int('level_discount_amount', { unsigned: true })
      .default(0)
      .notNull(),
    /** 使用的券（可空）。券与积分**同一单二选一**，口径见 money.ts 的 quoteBooking */
    couponId: int('coupon_id', { unsigned: true }),
    /** 券抵扣额（分）：券在等级折扣之后、积分之前 */
    couponDiscountAmount: int('coupon_discount_amount', { unsigned: true })
      .default(0)
      .notNull(),
    pointsDiscountAmount: int('points_discount_amount', { unsigned: true })
      .default(0)
      .notNull(),
    adjustAmount: int('adjust_amount').default(0).notNull(),
    adjustReason: varchar('adjust_reason', { length: 200 }),
    payableAmount: int('payable_amount', { unsigned: true })
      .default(0)
      .notNull(),
    depositAmount: int('deposit_amount', { unsigned: true })
      .default(0)
      .notNull(),
    paidAmount: int('paid_amount', { unsigned: true }).default(0).notNull(),
    dueAmount: int('due_amount', { unsigned: true }).default(0).notNull(),
    payStatus: mysqlEnum('pay_status', [
      'unpaid',
      'partial',
      'paid',
      'refunded',
      'credit',
    ])
      .default('unpaid')
      .notNull(),
    payChannelSummary: varchar('pay_channel_summary', { length: 64 }),
    settledAt: datetime('settled_at'),
    creditAccountId: int('credit_account_id', { unsigned: true }),
    recurrenceId: int('recurrence_id', { unsigned: true }),
    memberCardId: int('member_card_id', { unsigned: true }),
    refundAmount: int('refund_amount', { unsigned: true }).default(0).notNull(),
    refundedAt: datetime('refunded_at'),
    status: mysqlEnum('status', [
      'pending',
      'confirmed',
      'arrived',
      'completed',
      'cancelled',
      'no_show',
    ])
      .default('confirmed')
      .notNull(),
    channel: mysqlEnum('channel', ['admin', 'miniapp'])
      .default('admin')
      .notNull(),
    customerName: varchar('customer_name', { length: 50 }).notNull(),
    customerPhone: varchar('customer_phone', { length: 20 }),
    remark: varchar('remark', { length: 500 }),
    cancelReason: varchar('cancel_reason', { length: 200 }),
    confirmedAt: datetime('confirmed_at'),
    arrivedAt: datetime('arrived_at'),
    finishedAt: datetime('finished_at'),
    cancelledAt: datetime('cancelled_at'),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('uq_booking_no').on(table.bookingNo),
    uniqueIndex('uq_booking_recurrence_start').on(
      table.recurrenceId,
      table.startAt,
    ),
    index('idx_booking_staff_time').on(
      table.staffId,
      table.startAt,
      table.endAt,
    ),
    index('idx_booking_customer').on(table.customerId, table.startAt),
    index('idx_booking_status_start').on(table.status, table.startAt),
    index('idx_booking_status_end').on(table.status, table.endAt),
    index('idx_booking_pay').on(table.payStatus, table.startAt),
    index('idx_booking_credit').on(table.creditAccountId, table.payStatus),
    index('idx_booking_recurrence').on(table.recurrenceId),
    foreignKey({
      columns: [table.customerId],
      foreignColumns: [bizCustomers.id],
      name: 'fk_booking_customer',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.staffId],
      foreignColumns: [bizStaffs.id],
      name: 'fk_booking_staff',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.creditAccountId],
      foreignColumns: [bizCreditAccounts.id],
      name: 'fk_booking_credit_account',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.memberCardId],
      foreignColumns: [bizMemberCards.id],
      name: 'fk_booking_member_card',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.recurrenceId],
      foreignColumns: [bizBookingRecurrences.id],
      name: 'fk_booking_recurrence',
    }).onDelete('set null'),
  ],
);

/** 预约项目明细：从属子表，不套 auditColumns（§3 豁免） */
export const bizBookingItems = mysqlTable(
  'biz_booking_item',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    bookingId: int('booking_id', { unsigned: true }).notNull(),
    serviceItemId: int('service_item_id', { unsigned: true }).notNull(),
    name: varchar('name', { length: 50 }).notNull(),
    durationMinutes: int('duration_minutes', { unsigned: true }).notNull(),
    price: int('price', { unsigned: true }).default(0).notNull(),
    sort: int('sort').default(0).notNull(),
  },
  (table) => [
    index('idx_booking_item_booking').on(table.bookingId),
    index('idx_booking_item_service').on(table.serviceItemId),
    foreignKey({
      columns: [table.bookingId],
      foreignColumns: [bizBookings.id],
      name: 'fk_booking_item_booking',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serviceItemId],
      foreignColumns: [bizServiceItems.id],
      name: 'fk_booking_item_service',
    }).onDelete('restrict'),
  ],
);

/* ------------------------------------------------------------------ *
 * B. 会员体系（§4.4、§15）
 * ------------------------------------------------------------------ */

/** 会员等级：折扣率千分比 + 累计消费升级门槛 */
export const bizMemberLevels = mysqlTable(
  'biz_member_level',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    name: varchar('name', { length: 30 }).notNull(),
    discountPermille: int('discount_permille', { unsigned: true })
      .default(1000)
      .notNull(),
    upgradeAmount: int('upgrade_amount', { unsigned: true })
      .default(0)
      .notNull(),
    sort: int('sort').default(0).notNull(),
    status: mysqlEnum('status', ['active', 'disabled'])
      .default('active')
      .notNull(),
    remark: varchar('remark', { length: 200 }),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('uq_level_name').on(table.name),
    index('idx_level_status_sort').on(table.status, table.sort),
  ],
);

/** 充值方案：实付 + 赠送（赠送比例受 biz.member.maxBonusPermille 约束） */
export const bizRechargePlans = mysqlTable(
  'biz_recharge_plan',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    name: varchar('name', { length: 30 }).notNull(),
    payAmount: int('pay_amount', { unsigned: true }).notNull(),
    bonusAmount: int('bonus_amount', { unsigned: true }).default(0).notNull(),
    status: mysqlEnum('status', ['active', 'disabled'])
      .default('active')
      .notNull(),
    sort: int('sort').default(0).notNull(),
    remark: varchar('remark', { length: 200 }),
    ...auditColumns,
  },
  (table) => [uniqueIndex('uq_recharge_plan_name').on(table.name)],
);

/** 次卡卡种 */
export const bizMemberCardTypes = mysqlTable(
  'biz_member_card_type',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    name: varchar('name', { length: 50 }).notNull(),
    price: int('price', { unsigned: true }).notNull(),
    totalTimes: int('total_times', { unsigned: true }).notNull(),
    validDays: int('valid_days', { unsigned: true }).default(0).notNull(),
    status: mysqlEnum('status', ['active', 'disabled'])
      .default('active')
      .notNull(),
    sort: int('sort').default(0).notNull(),
    remark: varchar('remark', { length: 200 }),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('uq_card_type_name').on(table.name),
    index('idx_card_type_status_sort').on(table.status, table.sort),
  ],
);

/** 卡种适用项目（物理删：随卡种整体替换） */
export const bizMemberCardTypeItems = mysqlTable(
  'biz_member_card_type_item',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    cardTypeId: int('card_type_id', { unsigned: true }).notNull(),
    serviceItemId: int('service_item_id', { unsigned: true }).notNull(),
    sort: int('sort').default(0).notNull(),
  },
  (table) => [
    uniqueIndex('uq_card_type_item').on(table.cardTypeId, table.serviceItemId),
    foreignKey({
      columns: [table.cardTypeId],
      foreignColumns: [bizMemberCardTypes.id],
      name: 'fk_card_type_item_type',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serviceItemId],
      foreignColumns: [bizServiceItems.id],
      name: 'fk_card_type_item_service',
    }).onDelete('restrict'),
  ],
);

/** 会员卡实例：used_times / status 只能由核销 service 条件更新 */
export const bizMemberCards = mysqlTable(
  'biz_member_card',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    cardNo: varchar('card_no', { length: 32 }).notNull(),
    customerId: int('customer_id', { unsigned: true }).notNull(),
    cardTypeId: int('card_type_id', { unsigned: true }).notNull(),
    cardName: varchar('card_name', { length: 50 }).notNull(),
    totalTimes: int('total_times', { unsigned: true }).notNull(),
    usedTimes: int('used_times', { unsigned: true }).default(0).notNull(),
    price: int('price', { unsigned: true }).default(0).notNull(),
    payChannel: mysqlEnum('pay_channel', [
      'cash',
      'wechat',
      'alipay',
      'balance',
    ]).notNull(),
    purchasedAt: datetime('purchased_at').notNull(),
    expireAt: datetime('expire_at'),
    status: mysqlEnum('status', ['active', 'used_up', 'expired', 'refunded'])
      .default('active')
      .notNull(),
    remark: varchar('remark', { length: 200 }),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('uq_member_card_no').on(table.cardNo),
    index('idx_card_customer').on(table.customerId, table.status),
    index('idx_card_expire').on(table.status, table.expireAt),
    foreignKey({
      columns: [table.customerId],
      foreignColumns: [bizCustomers.id],
      name: 'fk_card_customer',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.cardTypeId],
      foreignColumns: [bizMemberCardTypes.id],
      name: 'fk_card_type',
    }).onDelete('restrict'),
  ],
);

/** 次卡核销记录（只追加） */
export const bizMemberCardLogs = mysqlTable(
  'biz_member_card_log',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    cardId: int('card_id', { unsigned: true }).notNull(),
    bookingId: int('booking_id', { unsigned: true }),
    serviceItemId: int('service_item_id', { unsigned: true }).notNull(),
    type: mysqlEnum('type', ['use', 'revert']).notNull(),
    times: int('times', { unsigned: true }).default(1).notNull(),
    remark: varchar('remark', { length: 200 }),
    createdBy: int('created_by', { unsigned: true }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_card_log_card').on(table.cardId, table.id),
    index('idx_card_log_booking').on(table.bookingId),
    foreignKey({
      columns: [table.cardId],
      foreignColumns: [bizMemberCards.id],
      name: 'fk_card_log_card',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.bookingId],
      foreignColumns: [bizBookings.id],
      name: 'fk_card_log_booking',
    }).onDelete('set null'),
  ],
);

/** 会员账务流水（只追加，不可修改删除，§15.7 不变量） */
export const bizMemberTransactions = mysqlTable(
  'biz_member_transaction',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    customerId: int('customer_id', { unsigned: true }).notNull(),
    type: mysqlEnum('type', [
      'recharge',
      'consume',
      'refund',
      'card_buy',
      'card_use',
      'card_revert',
      'points_earn',
      'points_spend',
      'points_redeem',
      'level_change',
      'adjust',
    ]).notNull(),
    amount: int('amount').default(0).notNull(),
    balanceDeltaPrincipal: int('balance_delta_principal').default(0).notNull(),
    balanceDeltaBonus: int('balance_delta_bonus').default(0).notNull(),
    balancePrincipalAfter: int('balance_principal_after', { unsigned: true })
      .default(0)
      .notNull(),
    balanceBonusAfter: int('balance_bonus_after', { unsigned: true })
      .default(0)
      .notNull(),
    pointsDelta: int('points_delta').default(0).notNull(),
    pointsAfter: int('points_after', { unsigned: true }).default(0).notNull(),
    payChannel: mysqlEnum('pay_channel', [
      'cash',
      'wechat',
      'alipay',
      'balance',
      'card',
    ]),
    bookingId: int('booking_id', { unsigned: true }),
    cardId: int('card_id', { unsigned: true }),
    planId: int('plan_id', { unsigned: true }),
    reversalOf: int('reversal_of', { unsigned: true }),
    remark: varchar('remark', { length: 200 }),
    createdBy: int('created_by', { unsigned: true }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_txn_customer').on(table.customerId, table.id),
    index('idx_txn_booking').on(table.bookingId),
    index('idx_txn_type_created').on(table.type, table.createdAt),
    foreignKey({
      columns: [table.customerId],
      foreignColumns: [bizCustomers.id],
      name: 'fk_txn_customer',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.bookingId],
      foreignColumns: [bizBookings.id],
      name: 'fk_txn_booking',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.cardId],
      foreignColumns: [bizMemberCards.id],
      name: 'fk_txn_card',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.planId],
      foreignColumns: [bizRechargePlans.id],
      name: 'fk_txn_plan',
    }).onDelete('set null'),
  ],
);

/* ------------------------------------------------------------------ *
 * E. 小程序身份（§4.4、§16）
 * ------------------------------------------------------------------ */

/**
 * 微信身份：先有 openid 才能浏览，授权手机号后才绑定顾客档案。
 *
 * 同一个微信号可以同时是「顾客」和「美甲师」（店员自己也会来做指甲），
 * 所以两种身份各占一组列，互不影响：
 * - 顾客身份：`customer_id`（手机号授权后匹配/创建 `biz_customer`）；
 * - 美甲师工作台：`staff_id` + `staff_status`（手机号命中 `biz_staff.phone` 后置 `pending`，
 *   **必须店长在后台确认**才变 `active`——仅凭手机号自动开通等于提权漏洞：
 *   spec §16.2 允许「手机号属于他人 openid 也允许绑定」，号码被复用即可看该美甲师的预约与业绩）。
 *
 * `staff_status` 放在这里而不是 token 里：停用（`biz_staff.status=disabled`）或店长撤权后
 * **下一次请求立即失效**，而 token 里的角色要等过期才失效。
 */
export const appWxUsers = mysqlTable(
  'app_wx_user',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    openid: varchar('openid', { length: 64 }).notNull(),
    unionid: varchar('unionid', { length: 64 }),
    customerId: int('customer_id', { unsigned: true }),
    staffId: int('staff_id', { unsigned: true }),
    staffStatus: mysqlEnum('staff_status', [
      'none',
      'pending',
      'active',
      'rejected',
    ])
      .default('none')
      .notNull(),
    /** 手机号命中美甲师档案、提交开通申请的时间 */
    staffRequestedAt: datetime('staff_requested_at'),
    /** 店长确认/驳回的时间 */
    staffDecidedAt: datetime('staff_decided_at'),
    /** 决策人（`sys_user.id`），用于事后追溯 */
    staffDecidedBy: int('staff_decided_by', { unsigned: true }),
    /** 驳回原因：店长必须填写，小程序端能看到「为什么没通过」 */
    staffRejectReason: varchar('staff_reject_reason', { length: 200 }),
    nickname: varchar('nickname', { length: 50 }),
    avatar: varchar('avatar', { length: 500 }),
    phone: varchar('phone', { length: 20 }),
    lastLoginAt: datetime('last_login_at'),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('uq_wx_openid').on(table.openid),
    index('idx_wx_unionid').on(table.unionid),
    index('idx_wx_customer').on(table.customerId),
    index('idx_wx_staff').on(table.staffId, table.staffStatus),
    foreignKey({
      columns: [table.customerId],
      foreignColumns: [bizCustomers.id],
      name: 'fk_wx_user_customer',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.staffId],
      foreignColumns: [bizStaffs.id],
      name: 'fk_wx_user_staff',
    }).onDelete('set null'),
  ],
);

/**
 * 小程序订阅消息授权台账（P2 / A12）。
 *
 * 微信订阅消息的真实语义是**额度**：用户在客户端点一次「允许」，开发者就获得
 * 该模板的一次下发权限，且可累积。所以按 `(用户, 模板)` 聚合成一行计数，而不是
 * 记成 append-only 流水——后者做不了「还能发几次」的查询。
 *
 * 两条约束：
 * 1. 只记**客户端上报为已授权**的模板；用户拒绝/拒收时客户端不上报，也就不会落库
 *    ——这就是「未授权不报错、不阻塞业务」；
 * 2. 额度消费（发送段）依赖 H10 的模板 ID 申请，本期不做，见交接文档 D12。
 *
 * 这里**故意不建外键**：台账行本身就是要留证的，`app_wx_user` 是软删，
 * 真删时孤儿行比「删不掉」更有用；另外 drizzle-kit 在 `CREATE TABLE` 里内联
 * 生成的外键会丢掉 `ON DELETE`（全项目只有这里会内联），留着会变成一个
 * 「看起来级联、实际不级联」的坑。
 */
export const appWxSubscribeGrants = mysqlTable(
  'app_wx_subscribe_grant',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    appWxUserId: int('app_wx_user_id', { unsigned: true }).notNull(),
    /** 顾客 ID 快照：授权之后绑定关系可能被换绑，这里留证 */
    customerId: int('customer_id', { unsigned: true }),
    templateId: varchar('template_id', { length: 64 }).notNull(),
    /** 累计授权次数（微信一次性订阅可累积） */
    grantedCount: int('granted_count', { unsigned: true }).default(0).notNull(),
    /** 最近一次授权的关联预约（仅上下文，可为空） */
    lastBookingId: int('last_booking_id', { unsigned: true }),
    grantedAt: datetime('granted_at').notNull(),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('uq_wx_subscribe_grant').on(table.appWxUserId, table.templateId),
    index('idx_wx_subscribe_customer').on(table.customerId),
  ],
);

/**
 * 小程序身份 ↔ 顾客的**绑定留痕**（A14）。
 *
 * 一个 openid 同时只绑一个 `customer_id`（§16.2），换绑就是**覆盖**——旧关系当场消失。
 * 没有这张表就回答不了「这个 openid 昨天绑的是谁」，换绑出错（绑错人 / 恶意换绑）
 * 时无从追溯。所以**只追加不删**：每次绑定/换绑写一行，记下前后两个 customer_id。
 *
 * 手机号照原值存（与 `biz_customer.phone` 一致）：留痕的价值就在可追溯，
 * 脱敏了就查不出「这个号被谁绑过」。
 */
export const appWxUserBindLogs = mysqlTable(
  'app_wx_user_bind_log',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    appWxUserId: int('app_wx_user_id', { unsigned: true }).notNull(),
    /** openid 快照：身份行被软删 / 换绑之后仍要能追溯 */
    openid: varchar('openid', { length: 64 }).notNull(),
    phone: varchar('phone', { length: 20 }),
    /** 换绑前的顾客（首次绑定为 null） */
    customerIdBefore: int('customer_id_before', { unsigned: true }),
    customerIdAfter: int('customer_id_after', { unsigned: true }),
    source: mysqlEnum('source', ['bind_phone']).notNull(),
    ...auditColumns,
  },
  (table) => [
    index('idx_wx_bind_user').on(table.appWxUserId, table.id),
    index('idx_wx_bind_customer').on(table.customerIdAfter),
  ],
);

/* ------------------------------------------------------------------ *
 * C. 支付与账务（§4.5、§17、§18）
 * ------------------------------------------------------------------ */

/** 支付单：一笔预约可有多张 = 混合支付 / 定金 + 尾款 */
export const bizPayments = mysqlTable(
  'biz_payment',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    paymentNo: varchar('payment_no', { length: 32 }).notNull(),
    outTradeNo: varchar('out_trade_no', { length: 64 }).notNull(),
    bookingId: int('booking_id', { unsigned: true }),
    customerId: int('customer_id', { unsigned: true }).notNull(),
    purpose: mysqlEnum('purpose', [
      'deposit',
      'final',
      'recharge',
      'card_buy',
      'credit_settle',
    ]).notNull(),
    channel: mysqlEnum('channel', [
      'wxpay_native',
      'alipay_qr',
      // 小程序 JSAPI（C1）落预支付单用；本期无 provider，见 payments.service.ts 的 PaymentChannel 注释
      'wxpay_jsapi',
      'cash',
      'wechat_offline',
      'alipay_offline',
      'balance',
      'card',
      'credit',
    ]).notNull(),
    amount: int('amount', { unsigned: true }).notNull(),
    receivedAmount: int('received_amount', { unsigned: true })
      .default(0)
      .notNull(),
    status: mysqlEnum('status', [
      'pending',
      'success',
      'failed',
      'closed',
      'refunded',
      'partial_refunded',
    ])
      .default('pending')
      .notNull(),
    codeUrl: varchar('code_url', { length: 512 }),
    transactionId: varchar('transaction_id', { length: 64 }),
    paidAt: datetime('paid_at'),
    expireAt: datetime('expire_at'),
    refundedAmount: int('refunded_amount', { unsigned: true })
      .default(0)
      .notNull(),
    callbackAt: datetime('callback_at'),
    remark: varchar('remark', { length: 200 }),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('uq_payment_no').on(table.paymentNo),
    uniqueIndex('uq_payment_out_trade_no').on(table.outTradeNo),
    index('idx_payment_booking').on(table.bookingId),
    index('idx_payment_customer').on(table.customerId, table.id),
    index('idx_payment_status').on(table.status, table.createdAt),
    index('idx_payment_txn').on(table.transactionId),
    foreignKey({
      columns: [table.bookingId],
      foreignColumns: [bizBookings.id],
      name: 'fk_payment_booking',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.customerId],
      foreignColumns: [bizCustomers.id],
      name: 'fk_payment_customer',
    }).onDelete('restrict'),
  ],
);

/** 支付过程日志（只追加，排障举证） */
export const bizPaymentLogs = mysqlTable(
  'biz_payment_log',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    paymentId: int('payment_id', { unsigned: true }).notNull(),
    event: mysqlEnum('event', [
      'create',
      'callback',
      'query',
      'close',
      'refund',
      'callback_invalid',
    ]).notNull(),
    httpStatus: int('http_status'),
    raw: json('raw'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_payment_log_payment').on(table.paymentId, table.id),
    foreignKey({
      columns: [table.paymentId],
      foreignColumns: [bizPayments.id],
      name: 'fk_payment_log_payment',
    }).onDelete('cascade'),
  ],
);

/** 渠道对账差异（唯一键保证对账任务可重入） */
export const bizPaymentDiffs = mysqlTable(
  'biz_payment_diff',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    billDate: date('bill_date', { mode: 'string' }).notNull(),
    channel: mysqlEnum('channel', ['wxpay_native', 'alipay_qr']).notNull(),
    outTradeNo: varchar('out_trade_no', { length: 64 }),
    transactionId: varchar('transaction_id', { length: 64 }),
    systemAmount: int('system_amount', { unsigned: true }).default(0).notNull(),
    channelAmount: int('channel_amount', { unsigned: true })
      .default(0)
      .notNull(),
    diffType: mysqlEnum('diff_type', [
      'missing_in_system',
      'missing_in_channel',
      'amount_mismatch',
      'status_mismatch',
    ]).notNull(),
    status: mysqlEnum('status', ['pending', 'resolved', 'ignored'])
      .default('pending')
      .notNull(),
    handleBy: int('handle_by', { unsigned: true }),
    handledAt: datetime('handled_at'),
    remark: varchar('remark', { length: 200 }),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('uq_payment_diff').on(
      table.billDate,
      table.channel,
      table.transactionId,
      table.diffType,
    ),
    index('idx_payment_diff_status').on(table.status, table.billDate),
  ],
);

/** 退款单：判责金额 + 申请/审批分离（§17.4） */
export const bizRefunds = mysqlTable(
  'biz_refund',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    refundNo: varchar('refund_no', { length: 32 }).notNull(),
    paymentId: int('payment_id', { unsigned: true }).notNull(),
    bookingId: int('booking_id', { unsigned: true }),
    customerId: int('customer_id', { unsigned: true }).notNull(),
    amount: int('amount', { unsigned: true }).notNull(),
    actualAmount: int('actual_amount', { unsigned: true }).default(0).notNull(),
    deductAmount: int('deduct_amount', { unsigned: true }).default(0).notNull(),
    mode: mysqlEnum('mode', ['original', 'cash', 'balance']).notNull(),
    policyId: int('policy_id', { unsigned: true }),
    liable: mysqlEnum('liable', ['store', 'customer', 'force_majeure'])
      .default('store')
      .notNull(),
    reason: varchar('reason', { length: 200 }).notNull(),
    status: mysqlEnum('status', [
      'pending',
      'approved',
      'rejected',
      'success',
      'failed',
    ])
      .default('pending')
      .notNull(),
    applyBy: int('apply_by', { unsigned: true }).notNull(),
    applyAt: datetime('apply_at').notNull(),
    approveBy: int('approve_by', { unsigned: true }),
    approveAt: datetime('approve_at'),
    rejectReason: varchar('reject_reason', { length: 200 }),
    channelRefundId: varchar('channel_refund_id', { length: 64 }),
    refundedAt: datetime('refunded_at'),
    remark: varchar('remark', { length: 200 }),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('uq_refund_no').on(table.refundNo),
    index('idx_refund_payment').on(table.paymentId),
    index('idx_refund_status').on(table.status, table.createdAt),
    index('idx_refund_booking').on(table.bookingId),
    foreignKey({
      columns: [table.paymentId],
      foreignColumns: [bizPayments.id],
      name: 'fk_refund_payment',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.bookingId],
      foreignColumns: [bizBookings.id],
      name: 'fk_refund_booking',
    }).onDelete('set null'),
  ],
);

/** 退款判责规则：提前 X 小时 → 退 Y‰ */
export const bizRefundPolicies = mysqlTable(
  'biz_refund_policy',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    name: varchar('name', { length: 50 }).notNull(),
    hoursBefore: int('hours_before', { unsigned: true }).notNull(),
    refundPermille: int('refund_permille', { unsigned: true }).notNull(),
    minAmount: int('min_amount', { unsigned: true }).default(0).notNull(),
    status: mysqlEnum('status', ['active', 'disabled'])
      .default('active')
      .notNull(),
    sort: int('sort').default(0).notNull(),
    remark: varchar('remark', { length: 200 }),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('uq_refund_policy_name').on(table.name),
    index('idx_refund_policy_status_sort').on(table.status, table.sort),
  ],
);

/** 挂账主体：额度 0 = 不限，settle_day 0 = 不定期 */
export const bizCreditAccounts = mysqlTable(
  'biz_credit_account',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    name: varchar('name', { length: 50 }).notNull(),
    type: mysqlEnum('type', ['customer', 'company', 'staff']).notNull(),
    customerId: int('customer_id', { unsigned: true }),
    contact: varchar('contact', { length: 50 }),
    phone: varchar('phone', { length: 20 }),
    creditLimit: int('credit_limit', { unsigned: true }).default(0).notNull(),
    usedAmount: int('used_amount', { unsigned: true }).default(0).notNull(),
    settleDay: tinyint('settle_day', { unsigned: true }).default(0).notNull(),
    status: mysqlEnum('status', ['active', 'disabled'])
      .default('active')
      .notNull(),
    remark: varchar('remark', { length: 500 }),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('uq_credit_account_name').on(table.name),
    index('idx_credit_account_type').on(table.type, table.status),
    foreignKey({
      columns: [table.customerId],
      foreignColumns: [bizCustomers.id],
      name: 'fk_credit_account_customer',
    }).onDelete('set null'),
  ],
);

/** 应收单：挂账消费产生，销账时条件更新防超额 */
export const bizReceivables = mysqlTable(
  'biz_receivable',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    receivableNo: varchar('receivable_no', { length: 32 }).notNull(),
    creditAccountId: int('credit_account_id', { unsigned: true }).notNull(),
    bookingId: int('booking_id', { unsigned: true }),
    customerId: int('customer_id', { unsigned: true }),
    amount: int('amount', { unsigned: true }).notNull(),
    settledAmount: int('settled_amount', { unsigned: true })
      .default(0)
      .notNull(),
    dueDate: date('due_date', { mode: 'string' }),
    status: mysqlEnum('status', [
      'open',
      'partial',
      'settled',
      'overdue',
      'cancelled',
    ])
      .default('open')
      .notNull(),
    settledAt: datetime('settled_at'),
    remark: varchar('remark', { length: 200 }),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('uq_receivable_no').on(table.receivableNo),
    index('idx_receivable_account').on(table.creditAccountId, table.status),
    index('idx_receivable_due').on(table.status, table.dueDate),
    foreignKey({
      columns: [table.creditAccountId],
      foreignColumns: [bizCreditAccounts.id],
      name: 'fk_receivable_account',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.bookingId],
      foreignColumns: [bizBookings.id],
      name: 'fk_receivable_booking',
    }).onDelete('set null'),
  ],
);

/** 销账记录（只追加，一笔应收可多次还款） */
export const bizReceivablePayments = mysqlTable(
  'biz_receivable_payment',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    receivableId: int('receivable_id', { unsigned: true }).notNull(),
    amount: int('amount', { unsigned: true }).notNull(),
    payChannel: mysqlEnum('pay_channel', [
      'cash',
      'wechat_offline',
      'alipay_offline',
      'balance',
      'wxpay_native',
      'alipay_qr',
    ]).notNull(),
    paymentId: int('payment_id', { unsigned: true }),
    paidAt: datetime('paid_at').notNull(),
    remark: varchar('remark', { length: 200 }),
    createdBy: int('created_by', { unsigned: true }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_recv_pay_receivable').on(table.receivableId, table.id),
    foreignKey({
      columns: [table.receivableId],
      foreignColumns: [bizReceivables.id],
      name: 'fk_recv_pay_receivable',
    }).onDelete('cascade'),
  ],
);

/* ------------------------------------------------------------------ *
 * D. 运营与配置（§4.6、§19~§22）
 * ------------------------------------------------------------------ */

/** 美甲师可做项目（物理删：整体替换）。空集合 = 可做全部 */
export const bizStaffServiceItems = mysqlTable(
  'biz_staff_service_item',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    staffId: int('staff_id', { unsigned: true }).notNull(),
    serviceItemId: int('service_item_id', { unsigned: true }).notNull(),
    sort: int('sort').default(0).notNull(),
  },
  (table) => [
    uniqueIndex('uq_staff_service_item').on(table.staffId, table.serviceItemId),
    foreignKey({
      columns: [table.staffId],
      foreignColumns: [bizStaffs.id],
      name: 'fk_staff_service_staff',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.serviceItemId],
      foreignColumns: [bizServiceItems.id],
      name: 'fk_staff_service_item',
    }).onDelete('restrict'),
  ],
);

/** 服务评价：一单一评 */
export const bizReviews = mysqlTable(
  'biz_review',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    bookingId: int('booking_id', { unsigned: true }).notNull(),
    customerId: int('customer_id', { unsigned: true }).notNull(),
    staffId: int('staff_id', { unsigned: true }).notNull(),
    score: tinyint('score', { unsigned: true }).notNull(),
    content: varchar('content', { length: 1000 }),
    images: json('images'),
    isPublic: boolean('is_public').default(true).notNull(),
    reply: varchar('reply', { length: 500 }),
    repliedAt: datetime('replied_at'),
    status: mysqlEnum('status', ['published', 'hidden'])
      .default('published')
      .notNull(),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('uq_review_booking').on(table.bookingId),
    index('idx_review_staff').on(table.staffId, table.status, table.id),
    index('idx_review_customer').on(table.customerId, table.id),
    foreignKey({
      columns: [table.bookingId],
      foreignColumns: [bizBookings.id],
      name: 'fk_review_booking',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.staffId],
      foreignColumns: [bizStaffs.id],
      name: 'fk_review_staff',
    }).onDelete('restrict'),
  ],
);

/** 提成规则：优先级 service_item > category > staff */
export const bizCommissionRules = mysqlTable(
  'biz_commission_rule',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    name: varchar('name', { length: 50 }).notNull(),
    scope: mysqlEnum('scope', ['staff', 'category', 'service_item']).notNull(),
    targetId: int('target_id', { unsigned: true }),
    staffId: int('staff_id', { unsigned: true }),
    category: varchar('category', { length: 30 }),
    permille: int('permille', { unsigned: true }).default(0).notNull(),
    fixedAmount: int('fixed_amount', { unsigned: true }).default(0).notNull(),
    base: mysqlEnum('base', ['payable', 'paid', 'original'])
      .default('paid')
      .notNull(),
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    effectiveTo: date('effective_to', { mode: 'string' }),
    status: mysqlEnum('status', ['active', 'disabled'])
      .default('active')
      .notNull(),
    sort: int('sort').default(0).notNull(),
    remark: varchar('remark', { length: 200 }),
    ...auditColumns,
  },
  (table) => [
    index('idx_commission_rule_scope').on(
      table.scope,
      table.status,
      table.sort,
    ),
    index('idx_commission_rule_staff').on(table.staffId),
  ],
);

/** 提成计提记录（只追加，可结算 / 冲销） */
export const bizCommissionRecords = mysqlTable(
  'biz_commission_record',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    bookingId: int('booking_id', { unsigned: true }).notNull(),
    bookingItemId: int('booking_item_id', { unsigned: true }).notNull(),
    staffId: int('staff_id', { unsigned: true }).notNull(),
    ruleId: int('rule_id', { unsigned: true }),
    baseAmount: int('base_amount', { unsigned: true }).notNull(),
    amount: int('amount', { unsigned: true }).notNull(),
    period: char('period', { length: 6 }).notNull(),
    status: mysqlEnum('status', ['accrued', 'settled', 'reversed'])
      .default('accrued')
      .notNull(),
    settledAt: datetime('settled_at'),
    settleBatch: varchar('settle_batch', { length: 32 }),
    remark: varchar('remark', { length: 200 }),
    createdBy: int('created_by', { unsigned: true }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_comm_record_staff_period').on(
      table.staffId,
      table.period,
      table.status,
    ),
    index('idx_comm_record_booking').on(table.bookingId),
    foreignKey({
      columns: [table.bookingId],
      foreignColumns: [bizBookings.id],
      name: 'fk_comm_record_booking',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.bookingItemId],
      foreignColumns: [bizBookingItems.id],
      name: 'fk_comm_record_booking_item',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.staffId],
      foreignColumns: [bizStaffs.id],
      name: 'fk_comm_record_staff',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.ruleId],
      foreignColumns: [bizCommissionRules.id],
      name: 'fk_comm_record_rule',
    }).onDelete('set null'),
  ],
);

/** 周期预约规则：generated_until 是幂等游标 */
export const bizBookingRecurrences = mysqlTable(
  'biz_booking_recurrence',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    name: varchar('name', { length: 50 }),
    customerId: int('customer_id', { unsigned: true }).notNull(),
    staffId: int('staff_id', { unsigned: true }).notNull(),
    serviceItemIds: json('service_item_ids').notNull(),
    weekday: tinyint('weekday', { unsigned: true }).notNull(),
    startTime: time('start_time').notNull(),
    durationMinutes: int('duration_minutes', { unsigned: true }).notNull(),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }),
    generateDays: int('generate_days', { unsigned: true })
      .default(30)
      .notNull(),
    generatedUntil: date('generated_until', { mode: 'string' }),
    status: mysqlEnum('status', ['active', 'paused', 'stopped'])
      .default('active')
      .notNull(),
    lastRunAt: datetime('last_run_at'),
    conflictPolicy: mysqlEnum('conflict_policy', ['skip', 'notify'])
      .default('notify')
      .notNull(),
    remark: varchar('remark', { length: 200 }),
    ...auditColumns,
  },
  (table) => [
    index('idx_recurrence_status').on(table.status, table.generatedUntil),
    index('idx_recurrence_customer').on(table.customerId),
    foreignKey({
      columns: [table.customerId],
      foreignColumns: [bizCustomers.id],
      name: 'fk_recurrence_customer',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.staffId],
      foreignColumns: [bizStaffs.id],
      name: 'fk_recurrence_staff',
    }).onDelete('restrict'),
  ],
);

/** 积分兑换品：兑换即发一张次卡（复用卡种，不引入券体系） */
export const bizPointsGoods = mysqlTable(
  'biz_points_goods',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    name: varchar('name', { length: 50 }).notNull(),
    cardTypeId: int('card_type_id', { unsigned: true }).notNull(),
    points: int('points', { unsigned: true }).notNull(),
    stock: int('stock').default(-1).notNull(),
    perLimit: int('per_limit', { unsigned: true }).default(0).notNull(),
    status: mysqlEnum('status', ['active', 'disabled'])
      .default('active')
      .notNull(),
    sort: int('sort').default(0).notNull(),
    remark: varchar('remark', { length: 200 }),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('uq_points_goods_name').on(table.name),
    index('idx_points_goods_status').on(table.status, table.sort),
    foreignKey({
      columns: [table.cardTypeId],
      foreignColumns: [bizMemberCardTypes.id],
      name: 'fk_points_goods_card_type',
    }).onDelete('restrict'),
  ],
);

/** 积分兑换记录（只追加，可撤销） */
export const bizPointsRedeems = mysqlTable(
  'biz_points_redeem',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    redeemNo: varchar('redeem_no', { length: 32 }).notNull(),
    customerId: int('customer_id', { unsigned: true }).notNull(),
    goodsId: int('goods_id', { unsigned: true }).notNull(),
    points: int('points', { unsigned: true }).notNull(),
    memberCardId: int('member_card_id', { unsigned: true }),
    status: mysqlEnum('status', ['success', 'reverted'])
      .default('success')
      .notNull(),
    remark: varchar('remark', { length: 200 }),
    createdBy: int('created_by', { unsigned: true }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('uq_points_redeem_no').on(table.redeemNo),
    index('idx_points_redeem_customer').on(table.customerId, table.id),
    foreignKey({
      columns: [table.customerId],
      foreignColumns: [bizCustomers.id],
      name: 'fk_points_redeem_customer',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.goodsId],
      foreignColumns: [bizPointsGoods.id],
      name: 'fk_points_redeem_goods',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.memberCardId],
      foreignColumns: [bizMemberCards.id],
      name: 'fk_points_redeem_card',
    }).onDelete('set null'),
  ],
);

/** 通知模板：{变量} 必须都已声明 */
export const sysNoticeTemplates = mysqlTable(
  'sys_notice_template',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    code: varchar('code', { length: 50 }).notNull(),
    name: varchar('name', { length: 50 }).notNull(),
    channel: mysqlEnum('channel', ['sms', 'site', 'both'])
      .default('both')
      .notNull(),
    title: varchar('title', { length: 100 }),
    content: varchar('content', { length: 1000 }).notNull(),
    variables: json('variables'),
    status: mysqlEnum('status', ['active', 'disabled'])
      .default('active')
      .notNull(),
    remark: varchar('remark', { length: 200 }),
    ...auditColumns,
  },
  (table) => [uniqueIndex('uq_notice_template_code').on(table.code)],
);

/** 通知发送日志（只追加，站内消息也存这里） */
export const sysNoticeLogs = mysqlTable(
  'sys_notice_log',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    templateCode: varchar('template_code', { length: 50 }).notNull(),
    channel: mysqlEnum('channel', ['sms', 'site']).notNull(),
    recipientType: mysqlEnum('recipient_type', ['customer', 'user']).notNull(),
    recipientId: int('recipient_id', { unsigned: true }).notNull(),
    phone: varchar('phone', { length: 20 }),
    title: varchar('title', { length: 100 }),
    content: varchar('content', { length: 1000 }).notNull(),
    status: mysqlEnum('status', ['pending', 'success', 'failed', 'skipped'])
      .default('pending')
      .notNull(),
    provider: varchar('provider', { length: 30 }),
    providerMsgId: varchar('provider_msg_id', { length: 64 }),
    error: varchar('error', { length: 500 }),
    retryCount: tinyint('retry_count', { unsigned: true }).default(0).notNull(),
    sentAt: datetime('sent_at'),
    readAt: datetime('read_at'),
    bookingId: int('booking_id', { unsigned: true }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_notice_log_status').on(table.status, table.retryCount, table.id),
    index('idx_notice_log_recipient').on(
      table.recipientType,
      table.recipientId,
      table.id,
    ),
    index('idx_notice_log_booking').on(table.bookingId),
  ],
);

export const relations = defineRelations(
  {
    departments,
    users,
    roles,
    menus,
    userRoles,
    roleMenus,
    roleDepts,
    posts,
    userPosts,
    refreshTokens,
    dictionaries,
    dictTypes,
    configs,
    operationLogs,
    loginLogs,
    jobs,
    jobLogs,
    files,
    aiSessions,
    aiMessages,
    aiAuditLogs,
    aiActionIntents,
    aiApprovals,
    aiTasks,
    aiTaskSteps,
    bizServiceItems,
    bizStaffs,
    bizStaffWeeklyShifts,
    bizStaffScheduleOverrides,
    bizCustomers,
    bizBookings,
    bizBookingItems,
    bizMemberLevels,
    bizRechargePlans,
    bizMemberCardTypes,
    bizMemberCardTypeItems,
    bizMemberCards,
    bizMemberCardLogs,
    bizMemberTransactions,
    bizPayments,
    bizPaymentLogs,
    bizPaymentDiffs,
    bizRefunds,
    bizRefundPolicies,
    bizCreditAccounts,
    bizReceivables,
    bizReceivablePayments,
    bizStaffServiceItems,
    bizReviews,
    bizCommissionRules,
    bizCommissionRecords,
    bizBookingRecurrences,
    bizPointsGoods,
    bizPointsRedeems,
    sysNoticeTemplates,
    sysNoticeLogs,
    appWxUsers,
    appWxSubscribeGrants,
    appWxUserBindLogs,
  },
  ({
    departments,
    users,
    roles,
    menus,
    userRoles,
    roleMenus,
    roleDepts,
    posts,
    userPosts,
    refreshTokens,
    aiSessions,
    aiMessages,
    aiAuditLogs,
    aiActionIntents,
    aiApprovals,
    aiTasks,
    aiTaskSteps,
    bizServiceItems,
    bizStaffs,
    bizStaffWeeklyShifts,
    bizStaffScheduleOverrides,
    bizCustomers,
    bizBookings,
    bizBookingItems,
    bizMemberLevels,
    bizRechargePlans,
    bizMemberCardTypes,
    bizMemberCardTypeItems,
    bizMemberCards,
    bizMemberCardLogs,
    bizMemberTransactions,
    bizPayments,
    bizPaymentLogs,
    bizPaymentDiffs,
    bizRefunds,
    bizRefundPolicies,
    bizCreditAccounts,
    bizReceivables,
    bizReceivablePayments,
    bizStaffServiceItems,
    bizReviews,
    bizCommissionRules,
    bizCommissionRecords,
    bizBookingRecurrences,
    bizPointsGoods,
    bizPointsRedeems,
    sysNoticeTemplates,
    sysNoticeLogs,
    appWxUsers,
    appWxSubscribeGrants,
    appWxUserBindLogs,
    one,
    many,
  }) => ({
    // 这些表本期只需要注册（保证 db.query.* 可用），没有关系查询需求；
    // 显式引用一次，避免「解构未使用」被判为 lint 错误。
    ...(() => {
      void bizPaymentDiffs;
      void sysNoticeTemplates;
      void sysNoticeLogs;
      void appWxSubscribeGrants;
      void appWxUserBindLogs;
      return {};
    })(),
    users: {
      department: one.departments({
        from: users.deptId,
        to: departments.id,
      }),
      assignments: many.userRoles({
        from: users.id,
        to: userRoles.userId,
      }),
      refreshTokens: many.refreshTokens({
        from: users.id,
        to: refreshTokens.userId,
      }),
    },
    roles: {
      assignments: many.userRoles({
        from: roles.id,
        to: userRoles.roleId,
      }),
      menuAssignments: many.roleMenus({
        from: roles.id,
        to: roleMenus.roleId,
      }),
      deptAssignments: many.roleDepts({
        from: roles.id,
        to: roleDepts.roleId,
      }),
    },
    userRoles: {
      user: one.users({ from: userRoles.userId, to: users.id }),
      role: one.roles({ from: userRoles.roleId, to: roles.id }),
    },
    roleMenus: {
      role: one.roles({ from: roleMenus.roleId, to: roles.id }),
      menu: one.menus({ from: roleMenus.menuId, to: menus.id }),
    },
    roleDepts: {
      role: one.roles({ from: roleDepts.roleId, to: roles.id }),
      department: one.departments({
        from: roleDepts.deptId,
        to: departments.id,
      }),
    },
    posts: {
      assignments: many.userPosts({
        from: posts.id,
        to: userPosts.postId,
      }),
    },
    userPosts: {
      user: one.users({ from: userPosts.userId, to: users.id }),
      post: one.posts({ from: userPosts.postId, to: posts.id }),
    },
    aiSessions: {
      user: one.users({ from: aiSessions.userId, to: users.id }),
      messages: many.aiMessages({
        from: aiSessions.id,
        to: aiMessages.sessionId,
      }),
    },
    aiMessages: {
      session: one.aiSessions({
        from: aiMessages.sessionId,
        to: aiSessions.id,
      }),
    },
    aiAuditLogs: {
      user: one.users({ from: aiAuditLogs.userId, to: users.id }),
      session: one.aiSessions({
        from: aiAuditLogs.sessionId,
        to: aiSessions.id,
      }),
    },
    aiActionIntents: {
      user: one.users({ from: aiActionIntents.userId, to: users.id }),
      session: one.aiSessions({
        from: aiActionIntents.sessionId,
        to: aiSessions.id,
      }),
      approvals: many.aiApprovals({
        from: aiActionIntents.id,
        to: aiApprovals.actionIntentId,
      }),
    },
    aiApprovals: {
      intent: one.aiActionIntents({
        from: aiApprovals.actionIntentId,
        to: aiActionIntents.id,
      }),
      approver: one.users({
        from: aiApprovals.approverId,
        to: users.id,
      }),
    },
    aiTasks: {
      user: one.users({ from: aiTasks.userId, to: users.id }),
      session: one.aiSessions({
        from: aiTasks.sessionId,
        to: aiSessions.id,
      }),
      steps: many.aiTaskSteps({
        from: aiTasks.id,
        to: aiTaskSteps.taskId,
      }),
    },
    aiTaskSteps: {
      task: one.aiTasks({
        from: aiTaskSteps.taskId,
        to: aiTasks.id,
      }),
    },
    bizServiceItems: {
      staffAssignments: many.bizStaffServiceItems({
        from: bizServiceItems.id,
        to: bizStaffServiceItems.serviceItemId,
      }),
      bookingItems: many.bizBookingItems({
        from: bizServiceItems.id,
        to: bizBookingItems.serviceItemId,
      }),
    },
    bizStaffs: {
      user: one.users({ from: bizStaffs.userId, to: users.id }),
      weeklyShifts: many.bizStaffWeeklyShifts({
        from: bizStaffs.id,
        to: bizStaffWeeklyShifts.staffId,
      }),
      scheduleOverrides: many.bizStaffScheduleOverrides({
        from: bizStaffs.id,
        to: bizStaffScheduleOverrides.staffId,
      }),
      serviceItems: many.bizStaffServiceItems({
        from: bizStaffs.id,
        to: bizStaffServiceItems.staffId,
      }),
      bookings: many.bizBookings({
        from: bizStaffs.id,
        to: bizBookings.staffId,
      }),
    },
    bizStaffWeeklyShifts: {
      staff: one.bizStaffs({
        from: bizStaffWeeklyShifts.staffId,
        to: bizStaffs.id,
      }),
    },
    bizStaffScheduleOverrides: {
      staff: one.bizStaffs({
        from: bizStaffScheduleOverrides.staffId,
        to: bizStaffs.id,
      }),
    },
    bizCustomers: {
      level: one.bizMemberLevels({
        from: bizCustomers.levelId,
        to: bizMemberLevels.id,
      }),
      bookings: many.bizBookings({
        from: bizCustomers.id,
        to: bizBookings.customerId,
      }),
      transactions: many.bizMemberTransactions({
        from: bizCustomers.id,
        to: bizMemberTransactions.customerId,
      }),
      cards: many.bizMemberCards({
        from: bizCustomers.id,
        to: bizMemberCards.customerId,
      }),
      wxUsers: many.appWxUsers({
        from: bizCustomers.id,
        to: appWxUsers.customerId,
      }),
    },
    bizBookings: {
      customer: one.bizCustomers({
        from: bizBookings.customerId,
        to: bizCustomers.id,
      }),
      staff: one.bizStaffs({
        from: bizBookings.staffId,
        to: bizStaffs.id,
      }),
      items: many.bizBookingItems({
        from: bizBookings.id,
        to: bizBookingItems.bookingId,
      }),
      payments: many.bizPayments({
        from: bizBookings.id,
        to: bizPayments.bookingId,
      }),
      receivable: one.bizReceivables({
        from: bizBookings.id,
        to: bizReceivables.bookingId,
      }),
      review: one.bizReviews({
        from: bizBookings.id,
        to: bizReviews.bookingId,
      }),
      recurrence: one.bizBookingRecurrences({
        from: bizBookings.recurrenceId,
        to: bizBookingRecurrences.id,
      }),
    },
    bizBookingItems: {
      booking: one.bizBookings({
        from: bizBookingItems.bookingId,
        to: bizBookings.id,
      }),
      serviceItem: one.bizServiceItems({
        from: bizBookingItems.serviceItemId,
        to: bizServiceItems.id,
      }),
      commissionRecords: many.bizCommissionRecords({
        from: bizBookingItems.id,
        to: bizCommissionRecords.bookingItemId,
      }),
    },
    bizMemberLevels: {
      customers: many.bizCustomers({
        from: bizMemberLevels.id,
        to: bizCustomers.levelId,
      }),
    },
    bizRechargePlans: {
      transactions: many.bizMemberTransactions({
        from: bizRechargePlans.id,
        to: bizMemberTransactions.planId,
      }),
    },
    bizMemberCardTypes: {
      serviceItems: many.bizMemberCardTypeItems({
        from: bizMemberCardTypes.id,
        to: bizMemberCardTypeItems.cardTypeId,
      }),
      cards: many.bizMemberCards({
        from: bizMemberCardTypes.id,
        to: bizMemberCards.cardTypeId,
      }),
      pointsGoods: many.bizPointsGoods({
        from: bizMemberCardTypes.id,
        to: bizPointsGoods.cardTypeId,
      }),
    },
    bizMemberCardTypeItems: {
      cardType: one.bizMemberCardTypes({
        from: bizMemberCardTypeItems.cardTypeId,
        to: bizMemberCardTypes.id,
      }),
      serviceItem: one.bizServiceItems({
        from: bizMemberCardTypeItems.serviceItemId,
        to: bizServiceItems.id,
      }),
    },
    bizMemberCards: {
      customer: one.bizCustomers({
        from: bizMemberCards.customerId,
        to: bizCustomers.id,
      }),
      cardType: one.bizMemberCardTypes({
        from: bizMemberCards.cardTypeId,
        to: bizMemberCardTypes.id,
      }),
      logs: many.bizMemberCardLogs({
        from: bizMemberCards.id,
        to: bizMemberCardLogs.cardId,
      }),
    },
    bizMemberCardLogs: {
      card: one.bizMemberCards({
        from: bizMemberCardLogs.cardId,
        to: bizMemberCards.id,
      }),
      booking: one.bizBookings({
        from: bizMemberCardLogs.bookingId,
        to: bizBookings.id,
      }),
    },
    bizMemberTransactions: {
      customer: one.bizCustomers({
        from: bizMemberTransactions.customerId,
        to: bizCustomers.id,
      }),
      booking: one.bizBookings({
        from: bizMemberTransactions.bookingId,
        to: bizBookings.id,
      }),
      card: one.bizMemberCards({
        from: bizMemberTransactions.cardId,
        to: bizMemberCards.id,
      }),
      plan: one.bizRechargePlans({
        from: bizMemberTransactions.planId,
        to: bizRechargePlans.id,
      }),
    },
    bizPayments: {
      booking: one.bizBookings({
        from: bizPayments.bookingId,
        to: bizBookings.id,
      }),
      customer: one.bizCustomers({
        from: bizPayments.customerId,
        to: bizCustomers.id,
      }),
      logs: many.bizPaymentLogs({
        from: bizPayments.id,
        to: bizPaymentLogs.paymentId,
      }),
      refunds: many.bizRefunds({
        from: bizPayments.id,
        to: bizRefunds.paymentId,
      }),
    },
    bizPaymentLogs: {
      payment: one.bizPayments({
        from: bizPaymentLogs.paymentId,
        to: bizPayments.id,
      }),
    },
    bizRefunds: {
      payment: one.bizPayments({
        from: bizRefunds.paymentId,
        to: bizPayments.id,
      }),
      booking: one.bizBookings({
        from: bizRefunds.bookingId,
        to: bizBookings.id,
      }),
      policy: one.bizRefundPolicies({
        from: bizRefunds.policyId,
        to: bizRefundPolicies.id,
      }),
    },
    bizRefundPolicies: {
      refunds: many.bizRefunds({
        from: bizRefundPolicies.id,
        to: bizRefunds.policyId,
      }),
    },
    bizCreditAccounts: {
      customer: one.bizCustomers({
        from: bizCreditAccounts.customerId,
        to: bizCustomers.id,
      }),
      receivables: many.bizReceivables({
        from: bizCreditAccounts.id,
        to: bizReceivables.creditAccountId,
      }),
    },
    bizReceivables: {
      account: one.bizCreditAccounts({
        from: bizReceivables.creditAccountId,
        to: bizCreditAccounts.id,
      }),
      booking: one.bizBookings({
        from: bizReceivables.bookingId,
        to: bizBookings.id,
      }),
      payments: many.bizReceivablePayments({
        from: bizReceivables.id,
        to: bizReceivablePayments.receivableId,
      }),
    },
    bizReceivablePayments: {
      receivable: one.bizReceivables({
        from: bizReceivablePayments.receivableId,
        to: bizReceivables.id,
      }),
    },
    bizStaffServiceItems: {
      staff: one.bizStaffs({
        from: bizStaffServiceItems.staffId,
        to: bizStaffs.id,
      }),
      serviceItem: one.bizServiceItems({
        from: bizStaffServiceItems.serviceItemId,
        to: bizServiceItems.id,
      }),
    },
    bizReviews: {
      booking: one.bizBookings({
        from: bizReviews.bookingId,
        to: bizBookings.id,
      }),
      customer: one.bizCustomers({
        from: bizReviews.customerId,
        to: bizCustomers.id,
      }),
      staff: one.bizStaffs({
        from: bizReviews.staffId,
        to: bizStaffs.id,
      }),
    },
    bizCommissionRules: {
      records: many.bizCommissionRecords({
        from: bizCommissionRules.id,
        to: bizCommissionRecords.ruleId,
      }),
    },
    bizCommissionRecords: {
      booking: one.bizBookings({
        from: bizCommissionRecords.bookingId,
        to: bizBookings.id,
      }),
      bookingItem: one.bizBookingItems({
        from: bizCommissionRecords.bookingItemId,
        to: bizBookingItems.id,
      }),
      staff: one.bizStaffs({
        from: bizCommissionRecords.staffId,
        to: bizStaffs.id,
      }),
      rule: one.bizCommissionRules({
        from: bizCommissionRecords.ruleId,
        to: bizCommissionRules.id,
      }),
    },
    bizBookingRecurrences: {
      customer: one.bizCustomers({
        from: bizBookingRecurrences.customerId,
        to: bizCustomers.id,
      }),
      staff: one.bizStaffs({
        from: bizBookingRecurrences.staffId,
        to: bizStaffs.id,
      }),
      bookings: many.bizBookings({
        from: bizBookingRecurrences.id,
        to: bizBookings.recurrenceId,
      }),
    },
    bizPointsGoods: {
      cardType: one.bizMemberCardTypes({
        from: bizPointsGoods.cardTypeId,
        to: bizMemberCardTypes.id,
      }),
      redeems: many.bizPointsRedeems({
        from: bizPointsGoods.id,
        to: bizPointsRedeems.goodsId,
      }),
    },
    bizPointsRedeems: {
      customer: one.bizCustomers({
        from: bizPointsRedeems.customerId,
        to: bizCustomers.id,
      }),
      goods: one.bizPointsGoods({
        from: bizPointsRedeems.goodsId,
        to: bizPointsGoods.id,
      }),
      memberCard: one.bizMemberCards({
        from: bizPointsRedeems.memberCardId,
        to: bizMemberCards.id,
      }),
    },
    appWxUsers: {
      customer: one.bizCustomers({
        from: appWxUsers.customerId,
        to: bizCustomers.id,
      }),
    },
  }),
);

/* ------------------------------------------------------------------ *
 * 优惠券（本目标新增）
 *
 * 设计口径（写下来免得以后被"顺手"改坏）：
 * 1. 首期只做「满 X 减 Y」固定面额券，不做折扣券/品类券 —— 先把生命周期做对；
 * 2. 算价位置：**等级折扣之后、积分抵扣之前**；**与积分同一单二选一**
 *    （避免抵到 0 元与核销口径混乱）；
 * 3. 核销闸门：`used_booking_id` **唯一索引** + 条件更新
 *    （`WHERE id=? AND status='usable' AND used_booking_id IS NULL`），
 *    `affectedRows=0` 即拒绝 —— 这是防「一券多用」唯一可靠的做法；
 * 4. 面额与门槛在下发时**快照**到持有行，模板改价不影响已发出的券。
 * ------------------------------------------------------------------ */

/** 优惠券模板（后台维护） */
export const bizCouponTemplates = mysqlTable(
  'biz_coupon_template',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    name: varchar('name', { length: 50 }).notNull(),
    /** 使用门槛（分）；0 = 无门槛 */
    thresholdAmount: int('threshold_amount', { unsigned: true })
      .default(0)
      .notNull(),
    /** 面额（分） */
    discountAmount: int('discount_amount', { unsigned: true }).notNull(),
    /** 领取后有效天数；0 = 用 valid_from / valid_to 的绝对区间 */
    validDays: int('valid_days', { unsigned: true }).default(0).notNull(),
    validFrom: timestamp('valid_from'),
    validTo: timestamp('valid_to'),
    status: mysqlEnum('status', ['active', 'disabled'])
      .default('active')
      .notNull(),
    sort: int('sort').default(0).notNull(),
    remark: varchar('remark', { length: 200 }),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('uq_coupon_template_name').on(table.name),
    index('idx_coupon_template_status').on(table.status, table.sort),
  ],
);

/** 顾客持有的券（发放 → 使用 → 过期） */
export const bizCustomerCoupons = mysqlTable(
  'biz_customer_coupon',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    couponNo: varchar('coupon_no', { length: 32 }).notNull(),
    customerId: int('customer_id', { unsigned: true }).notNull(),
    templateId: int('template_id', { unsigned: true }).notNull(),
    /** 下发时的面额快照（分） */
    discountAmount: int('discount_amount', { unsigned: true }).notNull(),
    /** 下发时的门槛快照（分） */
    thresholdAmount: int('threshold_amount', { unsigned: true })
      .default(0)
      .notNull(),
    status: mysqlEnum('status', ['usable', 'used', 'expired', 'void'])
      .default('usable')
      .notNull(),
    expireAt: timestamp('expire_at'),
    /** 核销到哪一单；唯一索引保证「一张券只核销一单、一单只用一张券」 */
    usedBookingId: int('used_booking_id', { unsigned: true }),
    usedAt: timestamp('used_at'),
    source: varchar('source', { length: 30 }).default('manual').notNull(),
    remark: varchar('remark', { length: 200 }),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('uq_customer_coupon_no').on(table.couponNo),
    // 一单只允许核销一张券：唯一索引兜底（未使用的券 used_booking_id 为 NULL，
    // MySQL 唯一索引允许多个 NULL，所以不影响它们）
    uniqueIndex('uq_customer_coupon_booking').on(table.usedBookingId),
    index('idx_customer_coupon_owner').on(
      table.customerId,
      table.status,
      table.expireAt,
    ),
    foreignKey({
      columns: [table.customerId],
      foreignColumns: [bizCustomers.id],
      name: 'fk_customer_coupon_customer',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.templateId],
      foreignColumns: [bizCouponTemplates.id],
      name: 'fk_customer_coupon_template',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.usedBookingId],
      foreignColumns: [bizBookings.id],
      name: 'fk_customer_coupon_booking',
    }).onDelete('set null'),
  ],
);
