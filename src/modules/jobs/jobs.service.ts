import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import {
  and,
  count,
  desc,
  eq,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
} from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { jobLogs, jobs, refreshTokens } from '../../database/schema/index';
import { readCount } from '../biz/common/query';
import {
  BookingOpsPort,
  CreditPort,
  MemberAccountPort,
  MemberCardPort,
  NoticePort,
  PaymentPort,
  RecurrencePort,
} from '../biz/common/ports';
import { addLocalDays, shopToday } from '../biz/common/shop-time';

export type CreateJobInput = {
  name: string;
  handler: string;
  cron: string;
  status?: 'active' | 'disabled' | undefined;
  concurrent?: boolean | undefined;
  remark?: string | undefined;
};
export type UpdateJobInput = {
  name?: string | undefined;
  handler?: string | undefined;
  cron?: string | undefined;
  status?: 'active' | 'disabled' | undefined;
  concurrent?: boolean | undefined;
  remark?: string | null | undefined;
};

type JobRow = typeof jobs.$inferSelect;
type JobHandler = () => Promise<void>;

@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private readonly handlers = new Map<string, JobHandler>();
  private readonly running = new Set<number>();

  constructor(
    private readonly database: DatabaseService,
    private readonly scheduler: SchedulerRegistry,
    private readonly bookingOps: BookingOpsPort,
    private readonly payments: PaymentPort,
    private readonly credit: CreditPort,
    private readonly members: MemberAccountPort,
    private readonly memberCards: MemberCardPort,
    private readonly notices: NoticePort,
    private readonly recurrences: RecurrencePort,
  ) {
    this.registerHandlers();
  }

  /**
   * 定时任务处理器注册表（§11）。
   *
   * 硬约束：**定时任务不碰钱**（§15.7 不变量 5），只改状态与等级；
   * 每个 handler 都必须可重复执行而不产生副作用（幂等靠条件更新 + affectedRows 闸门）。
   */
  private registerHandlers(): void {
    this.handlers.set('noop', async () => {});
    this.handlers.set('cleanExpiredRefreshTokens', async () => {
      await this.database.db
        .delete(refreshTokens)
        .where(
          or(
            lt(refreshTokens.expiresAt, new Date()),
            isNotNull(refreshTokens.revokedAt),
          ),
        );
    });
    this.handlers.set('autoCompleteExpiredBookings', async () => {
      const result = await this.bookingOps.autoCompleteExpired();
      if (result.completed)
        this.logger.log(`自动完成 ${result.completed} 张预约`);
    });
    this.handlers.set('autoNoShowBookings', async () => {
      const result = await this.bookingOps.autoNoShowExpired();
      if (result.noShow) this.logger.log(`标记爽约 ${result.noShow} 张预约`);
    });
    this.handlers.set('expireMemberCards', async () => {
      const result = await this.memberCards.expireCards();
      if (result.expired) this.logger.log(`过期次卡 ${result.expired} 张`);
    });
    this.handlers.set('recountMemberLevels', async () => {
      const result = await this.members.recountAllLevels();
      if (result.updated) this.logger.log(`重算会员等级 ${result.updated} 人`);
    });
    this.handlers.set('closeExpiredPayments', async () => {
      const result = await this.payments.closeExpired();
      if (result.closed) this.logger.log(`关闭超时支付单 ${result.closed} 张`);
    });
    this.handlers.set('queryPendingPayments', async () => {
      const result = await this.payments.queryPending();
      if (result.settled)
        this.logger.log(`主动查单补记支付成功 ${result.settled} 笔`);
    });
    this.handlers.set('reconcilePayments', async () => {
      const billDate = yesterdayInShop();
      const result = await this.payments.reconcile(billDate);
      this.logger.log(`对账 ${billDate}：差异 ${result.diffs} 条`);
    });
    this.handlers.set('markOverdueReceivables', async () => {
      const result = await this.credit.markOverdue();
      if (result.overdue) this.logger.log(`标记逾期应收 ${result.overdue} 张`);
    });
    this.handlers.set('sendBookingReminders', async () => {
      const result = await this.notices.sendBookingReminders();
      if (result.sent)
        this.logger.log(
          `发送次日预约提醒 ${result.sent} 条（跳过 ${result.skipped} 条）`,
        );
    });
    this.handlers.set('retryFailedNotices', async () => {
      const result = await this.notices.retryFailed();
      if (result.retried)
        this.logger.log(
          `重试通知 ${result.retried} 条，成功 ${result.succeeded} 条`,
        );
    });
    this.handlers.set('generateRecurringBookings', async () => {
      const result = await this.recurrences.generate();
      if (result.generated)
        this.logger.log(
          `周期预约生成 ${result.generated} 单（跳过 ${result.skipped} 单）`,
        );
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      const rows = await this.database.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.status, 'active'), isNull(jobs.deletedAt)));
      for (const job of rows) this.schedule(job);
    } catch (error) {
      this.logger.warn(
        `Unable to load scheduled jobs: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const name of this.scheduler.getCronJobs().keys()) {
      try {
        this.scheduler.getCronJob(name).stop();
      } catch {
        /* ignore */
      }
      this.scheduler.deleteCronJob(name);
    }
  }

  async list(page: number, pageSize: number) {
    // total 与 items 共用同一个 where（口径见 common/query.ts）
    const where = isNull(jobs.deletedAt);
    const [items, counted] = await Promise.all([
      this.database.db
        .select()
        .from(jobs)
        .where(where)
        .orderBy(desc(jobs.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.database.db.select({ value: count() }).from(jobs).where(where),
    ]);
    return { items, total: readCount(counted), page, pageSize };
  }

  async findOne(id: number): Promise<JobRow> {
    const [job] = await this.database.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), isNull(jobs.deletedAt)))
      .limit(1);
    if (!job) throw new NotFoundException('定时任务不存在');
    return job;
  }

  async create(
    input: CreateJobInput,
    actorId: number,
  ): Promise<{ id: number }> {
    this.assertHandler(input.handler);
    this.assertCron(input.cron);
    await this.assertHandlerUnique(input.handler);
    const result = await this.database.db.insert(jobs).values({
      ...withoutUndefined(input),
      createdBy: actorId,
      updatedBy: actorId,
    });
    const id = Number(result[0].insertId);
    this.schedule(await this.findOne(id));
    return { id };
  }

  async update(
    id: number,
    input: UpdateJobInput,
    actorId: number,
  ): Promise<void> {
    const existing = await this.findOne(id);
    const patch = withoutUndefined(input);
    if (patch.handler) {
      this.assertHandler(patch.handler);
      if (patch.handler !== existing.handler)
        await this.assertHandlerUnique(patch.handler, id);
    }
    if (patch.cron) this.assertCron(patch.cron);
    await this.database.db
      .update(jobs)
      .set({ ...patch, updatedBy: actorId })
      .where(and(eq(jobs.id, id), isNull(jobs.deletedAt)));
    this.schedule(await this.findOne(id));
  }

  async remove(id: number, actorId: number): Promise<void> {
    await this.findOne(id);
    this.unschedule(id);
    await this.database.db
      .update(jobs)
      .set({ deletedAt: new Date(), updatedBy: actorId })
      .where(and(eq(jobs.id, id), isNull(jobs.deletedAt)));
  }

  async runNow(id: number): Promise<{ success: true }> {
    const job = await this.findOne(id);
    const handler = this.handlers.get(job.handler);
    if (!handler) throw new BadRequestException('未知的任务处理器');
    await this.execute(job, handler);
    return { success: true };
  }

  async listLogs(jobId: number, page: number, pageSize: number) {
    const items = await this.database.db
      .select()
      .from(jobLogs)
      .where(eq(jobLogs.jobId, jobId))
      .orderBy(desc(jobLogs.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return { items, page, pageSize };
  }

  async clearLogs(): Promise<void> {
    await this.database.db.delete(jobLogs);
  }

  private schedule(job: JobRow): void {
    this.unschedule(job.id);
    if (job.status !== 'active') return;
    const handler = this.handlers.get(job.handler);
    if (!handler) return;
    const cronJob = new CronJob(job.cron, () => {
      void this.execute(job, handler);
    });
    this.scheduler.addCronJob(this.cronName(job.id), cronJob);
    cronJob.start();
  }

  private unschedule(id: number): void {
    const name = this.cronName(id);
    if (this.scheduler.doesExist('cron', name)) {
      try {
        this.scheduler.getCronJob(name).stop();
      } catch {
        /* ignore */
      }
      this.scheduler.deleteCronJob(name);
    }
  }

  private cronName(id: number): string {
    return `job:${id}`;
  }

  private async execute(job: JobRow, handler: JobHandler): Promise<void> {
    if (!job.concurrent && this.running.has(job.id)) return;
    this.running.add(job.id);
    const startedAt = new Date();
    try {
      await handler();
      await this.recordLog(job, 'success', null, startedAt, new Date());
    } catch (error) {
      await this.recordLog(
        job,
        'failure',
        messageOf(error),
        startedAt,
        new Date(),
      );
    } finally {
      this.running.delete(job.id);
    }
  }

  private async recordLog(
    job: JobRow,
    status: 'success' | 'failure',
    message: string | null,
    startedAt: Date,
    finishedAt: Date,
  ): Promise<void> {
    try {
      await this.database.db.insert(jobLogs).values({
        jobId: job.id,
        jobName: job.name,
        handler: job.handler,
        status,
        message,
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      });
    } catch (error) {
      this.logger.warn(
        `Failed to record job log: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private assertHandler(handler: string): void {
    if (!this.handlers.has(handler))
      throw new BadRequestException(`未知的任务处理器：${handler}`);
  }

  private assertCron(cron: string): void {
    try {
      new CronJob(cron, () => {});
    } catch {
      throw new BadRequestException('Cron 表达式无效');
    }
  }

  private async assertHandlerUnique(
    handler: string,
    excludeId?: number,
  ): Promise<void> {
    const conditions = [eq(jobs.handler, handler), isNull(jobs.deletedAt)];
    if (excludeId !== undefined) conditions.push(ne(jobs.id, excludeId));
    const [duplicate] = await this.database.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(...conditions))
      .limit(1);
    if (duplicate) throw new ConflictException('任务处理器已存在');
  }
}

function withoutUndefined<T extends object>(
  value: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as { [K in keyof T]: Exclude<T[K], undefined> };
}
function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2000);
}

/** 前一天（店内本地日），对账任务用 */
function yesterdayInShop(): string {
  return addLocalDays(shopToday(), -1);
}
