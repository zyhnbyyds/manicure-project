/**
 * 支付渠道抽象（§17）。
 *
 * B3 只对接两个**在线**渠道：微信 Native 扫码（`wxpay_native`）与支付宝当面付（`alipay_qr`）。
 * 线下收款（`cash` / `wechat_offline` / `alipay_offline`）、储值（`balance`）、次卡（`card`）
 * 只记账不走渠道，因此**没有**对应 Provider。
 *
 * 约定：
 * - 金额一律整数「分」；时间一律 `Date`（UTC 存储）；
 * - 未配置密钥时 `configured = false`，调用方抛 `ConflictException('xx通道未启用')`，
 *   **不允许**用假数据放行（回调未配置密钥时必须返回失败应答，见 `verifyNotify`）；
 * - 渠道原始报文一律通过返回值带回，由 service 写进 `biz_payment_log.raw` 留证。
 */

/** 在线渠道（与 `biz_payment.channel` 的枚举值对齐） */
export type OnlineChannel = 'wxpay_native' | 'alipay_qr';

/**
 * 失败应答的类别 —— **决定 HTTP 状态码，两个渠道的要求完全不同**。
 *
 * - `verify`：验签 / 解密 / 报文解析失败（没通过鉴权）
 * - `business`：验签通过，但业务上不接受（订单不存在、金额不一致、通道未启用）
 */
export type ChannelFailureKind = 'verify' | 'business';

/** 统一下单入参 */
export type NativeOrderInput = {
  /** 商户订单号（`buildOutTradeNo('P', id)`，全局唯一，回调按它匹配） */
  outTradeNo: string;
  /** 应收金额（分） */
  amount: number;
  /** 商品描述（渠道账单单据上的摘要） */
  description: string;
  /** 二维码失效时间（`now + biz.payment.qrExpireMinutes`） */
  expireAt: Date;
  /** 回调地址；未配置时为 null（渠道会拒绝无 notify_url 的下单） */
  notifyUrl: string | null;
};

export type NativeOrderResult = {
  /** 二维码内容：微信 `code_url` / 支付宝 `qr_code` */
  codeUrl: string;
  expireAt: Date;
  /** 渠道原始应答（脱敏后写入 `biz_payment_log.raw`） */
  raw: unknown;
};

/** 渠道侧的订单状态（与本地 `biz_payment.status` 的映射在 service 里做） */
export type ChannelOrderState = {
  status: 'pending' | 'success' | 'failed' | 'closed';
  /** 渠道交易号 */
  transactionId: string | null;
  /** 渠道侧金额（分） */
  amount: number;
  /** 支付成功时间（以渠道时间为准） */
  paidAt: Date | null;
  raw: unknown;
};

export type ChannelRefundInput = {
  outTradeNo: string;
  /** 商户退款单号（= `biz_refund.refund_no`，渠道侧幂等键） */
  outRefundNo: string;
  /** 原支付单总额（分） */
  totalAmount: number;
  /** 本次退款金额（分） */
  refundAmount: number;
  reason: string;
};

export type ChannelRefundResult = {
  channelRefundId: string | null;
  status: 'success' | 'processing' | 'failed';
  raw: unknown;
};

/** 回调验签入参 */
export type NotifyVerifyInput = {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  /**
   * 原始报文字符串。
   *
   * 微信 V3 的签名串是 `timestamp\nnonce\nbody\n`，`body` 必须是**原样字节**；
   * Nest 默认不保留 rawBody，此时退化为 `JSON.stringify(body)`（见交付说明的 TODO）。
   * 支付宝用表单参数排序后验签，不依赖原始报文。
   */
  rawBody?: string | undefined;
};

/** 验签 + 解密后的支付成功事实 */
export type NotifyPayload = {
  outTradeNo: string;
  transactionId: string;
  /** 渠道侧金额（分），用于与 `biz_payment.amount` 比对 */
  amount: number;
  /** 渠道侧支付成功时间 */
  successTime: Date;
  /** 渠道原始报文（脱敏） */
  raw: unknown;
};

/** 渠道账单的一笔（对账用） */
export type ChannelBillRecord = {
  outTradeNo: string;
  transactionId: string;
  /** 渠道侧金额（分） */
  amount: number;
  status: 'success' | 'refunded' | 'failed' | 'closed';
  paidAt: Date | null;
};

/** 给渠道的应答体 */
export type ChannelReply = { statusCode: number; body: string };

export abstract class PaymentChannelProvider {
  /** 渠道标识（与 `biz_payment.channel` 对齐） */
  abstract readonly channel: OnlineChannel;

  /** 中文名，用于错误提示（如「微信支付」） */
  abstract readonly label: string;

  /** 密钥 / 证书是否齐全；false 时业务侧抛「通道未启用」 */
  abstract get configured(): boolean;

  /** 统一下单，返回二维码内容 */
  abstract createNativeOrder(
    input: NativeOrderInput,
  ): Promise<NativeOrderResult>;

  /** 主动查单（回调丢失时兜底） */
  abstract queryOrder(outTradeNo: string): Promise<ChannelOrderState>;

  /** 原路退款 */
  abstract refund(input: ChannelRefundInput): Promise<ChannelRefundResult>;

  /**
   * 回调验签 + 解密/解析。
   *
   * 验签失败、未配置密钥、非「支付成功」事件一律抛错（调用方转成渠道失败应答）。
   */
  abstract verifyNotify(input: NotifyVerifyInput): Promise<NotifyPayload>;

  /**
   * 下载指定日期的渠道账单。
   *
   * 渠道未配置或账单不可得时返回 `[]`（对账任务据此跳过该渠道并记日志），
   * **不抛错**——对账失败不该把定时任务打成 failure。
   */
  abstract downloadBill(billDate: string): Promise<ChannelBillRecord[]>;

  /** 渠道要求的成功应答（微信 JSON / 支付宝 `success` 纯文本） */
  abstract successReply(): ChannelReply;

  /**
   * 渠道要求的失败应答（**必须让渠道重试**，且必须可幂等重放）。
   *
   * ⚠️ 微信 V3 与支付宝的约定**不同**，实现里必须分开：
   * - **微信 V3**：HTTP 状态码表达受理结果 —— 验签不通过**必须** 4xx/5xx，
   *   回 200 会被当成「接收成功」而不再重投（详见 provider 注释）；
   * - **支付宝**：固定 HTTP 200，用**响应体文本**表达（返回 `success` 才停止重投）。
   */
  abstract failureReply(message: string, kind: ChannelFailureKind): ChannelReply;
}
