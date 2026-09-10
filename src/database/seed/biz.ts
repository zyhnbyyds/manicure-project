import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import {
  BIZ_CONFIG_DEFAULTS,
  BIZ_CONFIG_LABELS,
} from '../../modules/biz/common/biz-config.service.js';
import {
  bizMemberLevels,
  bizRefundPolicies,
  configs,
  jobs,
  sysNoticeTemplates,
} from '../schema/index';

/**
 * 业务初始数据 seed（§11 / §15.8 / §17.4 / §19）
 * 运行：`bun run db:seed:biz` 或 `bun src/database/seed/biz.ts`
 *
 * 逐项幂等；已经存在的行**一律跳过**，绝不覆盖运营改过的值：
 * - `sys_config`        按 `config_key` 唯一
 * - `biz_member_level`  按 `name` 唯一
 * - `biz_refund_policy` 按 `name` 唯一
 * - `sys_notice_template` 按 `code` 唯一
 * - `sys_job`           按 `handler` 唯一
 */

/* ------------------------------------------------------------------ *
 * 1) sys_config 默认值（`BIZ_CONFIG_DEFAULTS` 是唯一事实来源）
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 2) 默认会员等级（§15.2）
 * ------------------------------------------------------------------ */

type MemberLevelSeed = {
  name: string;
  discountPermille: number;
  /** 升级门槛，单位「分」（§15.8 金额一律整数分） */
  upgradeAmount: number;
  sort: number;
  remark: string;
};

const MEMBER_LEVEL_SEEDS: MemberLevelSeed[] = [
  {
    name: '银卡',
    discountPermille: 1000,
    upgradeAmount: 0,
    sort: 1,
    remark: '默认等级，无折扣（1000‰ = 不打折）',
  },
  {
    name: '金卡',
    discountPermille: 950,
    upgradeAmount: 50000,
    sort: 2,
    remark: '累计消费满 ¥500 升级，95 折',
  },
  {
    name: '钻卡',
    discountPermille: 880,
    upgradeAmount: 200000,
    sort: 3,
    remark: '累计消费满 ¥2000 升级，88 折',
  },
];

/* ------------------------------------------------------------------ *
 * 3) 退款判责规则（§17.4 默认档位：≥24h 全退 / 24h~2h 退 50% / <2h 或爽约不退）
 * ------------------------------------------------------------------ */

type RefundPolicySeed = {
  name: string;
  hoursBefore: number;
  refundPermille: number;
  minAmount: number;
  sort: number;
  remark: string;
};

const REFUND_POLICY_SEEDS: RefundPolicySeed[] = [
  {
    name: '24 小时以上全退',
    hoursBefore: 24,
    refundPermille: 1000,
    minAmount: 0,
    sort: 1,
    remark: '提前 ≥24 小时取消：全额退款',
  },
  {
    name: '2-24 小时退一半',
    hoursBefore: 2,
    refundPermille: 500,
    minAmount: 0,
    sort: 2,
    remark: '提前 2~24 小时取消：退 50%',
  },
  {
    name: '2 小时内不退',
    hoursBefore: 0,
    refundPermille: 0,
    minAmount: 0,
    sort: 3,
    remark: '提前 <2 小时取消或爽约：不退（规则只给建议，店长审批可改）',
  },
];

/* ------------------------------------------------------------------ *
 * 4) 通知模板（§19）
 * ------------------------------------------------------------------ */

/** 模板变量：name 用于 `{name}` 占位替换，label 供模板编辑页展示 */
type NoticeVariable = { name: string; label: string };

const VAR_LABELS: Record<string, string> = {
  shopName: '门店名称',
  customerName: '顾客姓名',
  bookingDate: '预约日期',
  bookingTime: '预约时间',
  staffName: '美甲师',
  amount: '金额（元）',
  points: '积分',
  dueAmount: '待付尾款（元）',
  cancelReason: '取消原因',
};

function vars(...names: string[]): NoticeVariable[] {
  return names.map((name) => ({
    name,
    label: VAR_LABELS[name] ?? name,
  }));
}

type NoticeTemplateSeed = {
  code: string;
  name: string;
  channel: 'sms' | 'site' | 'both';
  title: string;
  content: string;
  variables: NoticeVariable[];
  remark: string;
};

const NOTICE_TEMPLATE_SEEDS: NoticeTemplateSeed[] = [
  {
    code: 'booking_created',
    name: '预约成功通知',
    channel: 'both',
    title: '预约成功',
    content:
      '{customerName}您好，您在{shopName}的预约已确认：{bookingDate} {bookingTime}，美甲师{staffName}。请准时到店，如需改期请提前联系门店。',
    variables: vars(
      'customerName',
      'shopName',
      'bookingDate',
      'bookingTime',
      'staffName',
    ),
    remark: '预约创建成功后发送（§19.2）',
  },
  {
    code: 'booking_remind',
    name: '到店提醒',
    channel: 'both',
    title: '预约提醒',
    content:
      '{customerName}您好，提醒您明天 {bookingTime} 在{shopName}有预约（美甲师{staffName}），请准时到店。',
    variables: vars('customerName', 'shopName', 'bookingTime', 'staffName'),
    remark: '次日预约提醒，由 sendBookingReminders 定时任务发送（§11）',
  },
  {
    code: 'booking_cancelled',
    name: '取消通知',
    channel: 'both',
    title: '预约已取消',
    content:
      '{customerName}您好，您 {bookingDate} {bookingTime} 在{shopName}的预约已取消。原因：{cancelReason}。如需重新预约请随时联系门店。',
    variables: vars(
      'customerName',
      'bookingDate',
      'bookingTime',
      'shopName',
      'cancelReason',
    ),
    remark: '预约取消 / 美甲师请假导致取消时发送',
  },
  {
    code: 'booking_completed',
    name: '完成致谢与评价邀请',
    channel: 'both',
    title: '服务完成，欢迎评价',
    content:
      '{customerName}您好，感谢光临{shopName}，本次消费 {amount} 元，累计获得 {points} 积分。期待您对美甲师{staffName}的服务做出评价。',
    variables: vars(
      'customerName',
      'shopName',
      'amount',
      'points',
      'staffName',
    ),
    remark: '预约完成（completed）后发送，附带评价邀请（§20.1）',
  },
  {
    code: 'member_recharged',
    name: '充值成功通知',
    channel: 'both',
    title: '充值成功',
    content:
      '{customerName}您好，您的会员账户充值成功，本次实付 {amount} 元已到账{shopName}。感谢您的信任，赠送金额不可退、余额不可提现。',
    variables: vars('customerName', 'shopName', 'amount'),
    remark: '储值充值成功后发送（§15.4）',
  },
  {
    code: 'tail_payment_remind',
    name: '尾款提醒',
    channel: 'sms',
    title: '尾款待支付提醒',
    content:
      '{customerName}您好，您在{shopName}的预约（{bookingDate} {bookingTime}）尚有尾款 {dueAmount} 元待支付，请到店后完成支付。',
    variables: vars(
      'customerName',
      'shopName',
      'bookingDate',
      'bookingTime',
      'dueAmount',
    ),
    remark: '定金不足、到店后需补尾款时发送（§17.2）',
  },
];

/* ------------------------------------------------------------------ *
 * 5) 定时任务（§11，handler 与 cron 逐字照 spec；cron 为 6 段式，不用 Quartz 的 `?`）
 * ------------------------------------------------------------------ */

type JobSeed = {
  name: string;
  handler: string;
  cron: string;
  remark: string;
};

const JOB_SEEDS: JobSeed[] = [
  {
    name: '自动完成已到店预约',
    handler: 'autoCompleteExpiredBookings',
    cron: '0 */10 * * * *',
    remark:
      'arrived 且 end_at < now → completed，累加顾客到店统计（条件更新保证幂等）',
  },
  {
    name: '自动标记爽约',
    handler: 'autoNoShowBookings',
    cron: '0 */10 * * * *',
    remark: 'confirmed 且 start_at + noShowGraceMinutes < now → no_show',
  },
  {
    name: '次卡到期处理',
    handler: 'expireMemberCards',
    cron: '0 5 0 * * *',
    remark: 'active 且 expire_at < now → expired',
  },
  {
    name: '会员等级重算',
    handler: 'recountMemberLevels',
    cron: '0 30 3 * * *',
    remark: '按 total_spent 重算 level_id（幂等，修正历史 / 手工改级）',
  },
  {
    name: '在线支付超时关单',
    handler: 'closeExpiredPayments',
    cron: '0 * * * * *',
    remark: 'pending 且 expire_at < now → closed',
  },
  {
    name: '在线支付主动查单',
    handler: 'queryPendingPayments',
    cron: '0 */2 * * * *',
    remark: '对未过期的在线支付单主动查单，回调丢失时兜底并补记支付',
  },
  {
    name: '支付渠道对账',
    handler: 'reconcilePayments',
    cron: '0 30 6 * * *',
    remark:
      '拉取前一天渠道账单逐笔比对，写 biz_payment_diff（唯一键保证可重入）',
  },
  {
    name: '应收逾期标记',
    handler: 'markOverdueReceivables',
    cron: '0 10 1 * * *',
    remark: "status IN ('open','partial') 且 due_date < today → overdue",
  },
  {
    name: '预约到店提醒',
    handler: 'sendBookingReminders',
    cron: '0 0 18 * * *',
    remark: '次日预约提醒通知（短信 / 站内）',
  },
  {
    name: '通知失败重试',
    handler: 'retryFailedNotices',
    cron: '0 */5 * * * *',
    remark: "status='failed' 且 retry_count < biz.notice.retryLimit → 重试发送",
  },
  {
    name: '周期预约滚动生成',
    handler: 'generateRecurringBookings',
    cron: '0 15 3 * * *',
    remark: '按 generated_until 游标 + 唯一约束保证幂等（§5.9）',
  },
];

/* ------------------------------------------------------------------ *
 * 写入实现
 * ------------------------------------------------------------------ */

type Db = ReturnType<typeof drizzle>;
type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];
type DbLike = Db | DbTx;

/** `BIZ_CONFIG_LABELS` 缺 key 时回落 key 本身，保证 `sys_config.name` 非空 */
function configLabel(key: string): string {
  const label = BIZ_CONFIG_LABELS[key];
  return label && label.length > 0 ? label : key;
}

type SeedStat = { table: string; inserted: number; skipped: number };

/** sys_config 默认值：已存在同 key 一律跳过（不覆盖运营改动过的值） */
async function seedBizConfigs(db: DbLike): Promise<SeedStat> {
  const existing = await db.select({ key: configs.key }).from(configs);
  const known = new Set(existing.map((row) => row.key));

  const pending = Object.entries(BIZ_CONFIG_DEFAULTS).filter(
    ([key]) => !known.has(key),
  );
  if (pending.length > 0) {
    await db.insert(configs).values(
      pending.map(([key, value]) => ({
        name: configLabel(key),
        key,
        value,
        builtin: true,
        remark: '美甲预约系统默认配置（§15.8）',
      })),
    );
  }

  return {
    table: 'sys_config',
    inserted: pending.length,
    skipped: known.size,
  };
}

/** 默认会员等级：按 name 唯一，已存在则跳过 */
async function seedMemberLevels(db: DbLike): Promise<SeedStat> {
  const existing = await db
    .select({ name: bizMemberLevels.name })
    .from(bizMemberLevels);
  const known = new Set(existing.map((row) => row.name));

  const pending = MEMBER_LEVEL_SEEDS.filter((row) => !known.has(row.name));
  if (pending.length > 0) {
    await db.insert(bizMemberLevels).values(
      pending.map((row) => ({
        name: row.name,
        discountPermille: row.discountPermille,
        upgradeAmount: row.upgradeAmount,
        sort: row.sort,
        status: 'active' as const,
        remark: row.remark,
      })),
    );
  }

  return {
    table: 'biz_member_level',
    inserted: pending.length,
    skipped: MEMBER_LEVEL_SEEDS.length - pending.length,
  };
}

/** 退款判责规则：按 name 唯一，已存在则跳过 */
async function seedRefundPolicies(db: DbLike): Promise<SeedStat> {
  const existing = await db
    .select({ name: bizRefundPolicies.name })
    .from(bizRefundPolicies);
  const known = new Set(existing.map((row) => row.name));

  const pending = REFUND_POLICY_SEEDS.filter((row) => !known.has(row.name));
  if (pending.length > 0) {
    await db.insert(bizRefundPolicies).values(
      pending.map((row) => ({
        name: row.name,
        hoursBefore: row.hoursBefore,
        refundPermille: row.refundPermille,
        minAmount: row.minAmount,
        status: 'active' as const,
        sort: row.sort,
        remark: row.remark,
      })),
    );
  }

  return {
    table: 'biz_refund_policy',
    inserted: pending.length,
    skipped: REFUND_POLICY_SEEDS.length - pending.length,
  };
}

/** 通知模板：按 code 唯一，已存在则跳过 */
async function seedNoticeTemplates(db: DbLike): Promise<SeedStat> {
  const existing = await db
    .select({ code: sysNoticeTemplates.code })
    .from(sysNoticeTemplates);
  const known = new Set(existing.map((row) => row.code));

  const pending = NOTICE_TEMPLATE_SEEDS.filter((row) => !known.has(row.code));
  if (pending.length > 0) {
    await db.insert(sysNoticeTemplates).values(
      pending.map((row) => ({
        code: row.code,
        name: row.name,
        channel: row.channel,
        title: row.title,
        content: row.content,
        variables: row.variables,
        status: 'active' as const,
        remark: row.remark,
      })),
    );
  }

  return {
    table: 'sys_notice_template',
    inserted: pending.length,
    skipped: NOTICE_TEMPLATE_SEEDS.length - pending.length,
  };
}

/** 定时任务：按 handler 唯一；concurrent=false 防重入 */
async function seedJobs(db: DbLike): Promise<SeedStat> {
  const existing = await db.select({ handler: jobs.handler }).from(jobs);
  const known = new Set(existing.map((row) => row.handler));

  const pending = JOB_SEEDS.filter((row) => !known.has(row.handler));
  if (pending.length > 0) {
    await db.insert(jobs).values(
      pending.map((row) => ({
        name: row.name,
        handler: row.handler,
        cron: row.cron,
        status: 'active' as const,
        // 防重入：同一任务上一次没跑完就不再起新的（§11）
        concurrent: false,
        remark: row.remark,
      })),
    );
  }

  return {
    table: 'sys_job',
    inserted: pending.length,
    skipped: JOB_SEEDS.length - pending.length,
  };
}

/**
 * 写入美甲预约的业务初始数据。
 *
 * - 默认自行建连并结束（供 `bun run db:seed:biz` / 直接 `bun src/database/seed/biz.ts`）。
 * - 传入 `pool` 时复用调用方的连接池（供 `seed/index.ts` 串联调用），不会 `end()` 掉别人的池。
 */
export async function seedBiz(pool?: mysql.Pool): Promise<void> {
  const url = Bun.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const owned = !pool;
  const target = pool ?? mysql.createPool(url);
  const db = drizzle({ client: target });

  try {
    let stats: SeedStat[] = [];
    await db.transaction(async (tx) => {
      stats = [
        await seedBizConfigs(tx),
        await seedMemberLevels(tx),
        await seedRefundPolicies(tx),
        await seedNoticeTemplates(tx),
        await seedJobs(tx),
      ];
    });

    for (const stat of stats) {
      console.log(
        `[seed:biz] ${stat.table} inserted=${stat.inserted} skipped=${stat.skipped}`,
      );
    }
    console.log('[seed:biz] Done.');
  } finally {
    if (owned) await target.end();
  }
}

if (import.meta.main) {
  await seedBiz();
}
