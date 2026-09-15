import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull, like, lt } from 'drizzle-orm';
import { AppConfigService } from '../../../../config/app-config.service.js';
import { DatabaseService } from '../../../../database/database.service.js';
import {
  bizBookingItems,
  bizBookings,
  bizCustomers,
  bizPaymentLogs,
  bizPayments,
} from '../../../../database/schema/index.js';
import type { RequestActor } from '../../../../common/data-scope/data-scope.js';
import {
  requireCurrentStoreId,
  resolveStoreScope,
  storeConditions,
} from '../../../../common/data-scope/store-scope.js';
import { BizConfigService } from '../../common/biz-config.service.js';
import {
  buildDocNo,
  buildOutTradeNo,
  buildOutTradeNoByToken,
} from '../../common/doc-no.js';
import { localDateRange } from '../../common/query.js';
import {
  MemberAccountPort,
  MemberCardPort,
  NoticePort,
  PaymentPort,
  SettlementPort,
  type PayChannel,
  type PaymentDraft,
  type PaymentOutcome,
  type PreparedChannelOrder,
} from '../../common/ports.js';
import type { BizExecutor, BizTx } from '../../common/tx.js';
import { AlipayQrProvider } from '../channels/alipay-qr.provider.js';
import type {
  ChannelFailureKind,
  OnlineChannel,
  PaymentChannelProvider,
} from '../channels/channel.interface.js';
import { WxpayNativeProvider } from '../channels/wxpay-native.provider.js';
import { PaymentDiffsService } from '../diffs/payment-diffs.service.js';

export type PaymentRow = typeof bizPayments.$inferSelect;
/**
 * 列表项 = 表行 + 联查出来的展示名。
 *
 * `biz_payment` 只存 `booking_id` / `customer_id`，列表直接返回表行会让页面显示
 * `#10` / `#9` 这种内部主键，店员看不出是哪一单、哪位顾客。
 */
export type PaymentListItem = PaymentRow & {
  bookingNo: string | null;
  customerName: string | null;
};

export type PaymentLogRow = typeof bizPaymentLogs.$inferSelect;

export type PaymentStatus =
  | 'pending'
  | 'success'
  | 'failed'
  | 'closed'
  | 'refunded'
  | 'partial_refunded';

/**
 * `biz_payment.channel` 的取值。
 *
 * 注意：`PayChannel`（端口类型）比它多 `wechat` / `alipay` 两个值——那是会员流水的口径，
 * 支付单上必须写 `wechat_offline` / `alipay_offline`，所以这里必须显式收窄。
 */
export type PaymentChannel =
  | 'wxpay_native'
  | 'alipay_qr'
  // ⚠️ `biz_payment.channel` 列上还有 `wxpay_jsapi`（小程序支付预留），但**故意不进本类型**：
  // 这里没有 provider，加进来会被 `isOnlineChannel` 判成线下渠道从而直接置成功，更危险。
  // `toPaymentChannel` 会显式拒绝它；C1（`POST /app/payments/wxpay/jsapi`）开工时
  // 连同 provider 一起加进来。
  | 'cash'
  | 'wechat_offline'
  | 'alipay_offline'
  | 'balance'
  | 'card'
  | 'credit';

export type PaymentListFilter = {
  /** 门店筛选（连锁直营）：超管/\`system:store:all\` 可筛任意门店，普通账号只能筛可见门店 */
  storeId?: number | undefined;
  channel?: PaymentChannel | undefined;
  status?: PaymentStatus | undefined;
  purpose?: PaymentDraft['purpose'] | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  bookingNo?: string | undefined;
  customerId?: number | undefined;
  bookingId?: number | undefined;
};

/** 回调 / 查单验签后的支付成功事实 */
type SettleInput = {
  transactionId: string;
  amount: number;
  successTime: Date;
  raw: unknown;
  httpStatus?: number | undefined;
};

/** 在线渠道（唯一需要查单 / 验签 / 账单的两种） */
const ONLINE_CHANNELS: OnlineChannel[] = ['wxpay_native', 'alipay_qr'];

/**
 * 渠道原始报文里**必须脱敏**的键（按名字匹配，大小写不敏感）。
 *
 * 原文进 `biz_payment_log.raw` 是**留证**需要（只追加、不修改），
 * 但**给店员看的接口**不该带渠道侧的顾客标识：
 * 微信 v3 回调含 `payer.openid`，支付宝回调含 `buyer_id` / `buyer_logon_id`。
 * 这里按**键名递归掩码**（保留报文结构，便于排障），而不是整段丢掉。
 */
const SENSITIVE_RAW_KEY =
  /openid|buyer|payer|phone|mobile|tel|id_?card|identity|real_?name/i;

/** 递归掩码敏感键的值（深度上限 6，避免异常结构把栈打爆） */
export function redactChannelRaw(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value))
    return value.map((item) => redactChannelRaw(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_RAW_KEY.test(key)
      ? '[已脱敏]'
      : redactChannelRaw(item, depth + 1);
  }
  return out;
}
/** 支付单落库时 `payment_no` / `out_trade_no` 是 NOT NULL + UNIQUE，先用一次性占位再回填主键 */
function temporaryToken(): string {
  return globalThis.crypto.randomUUID().replaceAll('-', '');
}

/**
 * 收银台（§17 / §6.6）。
 *
 * - 金额事实的唯一来源是支付单与退款单（§15.7）：本 service 只写 `biz_payment`，
 *   预约上的 `paid_amount` / `due_amount` / `pay_status` 一律由 `SettlementPort.recalc()` 重算；
 * - 在线渠道「下单 → 回调 → 查单兜底」，成功落地只有一条幂等闸门
 *   `UPDATE ... WHERE out_trade_no=? AND status='pending'`（`settlePayment`）；
 * - 线上与线下**收款与建单同事务**（§6.5），挂账（`credit`）不走本 service。
 */
/**
 * 允许「落地为 success」的起始状态。
 *
 * **必须包含 `closed` / `failed`**：本地关单只是**我们自己的超时判断**，
 * 而顾客完全可能在最后一刻付款成功。已验签的回调（或渠道查单结果）是
 * **资金事实**，比本地的超时状态更权威。
 *
 * 只认 `pending` 会把这些钱记丢：回调到了 → 条件更新 0 行 → 被当成「已处理」
 * → 回 SUCCESS 让微信停止重投 → 本地永远停在 closed（只能等对账发现）。
 *
 * 注意**不含** `success` / `refunded` / `partial_refunded`：那些是已经落过账的
 * 状态，不能让它们被重新落成 success（那会把退款单的账冲坏）。
 */
const SETTLE_FROM_STATUSES = ['pending', 'closed', 'failed'] as const;

/** 关单/失败后**继续主动查单**的时长：覆盖「最后一刻付款成功但回调丢了」 */
const QUERY_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * 回调里「落账 + 发货」超过这个耗时就打告警。
 *
 * 微信要求 **5 秒内应答**。我们**刻意选择同步落账**（先落账再应答）——
 * 文档推荐「先应答再异步处理」，但异步一旦失败就会「应答了却没落账」，
 * 对资金链路是更糟的失败模式。超时的后果也是良性的：微信会重投，
 * 而重投命中幂等闸门后直接答 SUCCESS。
 *
 * 所以这里**不改行为，只做观测**：超过阈值就留一条 warn，
 * 让「落账开始变慢」在变成故障之前被看见。
 */
const CALLBACK_SLOW_SETTLE_MS = 3000;

@Injectable()
export class PaymentsService extends PaymentPort {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly bizConfig: BizConfigService,
    private readonly appConfig: AppConfigService,
    private readonly settlement: SettlementPort,
    private readonly members: MemberAccountPort,
    private readonly memberCards: MemberCardPort,
    private readonly notices: NoticePort,
    private readonly wxpayNative: WxpayNativeProvider,
    private readonly alipayQr: AlipayQrProvider,
    private readonly diffs: PaymentDiffsService,
  ) {
    super();
  }

  /* ------------------------------------------------------------------ *
   * 收款（核心）
   * ------------------------------------------------------------------ */

  /**
   * 在同一事务内落支付单（§17.2 / §17.3）。
   *
   * - `cash` / `wechat_offline` / `alipay_offline` → 直接 `success`（现金可多收 = 找零）；
   * - `balance` → 条件更新扣储值余额 → 落 `success`；
   * - `card` → 核销次卡一次 → 落 `amount=0` 的 `success`；
   * - `wxpay_native` / `alipay_qr` → 先落 `pending`（`expire_at` = now + qrExpireMinutes)
   *   → 渠道统一下单 → 写 `biz_payment_log(create)` → 返回 `code_url`；
   *   渠道未配置直接抛 `ConflictException`，同一事务回滚**不留 pending 单**；
   * - `credit` 由 `CreditPort`（挂账）处理，本方法拒绝。
   */
  /**
   * **事务外**准备在线渠道订单（离线渠道返回 `null`）。
   *
   * ## 为什么必须放在事务外
   *
   * 渠道下单是网络 IO（超时 5 秒）。原先它在 `createInTx` 里、也就是在
   * **调用方的事务内**执行 —— 结算流程还是「一个事务里循环下多笔 + 之后还要
   * recalc/落会员流水」，等于**持着连接与行锁等渠道回包**。
   * 现在把顺序倒过来：**先在事务外下单拿到 `code_url` 与交易号 → 再进事务落库**。
   *
   * ## 代价（可接受，已确认）
   *
   * 事务最终回滚时，渠道侧会留下一张**没人看到过**的待支付单（`code_url` 没返回给
   * 任何客户端），5 分钟后自然过期 —— 不会有钱流，也不影响对账。
   *
   * ## 渠道未配置
   *
   * 直接抛错（`provider.createNativeOrder` 内部先校验 `configured`）。
   * 调用方在**写任何本地数据之前**调它，于是「未配置 → 不留 pending 单」
   * 从「靠事务回滚」升级成「根本没开始」。
   */
  async prepareChannelOrder(
    draft: PaymentDraft,
  ): Promise<PreparedChannelOrder | null> {
    const channel = toPaymentChannel(draft.channel);
    if (!isOnlineChannel(channel)) return null;
    const provider = this.providerFor(channel);
    const paymentConfig = await this.bizConfig.payment();
    const now = new Date();
    const expireAt = new Date(
      now.getTime() + paymentConfig.qrExpireMinutes * 60_000,
    );
    // 与主键无关的交易号：下单时还没有本地单（主键要 INSERT 之后才有）
    const outTradeNo = buildOutTradeNoByToken('P');
    const order = await provider.createNativeOrder({
      outTradeNo,
      amount: Math.trunc(draft.amount),
      description: `${PURPOSE_LABELS[draft.purpose] ?? '收款'} ${outTradeNo}`,
      expireAt,
      notifyUrl: this.notifyUrlOf(channel),
    });
    return { outTradeNo, codeUrl: order.codeUrl, expireAt, raw: order.raw };
  }

  /**
   * 批量准备（按顺序执行，结果与入参**下标对齐**；离线渠道为 `null`）。
   *
   * 调用方在事务外先调它，事务内把 `prepared[index]` 作为 `draft.channelOrder`
   * 传回 `createInTx` 即可 —— 这样一个事务里循环下多笔时也**不会**在事务里打渠道。
   */
  async prepareChannelOrders(
    drafts: PaymentDraft[],
  ): Promise<(PreparedChannelOrder | null)[]> {
    const results: (PreparedChannelOrder | null)[] = [];
    for (const draft of drafts) {
      results.push(await this.prepareChannelOrder(draft));
    }
    return results;
  }

  async createInTx(
    tx: BizTx,
    draft: PaymentDraft,
    actorId: number | null = null,
  ): Promise<PaymentOutcome> {
    if (draft.channel === 'credit')
      throw new BadRequestException('挂账请使用 creditAccountId');
    const channel = toPaymentChannel(draft.channel);
    const requestedAmount = Math.trunc(draft.amount);
    if (!Number.isFinite(requestedAmount) || requestedAmount < 0)
      throw new BadRequestException('金额不合法');
    // 次卡核销不产生金额（§17.1）：支付单 amount / received_amount 一律为 0
    const amount = channel === 'card' ? 0 : requestedAmount;
    const onlineChannel: OnlineChannel | null = isOnlineChannel(channel)
      ? channel
      : null;
    const isOnline = onlineChannel !== null;
    const bookingId = draft.bookingId ?? null;
    const receivedAmount =
      channel === 'card' ? 0 : Math.trunc(draft.receivedAmount ?? amount);
    if (receivedAmount < 0) throw new BadRequestException('实收金额不合法');
    // 现金允许多收（找零），其它渠道实收不得超过应收
    if (channel !== 'cash' && receivedAmount > amount)
      throw new BadRequestException('实收金额不得超过应收金额');
    if (channel === 'card' && !draft.memberCardId)
      throw new BadRequestException('次卡核销必须指定 memberCardId');

    // 在线渠道的单必须**已经在事务外备好**（渠道下单是网络 IO，不能持事务等它）
    const prepared = draft.channelOrder ?? null;
    if (isOnline && !prepared)
      throw new BadRequestException(
        '在线渠道必须先调 prepareChannelOrder（渠道下单不能在事务里做）',
      );

    const timezone = (await this.bizConfig.booking()).timezone;
    const now = new Date();
    const expireAt = prepared ? prepared.expireAt : null;

    // 1) 储值扣减必须**先于**支付单 INSERT：全局锁顺序 biz_customer → biz_payment（§6.6）
    if (channel === 'balance') {
      await this.members.applyBalancePayment(tx, {
        customerId: draft.customerId,
        amount,
        bookingId,
        remark:
          draft.remark ??
          (bookingId === null ? '储值支付' : `预约 #${bookingId} 储值支付`),
        actorId,
      });
    }

    // 2) 落单（pending / success），单号在主键回填前用一次性占位保证 UNIQUE 不冲突
    const inserted = await tx.insert(bizPayments).values({
      paymentNo: temporaryToken(),
      // 在线渠道的交易号在**事务外**就定好了（渠道下单要用它）；离线渠道仍回填主键
      outTradeNo: prepared ? prepared.outTradeNo : temporaryToken(),
      // 收款门店由入口解析好传进来（见 `PaymentDraft.storeId` 的注释）
      storeId: draft.storeId,
      bookingId,
      customerId: draft.customerId,
      purpose: draft.purpose,
      channel,
      amount,
      // 在线渠道的实收在「下单时」即确定：回调只改状态与渠道字段（§6.6 幂等闸门）
      receivedAmount: receivedAmount,
      status: isOnline ? 'pending' : 'success',
      codeUrl: prepared ? prepared.codeUrl : null,
      transactionId: null,
      paidAt: isOnline ? null : now,
      expireAt,
      refundedAmount: 0,
      callbackAt: null,
      remark: draft.remark ?? null,
      createdBy: actorId,
      updatedBy: actorId,
    });
    const id = Number(inserted[0].insertId);
    const paymentNo = buildDocNo('P', id, timezone, now);
    const outTradeNo = prepared
      ? prepared.outTradeNo
      : buildOutTradeNo('P', id, now);
    await tx
      .update(bizPayments)
      .set(prepared ? { paymentNo } : { paymentNo, outTradeNo })
      .where(eq(bizPayments.id, id));

    // 3) 次卡核销在支付单之后：锁顺序 biz_payment → biz_member_card（§6.6）
    if (channel === 'card') {
      const serviceItemId = await this.requireServiceItemId(tx, bookingId);
      await this.memberCards.useCard(tx, {
        cardId: draft.memberCardId ?? 0,
        serviceItemId,
        bookingId,
        actorId,
      });
    }

    // 4) 在线渠道的 `code_url` **已经在事务外拿到**（见 prepareChannelOrder）：
    //    这里只落库，不做任何网络 IO —— 事务里绝不能再出现渠道调用。
    const codeUrl = prepared ? prepared.codeUrl : null;

    await this.insertLog(tx, id, 'create', {
      channel,
      purpose: draft.purpose,
      amount,
      receivedAmount,
      status: isOnline ? 'pending' : 'success',
      codeUrl,
      expireAt: expireAt?.toISOString() ?? null,
      operator: actorId,
      // 在线渠道把下单原始应答一并留证
      ...(prepared ? { channelRaw: prepared.raw } : {}),
    });

    return {
      paymentId: id,
      paymentNo,
      outTradeNo,
      status: isOnline ? 'pending' : 'success',
      channel,
      amount,
      receivedAmount,
      codeUrl,
      expireAt,
    };
  }

  /**
   * 独立收款项（充值 / 购卡 / 销账等）：自己开事务。
   *
   * **门店在这一层解析**（入口有操作人）：显式传的 draft.storeId 优先，
   * 否则取当前账号的门店；未分配门店的账号会在这里 403。
   */
  async create(
    draft: Omit<PaymentDraft, 'storeId'> & { storeId?: number | null },
    actor: RequestActor,
  ): Promise<PaymentOutcome> {
    const storeId = await requireCurrentStoreId(
      this.database.db,
      actor,
      draft.storeId ?? null,
    );
    return this.database.db.transaction((tx) =>
      this.createInTx(tx, { ...draft, storeId }, actor.id),
    );
  }

  /**
   * 关掉某预约下所有 `pending` 支付单（重新收款前调用，§17.3）。
   *
   * 条件更新当闸门：与回调同时发生时，只有一方的影响行数为 1。
   */
  async closePendingOfBooking(
    tx: BizTx,
    bookingId: number,
    actorId: number | null = null,
  ): Promise<{ closed: number }> {
    const rows = await tx
      .select({ id: bizPayments.id })
      .from(bizPayments)
      .where(
        and(
          eq(bizPayments.bookingId, bookingId),
          eq(bizPayments.status, 'pending'),
        ),
      );
    let closed = 0;
    for (const row of rows) {
      const affected = await tx
        .update(bizPayments)
        .set({ status: 'closed', updatedBy: actorId })
        .where(
          and(eq(bizPayments.id, row.id), eq(bizPayments.status, 'pending')),
        );
      if (!affected[0].affectedRows) continue;
      closed += 1;
      await this.insertLog(tx, row.id, 'close', {
        reason: 'recollect',
        operator: actorId,
      });
    }
    return { closed };
  }

  /* ------------------------------------------------------------------ *
   * 回调 / 查单
   * ------------------------------------------------------------------ */

  /**
   * 渠道回调（公开端点，自己做验签，§6.6 / §17.3）。
   *
   * 顺序：验签 → 校验支付单存在 → 校验**金额一致** → 条件更新（幂等闸门）
   * → 同一事务发货 → 事务提交后再发通知 → 返回渠道应答。
   *
   * 金额不一致：写 `biz_payment_log(event='callback_invalid')` 并**拒绝**，
   * 绝不按回调金额改账；重复回调（影响行数 0）直接返回成功，不重复发货。
   */
  async handleNotify(
    channel: OnlineChannel,
    raw: {
      headers: Record<string, string | string[] | undefined>;
      body: unknown;
      rawBody?: string | undefined;
    },
  ): Promise<{ statusCode: number; body: string }> {
    let provider: PaymentChannelProvider;
    try {
      provider = this.providerFor(channel);
    } catch (error) {
      // 通道未配置：返回失败应答，绝不放行
      return this.failureReplyOf(channel, messageOf(error), 'business');
    }
    if (!provider.configured)
      return this.failureReplyOf(
        channel,
        `${provider.label}通道未启用`,
        'business',
      );

    let payload: {
      outTradeNo: string;
      transactionId: string;
      amount: number;
      successTime: Date;
      raw: unknown;
    };
    try {
      payload = await provider.verifyNotify({
        headers: raw.headers,
        body: raw.body,
        rawBody: raw.rawBody,
      });
    } catch (error) {
      this.logger.warn(`[${channel}] 回调验签/解析失败：${messageOf(error)}`);
      return provider.failureReply(messageOf(error), 'verify');
    }

    const [payment] = await this.database.db
      .select()
      .from(bizPayments)
      .where(eq(bizPayments.outTradeNo, payload.outTradeNo))
      .limit(1);
    if (!payment) {
      this.logger.warn(`[${channel}] 回调订单不存在：${payload.outTradeNo}`);
      return provider.failureReply('支付单不存在', 'business');
    }

    if (payload.amount !== payment.amount) {
      await this.insertLog(this.database.db, payment.id, 'callback_invalid', {
        reason: 'amount_mismatch',
        expected: payment.amount,
        actual: payload.amount,
        transactionId: payload.transactionId,
      });
      this.logger.warn(
        `[${channel}] 回调金额不一致：单 ${payment.paymentNo} 应收 ${payment.amount} 回调 ${payload.amount}`,
      );
      return provider.failureReply('回调金额与订单不一致', 'business');
    }

    const settleStartedAt = Date.now();
    const settled = await this.database.db.transaction((tx) =>
      this.settlePayment(tx, payment, {
        transactionId: payload.transactionId,
        successTime: payload.successTime,
        amount: payload.amount,
        raw: payload.raw,
      }),
    );
    const settleMs = Date.now() - settleStartedAt;
    if (settleMs > CALLBACK_SLOW_SETTLE_MS) {
      this.logger.warn(
        `回调落账耗时 ${settleMs}ms（超过 ${CALLBACK_SLOW_SETTLE_MS}ms）：` +
          `单 ${payment.paymentNo}；微信要求 5 秒内应答，超时会被重投（幂等，不会重复发货）`,
      );
    }
    // affectedRows=0：重复 / 并发回调，直接答成功（渠道会重试，绝不能抛错）
    if (settled) void this.sendPaidNotice(payment).catch(() => undefined);
    return provider.successReply();
  }

  /** 主动查单（回调丢失兜底，§17.3 第 4 步；与回调复用同一段幂等落地） */
  async queryPending(): Promise<{ checked: number; settled: number }> {
    const now = new Date();
    // 关单/失败后**继续查 24 小时**：覆盖「最后一刻付款成功但回调丢了」。
    // 代价是会给渠道多发几次查询（每 2 分钟一批、上限 200 条），
    // 换来的是「钱收了但本地没记」不会拖到第二天对账才发现。
    const lookbackFrom = new Date(now.getTime() - QUERY_LOOKBACK_MS);
    const rows = await this.database.db
      .select({ id: bizPayments.id })
      .from(bizPayments)
      .where(
        and(
          inArray(bizPayments.status, SETTLE_FROM_STATUSES),
          inArray(bizPayments.channel, ONLINE_CHANNELS),
          // 未过期的照常查；过期后 24 小时内继续查
          gt(bizPayments.expireAt, lookbackFrom),
          // 已经拿到渠道交易号的说明落过账，不必再查
          isNull(bizPayments.transactionId),
        ),
      )
      // 最近过期的先查（最可能是「刚付款但回调丢了」的那批）
      .orderBy(desc(bizPayments.expireAt))
      .limit(200);
    let settled = 0;
    for (const row of rows) {
      try {
        const result = await this.queryChannel(row.id, null);
        if (result.status === 'success') settled += 1;
      } catch (error) {
        this.logger.warn(`支付单 ${row.id} 查单失败：${messageOf(error)}`);
      }
    }
    return { checked: rows.length, settled };
  }

  /** 单笔主动查单：成功走与回调同一条幂等落地（禁止两份实现） */
  async queryChannel(
    id: number,
    actorId: number | null,
  ): Promise<{ status: string }> {
    const payment = await this.requirePayment(id);
    if (!isOnlineChannel(payment.channel))
      throw new BadRequestException('该支付单不是在线支付，无需查单');
    // 只有「已经收到钱」与「已经退过款」才算真定局；**closed / failed 要继续查** ——
    // 本地关单不等于渠道关单，顾客可能在最后一刻付款成功而回调丢了。
    if (!(SETTLE_FROM_STATUSES as readonly string[]).includes(payment.status))
      return { status: payment.status };
    const provider = this.providerFor(payment.channel);
    const state = await provider.queryOrder(payment.outTradeNo);

    if (state.status !== 'success') {
      if (state.status === 'failed' || state.status === 'closed') {
        const next = state.status === 'failed' ? 'failed' : 'closed';
        await this.database.db.transaction(async (tx) => {
          const affected = await tx
            .update(bizPayments)
            .set({ status: next, updatedBy: actorId })
            .where(
              and(
                eq(bizPayments.id, payment.id),
                eq(bizPayments.status, 'pending'),
              ),
            );
          if (!affected[0].affectedRows) return;
          await this.insertLog(tx, payment.id, 'query', {
            result: next,
            raw: state.raw,
            operator: actorId,
          });
        });
      }
      return { status: state.status === 'pending' ? 'pending' : state.status };
    }

    if (state.amount !== payment.amount) {
      await this.insertLog(this.database.db, payment.id, 'callback_invalid', {
        reason: 'query_amount_mismatch',
        expected: payment.amount,
        actual: state.amount,
        transactionId: state.transactionId,
      });
      throw new ConflictException('渠道金额与支付单不一致，请人工核对');
    }
    if (!state.transactionId)
      throw new ConflictException('渠道未返回交易号，无法落地');

    const settled = await this.database.db.transaction((tx) =>
      this.settlePayment(
        tx,
        payment,
        {
          transactionId: state.transactionId ?? '',
          successTime: state.paidAt ?? new Date(),
          amount: state.amount,
          raw: state.raw,
        },
        'query',
      ),
    );
    if (settled) void this.sendPaidNotice(payment).catch(() => undefined);
    return { status: 'success' };
  }

  /**
   * **唯一的支付成功落地**（回调与查单共用，§6.6 第 1、3 条）。
   *
   * ```
   * UPDATE biz_payment SET status='success', transaction_id=?, paid_at=?, callback_at=NOW()
   *  WHERE out_trade_no=? AND status='pending'
   * ```
   * 影响行数为 0 → 已处理过（重复 / 并发 / 已关单），直接放弃；
   * 影响行数为 1 → 同一事务内「发货」：预约资金重算 + 会员消费落账 + 通知记录（pending）。
   */
  private async settlePayment(
    tx: BizTx,
    payment: PaymentRow,
    input: SettleInput,
    event: 'callback' | 'query' = 'callback',
  ): Promise<boolean> {
    const affected = await tx
      .update(bizPayments)
      .set({
        status: 'success',
        transactionId: input.transactionId,
        paidAt: input.successTime,
        callbackAt: new Date(),
      })
      .where(
        and(
          eq(bizPayments.outTradeNo, payment.outTradeNo),
          // 允许从 closed / failed 落地（见 SETTLE_FROM_STATUSES 注释）
          inArray(bizPayments.status, SETTLE_FROM_STATUSES),
        ),
      );
    if (!affected[0].affectedRows) return false;
    if (payment.status !== 'pending') {
      this.logger.warn(
        `支付单 ${payment.paymentNo} 由 ${payment.status} 重新落地为 success` +
          '（迟到的支付成功：本地已关单/失败，但渠道确实收到了钱）',
      );
    }

    await this.insertLog(tx, payment.id, event, {
      transactionId: input.transactionId,
      amount: input.amount,
      successTime: input.successTime.toISOString(),
      raw: input.raw,
      // 迟到落地要留痕：对账/复盘时能看出「这单曾被我方关单又救回来」
      ...(payment.status === 'pending'
        ? {}
        : { reopenedFrom: payment.status as string }),
    });
    await this.deliver(tx, payment, null);
    return true;
  }

  /** 「发货」：预约资金重算 + 会员消费落账 + 通知入队（全部在同一事务内） */
  private async deliver(
    tx: BizTx,
    payment: PaymentRow,
    actorId: number | null,
  ): Promise<void> {
    if (payment.bookingId !== null)
      await this.settlement.recalc(tx, payment.bookingId);
    if (payment.receivedAmount > 0 && payment.channel !== 'card') {
      await this.members.recordConsumption(tx, {
        customerId: payment.customerId,
        paidAmount: payment.receivedAmount,
        bookingId: payment.bookingId,
        payChannel: memberPayChannel(payment.channel),
        remark: `支付单 ${payment.paymentNo}`,
        actorId,
      });
    }
    // 通知只在**事务提交后**发送（`sendPaidNotice`），失败回滚不了账务也不阻塞回调应答。
    // 这里不再额外 `enqueueInTx`：否则会同时留下一条 pending 与一条已发送日志（双写），
    // pending 那条永远不会被 flush（`retryFailed` 只认 failed）。
  }

  /* ------------------------------------------------------------------ *
   * 关单 / 列表 / 详情
   * ------------------------------------------------------------------ */

  /**
   * 超时关单（定时任务，§11）：`status='pending' AND expire_at < now` → `closed`。
   *
   * 与回调竞争时谁先改状态谁生效，另一方影响行数为 0 自然放弃（§6.6 第 4 条）。
   * 只改状态、不碰钱（§15.7 不变量 5）。
   */
  async closeExpired(): Promise<{ closed: number }> {
    const now = new Date();
    const rows = await this.database.db
      .select({ id: bizPayments.id })
      .from(bizPayments)
      .where(
        and(eq(bizPayments.status, 'pending'), lt(bizPayments.expireAt, now)),
      )
      .orderBy(asc(bizPayments.id))
      .limit(500);
    if (!rows.length) return { closed: 0 };
    return this.database.db.transaction(async (tx) => {
      let closed = 0;
      for (const row of rows) {
        const affected = await tx
          .update(bizPayments)
          .set({ status: 'closed' })
          .where(
            and(eq(bizPayments.id, row.id), eq(bizPayments.status, 'pending')),
          );
        if (!affected[0].affectedRows) continue;
        closed += 1;
        await this.insertLog(tx, row.id, 'close', { reason: 'expired' });
      }
      return { closed };
    });
  }

  /** 手动关单（仅 `pending`） */
  async close(id: number, actorId: number): Promise<void> {
    await this.requirePayment(id);
    await this.database.db.transaction(async (tx) => {
      const affected = await tx
        .update(bizPayments)
        .set({ status: 'closed', updatedBy: actorId })
        .where(and(eq(bizPayments.id, id), eq(bizPayments.status, 'pending')));
      if (!affected[0].affectedRows)
        throw new ConflictException('只有待支付的支付单可以关单');
      await this.insertLog(tx, id, 'close', {
        reason: 'manual',
        operator: actorId,
      });
    });
  }

  async list(
    page: number,
    pageSize: number,
    filter: PaymentListFilter,
    /** 传操作人时按可见门店过滤（店长只看本店收款；超管可按 storeId 筛） */
    actor?: RequestActor,
  ): Promise<{ items: PaymentListItem[]; page: number; pageSize: number }> {
    const timezone = (await this.bizConfig.booking()).timezone;
    const conditions = [isNull(bizPayments.deletedAt)];
    if (actor) {
      const store = await resolveStoreScope(
        this.database.db,
        actor,
        filter.storeId ?? null,
      );
      conditions.push(
        ...storeConditions(bizPayments.storeId, store, filter.storeId),
      );
    }
    if (filter.channel)
      conditions.push(eq(bizPayments.channel, filter.channel));
    if (filter.status) conditions.push(eq(bizPayments.status, filter.status));
    if (filter.purpose)
      conditions.push(eq(bizPayments.purpose, filter.purpose));
    if (filter.customerId)
      conditions.push(eq(bizPayments.customerId, filter.customerId));
    if (filter.bookingId)
      conditions.push(eq(bizPayments.bookingId, filter.bookingId));
    const range = localDateRange(
      bizPayments.createdAt,
      filter.dateFrom,
      filter.dateTo,
      timezone,
    );
    if (range) conditions.push(range);
    if (filter.bookingNo) {
      const keyword = filter.bookingNo.trim();
      if (keyword)
        conditions.push(
          inArray(
            bizPayments.bookingId,
            this.database.db
              .select({ id: bizBookings.id })
              .from(bizBookings)
              .where(like(bizBookings.bookingNo, `%${keyword}%`)),
          ),
        );
    }
    const items = await this.database.db
      .select({
        payment: bizPayments,
        bookingNo: bizBookings.bookingNo,
        customerName: bizCustomers.name,
      })
      .from(bizPayments)
      .leftJoin(bizBookings, eq(bizBookings.id, bizPayments.bookingId))
      .leftJoin(bizCustomers, eq(bizCustomers.id, bizPayments.customerId))
      .where(and(...conditions))
      .orderBy(desc(bizPayments.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return {
      items: items.map((row) => ({
        ...row.payment,
        bookingNo: row.bookingNo,
        customerName: row.customerName,
      })),
      page,
      pageSize,
    };
  }

  async findOne(id: number): Promise<PaymentRow & { logs: PaymentLogRow[] }> {
    const payment = await this.requirePayment(id);
    const logs = await this.database.db
      .select()
      .from(bizPaymentLogs)
      .where(eq(bizPaymentLogs.paymentId, id))
      .orderBy(asc(bizPaymentLogs.id));
    // 只对**出参**脱敏：库里的 `raw` 保持原样（留证），店员接口不带顾客标识
    return {
      ...payment,
      logs: logs.map((log) => ({ ...log, raw: redactChannelRaw(log.raw) })),
    };
  }

  async statusOf(
    id: number,
  ): Promise<{ id: number; status: string; paidAt: Date | null }> {
    const [row] = await this.database.db
      .select({
        id: bizPayments.id,
        status: bizPayments.status,
        paidAt: bizPayments.paidAt,
      })
      .from(bizPayments)
      .where(and(eq(bizPayments.id, id), isNull(bizPayments.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundException('支付单不存在');
    return row;
  }

  /** 渠道对账（§17.5）：实现在 `PaymentDiffsService`，这里只做端口转发 */
  async reconcile(billDate: string): Promise<{ diffs: number }> {
    return this.diffs.reconcile(billDate);
  }

  /* ------------------------------------------------------------------ *
   * 内部工具
   * ------------------------------------------------------------------ */

  async requirePayment(id: number): Promise<PaymentRow> {
    const [payment] = await this.database.db
      .select()
      .from(bizPayments)
      .where(and(eq(bizPayments.id, id), isNull(bizPayments.deletedAt)))
      .limit(1);
    if (!payment) throw new NotFoundException('支付单不存在');
    return payment;
  }

  private providerFor(channel: string): PaymentChannelProvider {
    if (channel === 'wxpay_native') {
      if (!this.wxpayNative.configured)
        throw new ConflictException('微信支付通道未启用');
      return this.wxpayNative;
    }
    if (channel === 'alipay_qr') {
      if (!this.alipayQr.configured)
        throw new ConflictException('支付宝通道未启用');
      return this.alipayQr;
    }
    throw new BadRequestException(`不支持的在线支付渠道：${channel}`);
  }

  /**
   * 失败应答转发。
   *
   * `kind` 必须如实传：**微信 V3 靠 HTTP 状态码表达受理结果**，
   * 验签失败回 200 会被当成「接收成功」而不再重投（详见 provider 注释）。
   */
  private failureReplyOf(
    channel: OnlineChannel,
    message: string,
    kind: ChannelFailureKind,
  ): { statusCode: number; body: string } {
    const provider =
      channel === 'wxpay_native' ? this.wxpayNative : this.alipayQr;
    return provider.failureReply(message, kind);
  }

  private notifyUrlOf(channel: OnlineChannel): string | null {
    return channel === 'wxpay_native'
      ? (this.appConfig.wxpay.notifyUrl ?? null)
      : (this.appConfig.alipay.notifyUrl ?? null);
  }

  /** 次卡核销需要 `serviceItemId`（端口签名要求）；按预约第一个项目核销 */
  private async requireServiceItemId(
    tx: BizTx,
    bookingId: number | null,
  ): Promise<number> {
    if (bookingId === null)
      throw new BadRequestException('次卡核销必须关联预约');
    const [item] = await tx
      .select({ serviceItemId: bizBookingItems.serviceItemId })
      .from(bizBookingItems)
      .where(eq(bizBookingItems.bookingId, bookingId))
      .orderBy(asc(bizBookingItems.sort), asc(bizBookingItems.id))
      .limit(1);
    if (!item) throw new BadRequestException('预约没有项目明细，无法核销次卡');
    return item.serviceItemId;
  }

  private describePayment(draft: PaymentDraft, paymentNo: string): string {
    const label = PURPOSE_LABELS[draft.purpose] ?? '收款';
    return `${label} ${paymentNo}`;
  }

  private async insertLog(
    executor: BizExecutor,
    paymentId: number,
    event:
      | 'create'
      | 'callback'
      | 'query'
      | 'close'
      | 'refund'
      | 'callback_invalid',
    raw: unknown,
    httpStatus: number | null = null,
  ): Promise<void> {
    await executor.insert(bizPaymentLogs).values({
      paymentId,
      event,
      httpStatus,
      raw,
    });
  }

  private async sendPaidNotice(payment: PaymentRow): Promise<void> {
    const templateCode = PAID_NOTICE_TEMPLATES[payment.purpose];
    if (!templateCode) return;
    try {
      await this.notices.send({
        templateCode,
        recipientType: 'customer',
        recipientId: payment.customerId,
        variables: {
          amount: (payment.receivedAmount / 100).toFixed(2),
          paymentNo: payment.paymentNo,
        },
        bookingId: payment.bookingId,
      });
    } catch (error) {
      this.logger.warn(
        `支付成功通知发送失败（不影响账务）：${messageOf(error)}`,
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * 常量与纯函数
 * ------------------------------------------------------------------ */

const PURPOSE_LABELS: Record<string, string> = {
  deposit: '定金',
  final: '尾款',
  recharge: '储值充值',
  card_buy: '次卡购买',
  credit_settle: '挂账销账',
};

/**
 * 付款成功通知模板（§19.1 / §19.2）。
 *
 * 内置模板里只有 `recharge_success` 是「涉及金额」的，因此在线充值 / 购卡 / 销账走它；
 * 预约收款（定金 / 尾款）的通知由预约链路（`booking_created`）负责，这里不重复发。
 */
const PAID_NOTICE_TEMPLATES: Partial<Record<PaymentDraft['purpose'], string>> =
  {
    recharge: 'recharge_success',
    card_buy: 'recharge_success',
    credit_settle: 'recharge_success',
  };

function isOnlineChannel(channel: string): channel is OnlineChannel {
  return channel === 'wxpay_native' || channel === 'alipay_qr';
}

/** 端口类型 `PayChannel` → `biz_payment.channel` 列取值（`wechat` / `alipay` 不是合法列值） */
function toPaymentChannel(channel: PayChannel): PaymentChannel {
  if (channel === 'wechat' || channel === 'alipay')
    throw new BadRequestException(
      '在线收款请使用 wxpay_native / alipay_qr，店家收款码请使用 wechat_offline / alipay_offline',
    );
  // 列上已预留，但 provider 没有 —— 收进来会被当成线下渠道直接置成功（钱没到账却已核销）
  if (channel === 'wxpay_jsapi')
    throw new BadRequestException('小程序 JSAPI 支付尚未接入（C1）');
  return channel;
}

/** `biz_member_transaction.pay_channel` 只有 5 个值，在线渠道要归并到 wechat / alipay */
function memberPayChannel(
  channel: PayChannel,
): 'cash' | 'wechat' | 'alipay' | 'balance' | 'card' | null {
  switch (channel) {
    case 'cash':
      return 'cash';
    case 'wechat':
    case 'wechat_offline':
    case 'wxpay_native':
    case 'wxpay_jsapi':
      return 'wechat';
    case 'alipay':
    case 'alipay_offline':
    case 'alipay_qr':
      return 'alipay';
    case 'balance':
      return 'balance';
    case 'card':
      return 'card';
    default:
      return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
