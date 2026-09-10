import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  like,
  lt,
  ne,
  or,
  type SQL,
} from 'drizzle-orm';
import { AppConfigService } from '../../../../config/app-config.service.js';
import { DatabaseService } from '../../../../database/database.service.js';
import {
  bizBookingItems,
  bizBookings,
  bizCustomers,
  bizStaffs,
  sysNoticeLogs,
  sysNoticeTemplates,
  users,
} from '../../../../database/schema/index.js';
import {
  BizConfigService,
  type NoticeConfig,
} from '../../common/biz-config.service.js';
import { NoticePort, type NoticeSendInput } from '../../common/ports.js';
import {
  andConditions,
  localDateRange,
  parsePagination,
} from '../../common/query.js';
import {
  addLocalDays,
  formatShopDateTime,
  shopDayRange,
  shopToday,
} from '../../common/shop-time.js';
import { withoutUndefined, type BizTx } from '../../common/tx.js';
import { SmsProvider } from './sms/sms.provider.js';

/**
 * 内置模板 code（§19.1）。`recurrence_conflict` / `recurrence_failed` 是
 * §19.2「周期预约冲突 / 生成失败 → 站内（给店员）」对应的模板。
 */
export const NOTICE_TEMPLATES = {
  bookingCreated: 'booking_created',
  bookingRemind: 'booking_remind',
  bookingChanged: 'booking_changed',
  bookingCancelled: 'booking_cancelled',
  bookingNoShow: 'booking_noshow',
  rechargeSuccess: 'recharge_success',
  cardExpiring: 'card_expiring',
  receivableOverdue: 'receivable_overdue',
  recurrenceConflict: 'recurrence_conflict',
  recurrenceFailed: 'recurrence_failed',
} as const;

export type NoticeChannel = 'sms' | 'site';
export type NoticeLogStatus = 'pending' | 'success' | 'failed' | 'skipped';

export type NoticeTemplateFilter = {
  channel?: 'sms' | 'site' | 'both' | undefined;
  status?: 'active' | 'disabled' | undefined;
  keyword?: string | undefined;
};

export type SaveNoticeTemplateInput = {
  code: string;
  name: string;
  channel?: 'sms' | 'site' | 'both' | undefined;
  title?: string | null | undefined;
  content: string;
  variables?: unknown;
  status?: 'active' | 'disabled' | undefined;
  remark?: string | null | undefined;
};

/** 局部更新：每个字段都显式带 `| undefined`，兼容 `exactOptionalPropertyTypes` */
export type UpdateNoticeTemplateInput = {
  code?: string | undefined;
  name?: string | undefined;
  channel?: 'sms' | 'site' | 'both' | undefined;
  title?: string | null | undefined;
  content?: string | undefined;
  variables?: unknown;
  status?: 'active' | 'disabled' | undefined;
  remark?: string | null | undefined;
};

export type NoticeLogFilter = {
  channel?: NoticeChannel | undefined;
  status?: NoticeLogStatus | undefined;
  templateCode?: string | undefined;
  recipientType?: 'customer' | 'user' | undefined;
  recipientId?: number | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
};

export type NoticeSendOutcome = {
  sent: number;
  failed: number;
  skipped: number;
  logIds: number[];
  warnings: string[];
};

type NoticeTemplateRow = typeof sysNoticeTemplates.$inferSelect;
type NoticeLogRow = typeof sysNoticeLogs.$inferSelect;

/** 事务句柄与普通连接共有的读写方法（签名一致，避免 union 调用歧义） */
type NoticeExecutor = Pick<BizTx, 'insert' | 'select' | 'update'>;

type PreparedNotice = {
  templateCode: string;
  channels: NoticeChannel[];
  title: string | null;
  content: string;
  phone: string | null;
  warnings: string[];
};

type DeliverContext = {
  logId: number;
  channel: NoticeChannel;
  phone: string | null;
  content: string;
  templateCode: string;
  provider: string;
  notice: NoticeConfig;
  retryCount?: number | undefined;
};

const SMS_TIMEOUT_NOTE = '通知失败不影响业务';

/** 变量占位符：`{customerName}` 形态 */
const VARIABLE_PATTERN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** 任意残留占位符（含非法变量名），用于兜底剔除 */
const LEFTOVER_PATTERN = /\{[^{}]*\}/g;

/**
 * 通知（短信 + 站内消息，§19）。
 *
 * 两条铁律（§19.2）：
 * 1. 通知在**业务事务提交之后**发送；发送失败**不回滚业务**；
 * 2. 通知失败**绝不能**让主流程报错——`send` 内部吞掉全部异常。
 *
 * 站内消息直接复用 `sys_notice_log(channel='site')`，未读 = `read_at IS NULL`。
 */
@Injectable()
export class NoticesService extends NoticePort {
  private readonly logger = new Logger(NoticesService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly config: BizConfigService,
    private readonly appConfig: AppConfigService,
    private readonly sms: SmsProvider,
  ) {
    super();
  }

  /* ------------------------------------------------------------------ *
   * 模板维护
   * ------------------------------------------------------------------ */

  async listTemplates(
    page: number,
    pageSize: number,
    filter: NoticeTemplateFilter = {},
  ): Promise<{ items: NoticeTemplateRow[]; page: number; pageSize: number }> {
    const paging = parsePagination(page, pageSize);
    const conditions = [isNull(sysNoticeTemplates.deletedAt)];
    if (filter.channel)
      conditions.push(eq(sysNoticeTemplates.channel, filter.channel));
    if (filter.status)
      conditions.push(eq(sysNoticeTemplates.status, filter.status));
    // 关键字同时匹配 code 与 name（模板页按编码搜索是最常见用法）
    const value = filter.keyword?.trim();
    if (value) {
      conditions.push(
        or(
          like(sysNoticeTemplates.code, `%${value}%`),
          like(sysNoticeTemplates.name, `%${value}%`),
        ) as SQL,
      );
    }
    const items = await this.database.db
      .select()
      .from(sysNoticeTemplates)
      .where(and(...conditions))
      .orderBy(asc(sysNoticeTemplates.id))
      .limit(paging.pageSize)
      .offset(paging.offset);
    return { items, page: paging.page, pageSize: paging.pageSize };
  }

  async findTemplate(id: number): Promise<NoticeTemplateRow> {
    const [row] = await this.database.db
      .select()
      .from(sysNoticeTemplates)
      .where(
        and(
          eq(sysNoticeTemplates.id, id),
          isNull(sysNoticeTemplates.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('通知模板不存在');
    return row;
  }

  async createTemplate(
    input: SaveNoticeTemplateInput,
    actorId: number,
  ): Promise<{ id: number }> {
    await this.assertTemplateCodeUnique(input.code);
    this.assertTemplateVariables({
      content: input.content,
      title: input.title ?? null,
      variables: input.variables,
    });
    const [result] = await this.database.db.insert(sysNoticeTemplates).values({
      code: input.code,
      name: input.name,
      channel: input.channel ?? 'both',
      title: input.title ?? null,
      content: input.content,
      variables: input.variables ?? null,
      status: input.status ?? 'active',
      remark: input.remark ?? null,
      createdBy: actorId,
      updatedBy: actorId,
    });
    return { id: Number(result.insertId) };
  }

  async updateTemplate(
    id: number,
    input: UpdateNoticeTemplateInput,
    actorId: number,
  ): Promise<void> {
    const existing = await this.findTemplate(id);
    if (input.code && input.code !== existing.code)
      await this.assertTemplateCodeUnique(input.code, id);
    this.assertTemplateVariables({
      content: input.content ?? existing.content,
      title: input.title === undefined ? existing.title : input.title,
      variables: input.variables ?? existing.variables,
    });
    const patch = withoutUndefined(input);
    if (!Object.keys(patch).length) return;
    await this.database.db
      .update(sysNoticeTemplates)
      .set({ ...patch, updatedBy: actorId })
      .where(
        and(
          eq(sysNoticeTemplates.id, id),
          isNull(sysNoticeTemplates.deletedAt),
        ),
      );
  }

  /** 软删模板；历史 `sys_notice_log` 保留（§19.1） */
  async removeTemplate(id: number, actorId: number): Promise<void> {
    await this.findTemplate(id);
    await this.database.db
      .update(sysNoticeTemplates)
      .set({ deletedAt: new Date(), updatedBy: actorId })
      .where(
        and(
          eq(sysNoticeTemplates.id, id),
          isNull(sysNoticeTemplates.deletedAt),
        ),
      );
  }

  /**
   * 校验模板里出现的 `{变量}` 都已在 `variables` 中声明（§19.1），
   * 未声明直接抛 400，不允许保存。
   */
  assertTemplateVariables(template: {
    content: string;
    title?: string | null;
    variables?: unknown;
  }): void {
    const declared = new Set(declaredVariableNames(template.variables));
    const used = new Set<string>();
    for (const text of [template.content, template.title ?? '']) {
      for (const match of text.matchAll(VARIABLE_PATTERN)) {
        if (match[1]) used.add(match[1]);
      }
    }
    const missing = [...used].filter((name) => !declared.has(name));
    if (missing.length)
      throw new BadRequestException(
        `模板变量未在 variables 中声明：${missing.map((name) => `{${name}}`).join('、')}`,
      );
  }

  private async assertTemplateCodeUnique(
    code: string,
    excludeId?: number,
  ): Promise<void> {
    const conditions = [eq(sysNoticeTemplates.code, code)];
    if (excludeId !== undefined)
      conditions.push(ne(sysNoticeTemplates.id, excludeId));
    const [duplicate] = await this.database.db
      .select({ id: sysNoticeTemplates.id })
      .from(sysNoticeTemplates)
      .where(and(...conditions))
      .limit(1);
    if (duplicate) throw new ConflictException(`模板编码 ${code} 已存在`);
  }

  /* ------------------------------------------------------------------ *
   * 发送日志
   * ------------------------------------------------------------------ */

  async listLogs(
    page: number,
    pageSize: number,
    filter: NoticeLogFilter = {},
  ): Promise<{ items: NoticeLogRow[]; page: number; pageSize: number }> {
    const paging = parsePagination(page, pageSize);
    const timeZone = (await this.config.booking()).timezone;
    const conditions = andConditions([
      filter.channel ? eq(sysNoticeLogs.channel, filter.channel) : undefined,
      filter.status ? eq(sysNoticeLogs.status, filter.status) : undefined,
      filter.templateCode
        ? eq(sysNoticeLogs.templateCode, filter.templateCode)
        : undefined,
      filter.recipientType
        ? eq(sysNoticeLogs.recipientType, filter.recipientType)
        : undefined,
      filter.recipientId !== undefined
        ? eq(sysNoticeLogs.recipientId, filter.recipientId)
        : undefined,
      localDateRange(
        sysNoticeLogs.createdAt,
        filter.dateFrom,
        filter.dateTo,
        timeZone,
      ),
    ]);
    const items = await this.database.db
      .select()
      .from(sysNoticeLogs)
      .where(conditions)
      .orderBy(desc(sysNoticeLogs.id))
      .limit(paging.pageSize)
      .offset(paging.offset);
    return { items, page: paging.page, pageSize: paging.pageSize };
  }

  async findLog(id: number): Promise<NoticeLogRow> {
    const [row] = await this.database.db
      .select()
      .from(sysNoticeLogs)
      .where(eq(sysNoticeLogs.id, id))
      .limit(1);
    if (!row) throw new NotFoundException('通知记录不存在');
    return row;
  }

  /** 单条重发（`retry_count` 累加用于举证；不受 `retryLimit` 限制，属于人工动作） */
  async resend(logId: number): Promise<{
    id: number;
    status: NoticeLogStatus;
    providerMsgId: string | null;
  }> {
    const log = await this.findLog(logId);
    const notice = await this.config.notice();
    const outcome = await this.deliver({
      logId: log.id,
      channel: log.channel,
      phone: log.phone,
      content: log.content,
      templateCode: log.templateCode,
      provider: this.providerName(),
      notice,
      retryCount: log.retryCount + 1,
    });
    this.logger.log(
      `通知 ${logId} 重发结果：${outcome}（${SMS_TIMEOUT_NOTE}）`,
    );
    const updated = await this.findLog(logId);
    return {
      id: updated.id,
      status: updated.status,
      providerMsgId: updated.providerMsgId,
    };
  }

  /* ------------------------------------------------------------------ *
   * 站内消息（inbox）
   * ------------------------------------------------------------------ */

  async inbox(
    userId: number,
    page: number,
    pageSize: number,
  ): Promise<{
    items: NoticeLogRow[];
    unread: number;
    page: number;
    pageSize: number;
  }> {
    const paging = parsePagination(page, pageSize);
    const scope = and(
      eq(sysNoticeLogs.recipientType, 'user'),
      eq(sysNoticeLogs.recipientId, userId),
    );
    const items = await this.database.db
      .select()
      .from(sysNoticeLogs)
      .where(scope)
      .orderBy(desc(sysNoticeLogs.id))
      .limit(paging.pageSize)
      .offset(paging.offset);
    const [unreadRow] = await this.database.db
      .select({ value: count() })
      .from(sysNoticeLogs)
      .where(and(scope, isNull(sysNoticeLogs.readAt)));
    return {
      items,
      unread: Number(unreadRow?.value ?? 0),
      page: paging.page,
      pageSize: paging.pageSize,
    };
  }

  /** 批量标记已读；不传 `ids` 表示该用户全部已读 */
  async markInboxRead(
    userId: number,
    ids?: number[],
  ): Promise<{ updated: number }> {
    const conditions = [
      eq(sysNoticeLogs.recipientType, 'user'),
      eq(sysNoticeLogs.recipientId, userId),
      isNull(sysNoticeLogs.readAt),
    ];
    if (ids?.length) conditions.push(inArray(sysNoticeLogs.id, ids));
    const result = await this.database.db
      .update(sysNoticeLogs)
      .set({ readAt: new Date() })
      .where(and(...conditions));
    return { updated: result[0].affectedRows };
  }

  /* ------------------------------------------------------------------ *
   * 发送（NoticePort）
   * ------------------------------------------------------------------ */

  /**
   * 事务后发送。**内部捕获全部异常**：任何渠道失败都只写 `failed` 日志，
   * 绝不向调用方抛出（§19.2 铁律 2）。
   */
  async send(input: NoticeSendInput): Promise<NoticeSendOutcome> {
    const warnings: string[] = [];
    try {
      const prepared = await this.prepare(this.database.db, input);
      warnings.push(...prepared.warnings);
      const notice = await this.config.notice();
      const provider = this.providerName();
      const logIds: number[] = [];
      let sent = 0;
      let failed = 0;
      let skipped = 0;
      for (const channel of prepared.channels) {
        const logId = await this.insertLog(this.database.db, {
          prepared,
          input,
          channel,
          status: 'pending',
        });
        logIds.push(logId);
        const outcome = await this.deliver({
          logId,
          channel,
          phone: prepared.phone,
          content: prepared.content,
          templateCode: prepared.templateCode,
          provider,
          notice,
        });
        if (outcome === 'success') sent += 1;
        else if (outcome === 'failed') failed += 1;
        else skipped += 1;
      }
      return { sent, failed, skipped, logIds, warnings };
    } catch (error) {
      const message = messageOf(error);
      this.logger.warn(`通知发送异常（已忽略，不影响业务）：${message}`);
      warnings.push(message);
      return { sent: 0, failed: 0, skipped: 0, logIds: [], warnings };
    }
  }

  /** 手动发送前校验模板存在：打错 code 时给 404，而不是静默降级成兜底站内消息 */
  async assertTemplateExists(code: string): Promise<void> {
    const template = await this.loadTemplate(code, this.database.db);
    if (!template)
      throw new NotFoundException(`通知模板 ${code} 不存在或已停用`);
  }

  /** 手动发送（`POST /biz/notice/send`）：一次给多个收件人 */
  async sendToMany(input: {
    templateCode: string;
    recipientType: 'customer' | 'user';
    recipientIds: number[];
    variables: Record<string, string | number>;
    channels?: NoticeChannel[] | undefined;
    bookingId?: number | null | undefined;
  }): Promise<NoticeSendOutcome> {
    const aggregate: NoticeSendOutcome = {
      sent: 0,
      failed: 0,
      skipped: 0,
      logIds: [],
      warnings: [],
    };
    for (const recipientId of input.recipientIds) {
      const result = await this.send({
        templateCode: input.templateCode,
        recipientType: input.recipientType,
        recipientId,
        variables: input.variables,
        bookingId: input.bookingId ?? null,
        channels: input.channels,
      });
      aggregate.sent += result.sent;
      aggregate.failed += result.failed;
      aggregate.skipped += result.skipped;
      aggregate.logIds.push(...result.logIds);
      aggregate.warnings.push(...result.warnings);
    }
    return aggregate;
  }

  /**
   * 事务内**只落 `pending` 记录**（不做任何网络 IO，§9.5 第 9 步）。
   * 事务提交后由调用方 `flushPending(logIds)` 真正发送。
   */
  async enqueueInTx(tx: BizTx, input: NoticeSendInput): Promise<number[]> {
    const prepared = await this.prepare(tx, input);
    const logIds: number[] = [];
    for (const channel of prepared.channels) {
      logIds.push(
        await this.insertLog(tx, {
          prepared,
          input,
          channel,
          status: 'pending',
        }),
      );
    }
    return logIds;
  }

  /** 事务提交后发送 `enqueueInTx` 落下的 pending 记录；不抛异常 */
  async flushPending(
    logIds: number[],
  ): Promise<{ sent: number; failed: number; skipped: number }> {
    if (!logIds.length) return { sent: 0, failed: 0, skipped: 0 };
    const notice = await this.config.notice();
    const provider = this.providerName();
    const rows = await this.database.db
      .select()
      .from(sysNoticeLogs)
      .where(
        and(
          inArray(sysNoticeLogs.id, logIds),
          eq(sysNoticeLogs.status, 'pending'),
        ),
      );
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    for (const row of rows) {
      try {
        const outcome = await this.deliver({
          logId: row.id,
          channel: row.channel,
          phone: row.phone,
          content: row.content,
          templateCode: row.templateCode,
          provider,
          notice,
        });
        if (outcome === 'success') sent += 1;
        else if (outcome === 'failed') failed += 1;
        else skipped += 1;
      } catch (error) {
        this.logger.warn(
          `pending 通知 ${row.id} 发送异常：${messageOf(error)}`,
        );
      }
    }
    return { sent, failed, skipped };
  }

  /**
   * 失败重试（`retryFailedNotices` 定时任务，每 5 分钟）。
   * 条件 `status='failed' AND retry_count < notice.retryLimit`（默认 3，§19.3）。
   */
  async retryFailed(): Promise<{ retried: number; succeeded: number }> {
    const notice = await this.config.notice();
    if (notice.retryLimit <= 0) return { retried: 0, succeeded: 0 };
    const rows = await this.database.db
      .select()
      .from(sysNoticeLogs)
      .where(
        and(
          eq(sysNoticeLogs.status, 'failed'),
          lt(sysNoticeLogs.retryCount, notice.retryLimit),
        ),
      )
      .orderBy(asc(sysNoticeLogs.id))
      .limit(200);
    const provider = this.providerName();
    let succeeded = 0;
    for (const row of rows) {
      try {
        const outcome = await this.deliver({
          logId: row.id,
          channel: row.channel,
          phone: row.phone,
          content: row.content,
          templateCode: row.templateCode,
          provider,
          notice,
          retryCount: row.retryCount + 1,
        });
        if (outcome === 'success') succeeded += 1;
      } catch (error) {
        this.logger.warn(`通知 ${row.id} 重试异常：${messageOf(error)}`);
      }
    }
    return { retried: rows.length, succeeded };
  }

  /**
   * 次日预约提醒（`sendBookingReminders` 定时任务，每日 18:00，§11）。
   *
   * **幂等**：同一 `(booking_id, template_code)` 当天已发过则跳过，
   * 任务重跑（或手工触发）不会重复打扰顾客。
   */
  async sendBookingReminders(): Promise<{ sent: number; skipped: number }> {
    const timeZone = (await this.config.booking()).timezone;
    const today = shopToday(timeZone);
    const remindDate = addLocalDays(today, 1);
    const { start, end } = shopDayRange(remindDate, timeZone);
    const bookings = await this.database.db
      .select({
        id: bizBookings.id,
        bookingNo: bizBookings.bookingNo,
        customerId: bizBookings.customerId,
        customerName: bizBookings.customerName,
        customerPhone: bizBookings.customerPhone,
        staffId: bizBookings.staffId,
        startAt: bizBookings.startAt,
      })
      .from(bizBookings)
      .where(
        and(
          eq(bizBookings.status, 'confirmed'),
          isNull(bizBookings.deletedAt),
          gte(bizBookings.startAt, start),
          lt(bizBookings.startAt, end),
        ),
      )
      .orderBy(asc(bizBookings.startAt));
    if (!bookings.length) return { sent: 0, skipped: 0 };

    const { start: todayStart } = shopDayRange(today, timeZone);
    const alreadySent = await this.database.db
      .select({ bookingId: sysNoticeLogs.bookingId })
      .from(sysNoticeLogs)
      .where(
        and(
          inArray(
            sysNoticeLogs.bookingId,
            bookings.map((booking) => booking.id),
          ),
          eq(sysNoticeLogs.templateCode, NOTICE_TEMPLATES.bookingRemind),
          gte(sysNoticeLogs.createdAt, todayStart),
        ),
      );
    const sentBookings = new Set(
      alreadySent.map((row) => row.bookingId).filter((id) => id !== null),
    );

    const staffNames = await this.loadStaffNames(
      bookings.map((booking) => booking.staffId),
    );
    const serviceNames = await this.loadServiceNames(
      bookings.map((booking) => booking.id),
    );
    const shopName = await this.shopName();

    let sent = 0;
    let skipped = 0;
    for (const booking of bookings) {
      // 幂等：今天已经提醒过这一单 → 跳过（任务重跑不会重复打扰顾客）
      if (sentBookings.has(booking.id)) {
        skipped += 1;
        continue;
      }
      const result = await this.send({
        templateCode: NOTICE_TEMPLATES.bookingRemind,
        recipientType: 'customer',
        recipientId: booking.customerId,
        bookingId: booking.id,
        // 变量名与 seed 模板 / 前端变量预设一致（§19.1）：
        // `booking_remind` 用到 customerName / shopName / bookingTime / staffName
        variables: {
          customerName: booking.customerName,
          customerPhone: booking.customerPhone ?? '',
          shopName,
          bookingNo: booking.bookingNo,
          bookingDate: remindDate,
          bookingTime: formatShopDateTime(booking.startAt, timeZone).slice(
            11,
            16,
          ),
          staffName: staffNames.get(booking.staffId) ?? '',
          serviceItems: serviceNames.get(booking.id) ?? '',
        },
      });
      sent += result.sent;
      if (result.sent === 0) skipped += 1;
    }
    return { sent, skipped };
  }

  /* ------------------------------------------------------------------ *
   * 内部实现
   * ------------------------------------------------------------------ */

  /**
   * 门店名称：读取可选配置项 `biz.shop.name`（`sys_config` 里没有该行时返回空串）。
   *
   * seed 里的模板内容引用了 `{shopName}`，但 `BIZ_CONFIG_DEFAULTS` 未定义该键；
   * 这里用 `getString` 的通用读取能力兜底，配置一旦补上即可生效，无需改代码。
   */
  private async shopName(): Promise<string> {
    return this.config.getString('biz.shop.name', '');
  }

  private providerName(): string {
    return this.appConfig.sms.provider;
  }

  private async insertLog(
    executor: NoticeExecutor,
    context: {
      prepared: PreparedNotice;
      input: NoticeSendInput;
      channel: NoticeChannel;
      status: NoticeLogStatus;
    },
  ): Promise<number> {
    const { prepared, input, channel, status } = context;
    const [result] = await executor.insert(sysNoticeLogs).values({
      templateCode: prepared.templateCode,
      channel,
      recipientType: input.recipientType,
      recipientId: input.recipientId,
      phone: prepared.phone,
      title: prepared.title,
      content: prepared.content.slice(0, 1000),
      status,
      bookingId: input.bookingId ?? null,
    });
    return Number(result.insertId);
  }

  /** 真正投递一个渠道；返回该渠道的结果，异常在 sms 分支内部消化 */
  private async deliver(
    context: DeliverContext,
  ): Promise<'success' | 'failed' | 'skipped'> {
    const { logId, channel, phone, content, templateCode, provider, notice } =
      context;
    const patch: Partial<typeof sysNoticeLogs.$inferInsert> = {};
    if (context.retryCount !== undefined) patch.retryCount = context.retryCount;

    if (channel === 'site') {
      // 站内消息写库即送达，没有外部通道
      await this.database.db
        .update(sysNoticeLogs)
        .set({ ...patch, status: 'success', sentAt: new Date(), error: null })
        .where(eq(sysNoticeLogs.id, logId));
      return 'success';
    }

    const skipReason = this.smsSkipReason(templateCode, phone, notice);
    if (skipReason) {
      await this.database.db
        .update(sysNoticeLogs)
        .set({ ...patch, status: 'skipped', provider, error: skipReason })
        .where(eq(sysNoticeLogs.id, logId));
      return 'skipped';
    }

    try {
      const result = await this.sms.send({
        phone: phone ?? '',
        content,
        templateCode,
      });
      await this.database.db
        .update(sysNoticeLogs)
        .set({
          ...patch,
          status: 'success',
          provider,
          providerMsgId: result.providerMsgId || null,
          sentAt: new Date(),
          error: null,
        })
        .where(eq(sysNoticeLogs.id, logId));
      return 'success';
    } catch (error) {
      // 通道异常（含「短信通道未配置」）→ failed，绝不冒泡
      const message = messageOf(error).slice(0, 500);
      await this.database.db
        .update(sysNoticeLogs)
        .set({ ...patch, status: 'failed', provider, error: message })
        .where(eq(sysNoticeLogs.id, logId));
      return 'failed';
    }
  }

  /** 短信可发性的三个闸门：总开关 / 模板白名单 / 手机号 */
  private smsSkipReason(
    templateCode: string,
    phone: string | null,
    notice: NoticeConfig,
  ): string | null {
    if (!notice.smsEnabled) return '短信总开关 biz.notice.smsEnabled 未开启';
    if (!notice.smsTemplates.includes(templateCode))
      return `模板 ${templateCode} 未加入短信白名单 biz.notice.smsTemplates`;
    if (!phone) return '收件人缺少手机号';
    return null;
  }

  private async prepare(
    executor: NoticeExecutor,
    input: NoticeSendInput,
  ): Promise<PreparedNotice> {
    const warnings: string[] = [];
    const template = await this.loadTemplate(input.templateCode, executor);
    let channel: 'sms' | 'site' | 'both' = 'site';
    let rawTitle: string | null = input.templateCode;
    let rawContent = fallbackContent(input);
    if (template) {
      channel = template.channel;
      rawTitle = template.title;
      rawContent = template.content;
    } else {
      warnings.push(
        `模板 ${input.templateCode} 不存在或已停用，已降级为站内原始变量通知`,
      );
    }
    const channels = resolveChannels(channel, input.channels);
    const title =
      rawTitle === null ? null : this.renderText(rawTitle, input, warnings);
    const content = this.renderText(rawContent, input, warnings);
    const phone = channels.includes('sms')
      ? await this.resolvePhone(
          executor,
          input.recipientType,
          input.recipientId,
        )
      : null;
    return {
      templateCode: input.templateCode,
      channels,
      title,
      content,
      phone,
      warnings,
    };
  }

  /** 渲染 `{变量}`；缺失变量渲染成空串并收集 warning，残留占位符一律剔除 */
  private renderText(
    text: string,
    input: NoticeSendInput,
    warnings: string[],
  ): string {
    const rendered = text.replace(VARIABLE_PATTERN, (_match, name: string) => {
      const value = input.variables[name];
      if (value === undefined) {
        warnings.push(`变量 {${name}} 未提供，已渲染为空字符串`);
        return '';
      }
      return String(value);
    });
    const leftovers = rendered.match(LEFTOVER_PATTERN);
    if (!leftovers?.length) return rendered;
    for (const token of leftovers)
      warnings.push(`文本存在未解析占位符 ${token}，已剔除`);
    return rendered.replace(LEFTOVER_PATTERN, '');
  }

  private async loadTemplate(
    code: string,
    executor: NoticeExecutor,
  ): Promise<NoticeTemplateRow | null> {
    const [row] = await executor
      .select()
      .from(sysNoticeTemplates)
      .where(
        and(
          eq(sysNoticeTemplates.code, code),
          isNull(sysNoticeTemplates.deletedAt),
        ),
      )
      .limit(1);
    return row && row.status === 'active' ? row : null;
  }

  private async resolvePhone(
    executor: NoticeExecutor,
    recipientType: 'customer' | 'user',
    recipientId: number,
  ): Promise<string | null> {
    if (recipientType === 'customer') {
      const [row] = await executor
        .select({ phone: bizCustomers.phone })
        .from(bizCustomers)
        .where(eq(bizCustomers.id, recipientId))
        .limit(1);
      return row?.phone ?? null;
    }
    const [row] = await executor
      .select({ phone: users.phone })
      .from(users)
      .where(eq(users.id, recipientId))
      .limit(1);
    return row?.phone ?? null;
  }

  private async loadStaffNames(ids: number[]): Promise<Map<number, string>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const rows = await this.database.db
      .select({ id: bizStaffs.id, nickname: bizStaffs.nickname })
      .from(bizStaffs)
      .where(inArray(bizStaffs.id, unique));
    return new Map(rows.map((row) => [row.id, row.nickname]));
  }

  private async loadServiceNames(
    bookingIds: number[],
  ): Promise<Map<number, string>> {
    const unique = [...new Set(bookingIds)];
    if (!unique.length) return new Map();
    const rows = await this.database.db
      .select({
        bookingId: bizBookingItems.bookingId,
        name: bizBookingItems.name,
        sort: bizBookingItems.sort,
      })
      .from(bizBookingItems)
      .where(inArray(bizBookingItems.bookingId, unique))
      .orderBy(asc(bizBookingItems.sort));
    const grouped = new Map<number, string[]>();
    for (const row of rows) {
      const list = grouped.get(row.bookingId) ?? [];
      list.push(row.name);
      grouped.set(row.bookingId, list);
    }
    return new Map(
      [...grouped].map(([bookingId, names]) => [bookingId, names.join('+')]),
    );
  }
}

/** `channels` 入参优先；否则按模板 `channel` 展开（`both` = 站内 + 短信） */
function resolveChannels(
  channel: 'sms' | 'site' | 'both',
  requested?: NoticeChannel[] | undefined,
): NoticeChannel[] {
  if (requested?.length) return [...new Set(requested)];
  if (channel === 'sms') return ['sms'];
  if (channel === 'site') return ['site'];
  return ['site', 'sms'];
}

/** 模板缺失时的站内兜底文案：至少让店员看到原始变量，不静默丢通知 */
function fallbackContent(input: NoticeSendInput): string {
  const pairs = Object.entries(input.variables).map(
    ([key, value]) => `${key}=${String(value)}`,
  );
  return `【${input.templateCode}】${pairs.join('；')}`;
}

/** 从 `variables` 声明里提取变量名（支持字符串数组 / 对象数组 / 对象映射） */
export function declaredVariableNames(variables: unknown): string[] {
  if (!variables) return [];
  const normalize = (value: string): string =>
    value.trim().replace(/^\{|\}$/g, '');
  if (Array.isArray(variables)) {
    const names: string[] = [];
    for (const item of variables) {
      if (typeof item === 'string') {
        names.push(normalize(item));
        continue;
      }
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        const candidate =
          record.name ?? record.key ?? record.code ?? record.variable;
        if (typeof candidate === 'string') names.push(normalize(candidate));
      }
    }
    return names.filter(Boolean);
  }
  if (typeof variables === 'object')
    return Object.keys(variables as Record<string, unknown>).map(normalize);
  return [];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
