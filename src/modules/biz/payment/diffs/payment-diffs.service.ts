import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
} from 'drizzle-orm';
import { DatabaseService } from '../../../../database/database.service.js';
import {
  bizPaymentDiffs,
  bizPayments,
} from '../../../../database/schema/index.js';
import { BizConfigService } from '../../common/biz-config.service.js';
import {
  addLocalDays,
  shopDayRange,
  shopToday,
} from '../../common/shop-time.js';
import { AlipayQrProvider } from '../channels/alipay-qr.provider.js';
import type { PaymentChannelProvider } from '../channels/channel.interface.js';
import { WxpayNativeProvider } from '../channels/wxpay-native.provider.js';

export type PaymentDiffRow = typeof bizPaymentDiffs.$inferSelect;
export type DiffType =
  | 'missing_in_system'
  | 'missing_in_channel'
  | 'amount_mismatch'
  | 'status_mismatch';

export type PaymentDiffListFilter = {
  billDate?: string | undefined;
  channel?: PaymentChannelProvider['channel'] | undefined;
  status?: 'pending' | 'resolved' | 'ignored' | undefined;
  diffType?: DiffType | undefined;
};

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DIFF_LIMIT = 500;

/**
 * 渠道对账（§17.5）。
 *
 * - 拉渠道账单 → 按 `transaction_id` / `out_trade_no` 与 `biz_payment` 逐笔比对；
 * - 四类差异写 `biz_payment_diff`，唯一键 `(bill_date, channel, transaction_id, diff_type)`
 *   靠 `ON DUPLICATE KEY UPDATE` 保证**任务可重入、不产生重复差异**；
 * - 差异**不自动改账**，必须人工处理并填备注（`resolved` / `ignored`），不允许静默忽略。
 */
@Injectable()
export class PaymentDiffsService {
  private readonly logger = new Logger(PaymentDiffsService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly bizConfig: BizConfigService,
    private readonly wxpayNative: WxpayNativeProvider,
    private readonly alipayQr: AlipayQrProvider,
  ) {}

  /**
   * 对账指定营业日（默认前一天）。
   *
   * 渠道未配置 → 记日志并跳过（返回 `{diffs:0}`），不抛错（定时任务不该被配置问题打成 failure）。
   */
  async reconcile(billDate?: string): Promise<{ diffs: number }> {
    const timezone = (await this.bizConfig.booking()).timezone;
    const date = billDate?.trim() || addLocalDays(shopToday(timezone), -1);
    if (!LOCAL_DATE_PATTERN.test(date))
      throw new BadRequestException('对账日期格式应为 YYYY-MM-DD');

    let diffs = 0;
    for (const provider of [this.wxpayNative, this.alipayQr]) {
      if (!provider.configured) {
        this.logger.warn(`${provider.label}通道未配置，跳过 ${date} 对账`);
        continue;
      }
      try {
        diffs += await this.reconcileChannel(provider, date, timezone);
      } catch (error) {
        this.logger.warn(
          `${provider.label} ${date} 对账失败：${messageOf(error)}`,
        );
      }
    }
    return { diffs };
  }

  private async reconcileChannel(
    provider: PaymentChannelProvider,
    billDate: string,
    timezone: string,
  ): Promise<number> {
    const records = await provider.downloadBill(billDate);
    if (!records.length) {
      this.logger.warn(
        `${provider.label} ${billDate} 账单为空，跳过对账（避免误报系统缺单）`,
      );
      return 0;
    }
    const range = shopDayRange(billDate, timezone);
    const systemPayments = await this.database.db
      .select()
      .from(bizPayments)
      .where(
        and(
          eq(bizPayments.channel, provider.channel),
          inArray(bizPayments.status, [
            'success',
            'partial_refunded',
            'refunded',
          ]),
          isNull(bizPayments.deletedAt),
          isNotNull(bizPayments.paidAt),
          gte(bizPayments.paidAt, range.start),
          lt(bizPayments.paidAt, range.end),
        ),
      );

    const byTransaction = new Map<string, (typeof systemPayments)[number]>();
    const byOutTradeNo = new Map<string, (typeof systemPayments)[number]>();
    for (const payment of systemPayments) {
      if (payment.transactionId)
        byTransaction.set(payment.transactionId, payment);
      byOutTradeNo.set(payment.outTradeNo, payment);
    }

    let diffs = 0;
    const matched = new Set<number>();
    for (const record of records) {
      const system =
        byTransaction.get(record.transactionId) ??
        byOutTradeNo.get(record.outTradeNo);
      if (!system) {
        diffs += await this.upsertDiff({
          billDate,
          channel: provider.channel,
          outTradeNo: record.outTradeNo,
          transactionId: record.transactionId,
          systemAmount: 0,
          channelAmount: record.amount,
          diffType: 'missing_in_system',
        });
        continue;
      }
      matched.add(system.id);
      if (system.amount !== record.amount) {
        diffs += await this.upsertDiff({
          billDate,
          channel: provider.channel,
          outTradeNo: system.outTradeNo,
          transactionId: record.transactionId,
          systemAmount: system.amount,
          channelAmount: record.amount,
          diffType: 'amount_mismatch',
        });
        continue;
      }
      if (record.status === 'failed' || record.status === 'closed') {
        diffs += await this.upsertDiff({
          billDate,
          channel: provider.channel,
          outTradeNo: system.outTradeNo,
          transactionId: record.transactionId,
          systemAmount: system.amount,
          channelAmount: record.amount,
          diffType: 'status_mismatch',
        });
      }
    }

    for (const payment of systemPayments) {
      if (matched.has(payment.id)) continue;
      diffs += await this.upsertDiff({
        billDate,
        channel: provider.channel,
        outTradeNo: payment.outTradeNo,
        // 唯一键含 transaction_id：系统缺单时它可能为空，用 out_trade_no 兜底避免唯一键失效
        transactionId: payment.transactionId ?? payment.outTradeNo,
        systemAmount: payment.amount,
        channelAmount: 0,
        diffType: 'missing_in_channel',
      });
    }
    return diffs;
  }

  /**
   * 写入 / 刷新一条差异（可重入）。
   *
   * 冲突时只刷新金额与系统单号，**不动 `status` / `handle_by` / `remark`**——人工处理结果不能被任务覆盖。
   */
  private async upsertDiff(input: {
    billDate: string;
    channel: PaymentChannelProvider['channel'];
    outTradeNo: string | null;
    transactionId: string | null;
    systemAmount: number;
    channelAmount: number;
    diffType: DiffType;
  }): Promise<number> {
    await this.database.db
      .insert(bizPaymentDiffs)
      .values({ ...input, status: 'pending' })
      .onDuplicateKeyUpdate({
        set: {
          outTradeNo: input.outTradeNo,
          systemAmount: input.systemAmount,
          channelAmount: input.channelAmount,
        },
      });
    return 1;
  }

  /** 标记已处理 / 忽略：**必须填备注**，不允许静默忽略（§17.5） */
  async handle(
    id: number,
    input: { status: 'resolved' | 'ignored'; remark: string },
    actorId: number,
  ): Promise<void> {
    const remark = input.remark?.trim();
    if (!remark)
      throw new BadRequestException('必须填写处理备注，不允许静默忽略差异');
    const affected = await this.database.db
      .update(bizPaymentDiffs)
      .set({
        status: input.status,
        remark: remark.slice(0, 200),
        handleBy: actorId,
        handledAt: new Date(),
        updatedBy: actorId,
      })
      .where(
        and(
          eq(bizPaymentDiffs.id, id),
          eq(bizPaymentDiffs.status, 'pending'),
          isNull(bizPaymentDiffs.deletedAt),
        ),
      );
    if (!affected[0].affectedRows)
      throw new ConflictException('该差异已处理或不存在');
  }

  async list(
    page: number,
    pageSize: number,
    filter: PaymentDiffListFilter,
  ): Promise<{ items: PaymentDiffRow[]; page: number; pageSize: number }> {
    const conditions = [isNull(bizPaymentDiffs.deletedAt)];
    if (filter.billDate)
      conditions.push(eq(bizPaymentDiffs.billDate, filter.billDate));
    if (filter.channel)
      conditions.push(eq(bizPaymentDiffs.channel, filter.channel));
    if (filter.status)
      conditions.push(eq(bizPaymentDiffs.status, filter.status));
    if (filter.diffType)
      conditions.push(eq(bizPaymentDiffs.diffType, filter.diffType));
    const items = await this.database.db
      .select()
      .from(bizPaymentDiffs)
      .where(and(...conditions))
      .orderBy(desc(bizPaymentDiffs.billDate), desc(bizPaymentDiffs.id))
      .limit(Math.min(pageSize, DIFF_LIMIT))
      .offset((page - 1) * pageSize);
    return { items, page, pageSize };
  }

  async findOne(id: number): Promise<PaymentDiffRow> {
    const [diff] = await this.database.db
      .select()
      .from(bizPaymentDiffs)
      .where(and(eq(bizPaymentDiffs.id, id), isNull(bizPaymentDiffs.deletedAt)))
      .limit(1);
    if (!diff) throw new NotFoundException('对账差异不存在');
    return diff;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
