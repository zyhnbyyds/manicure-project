import {
  ConflictException,
  Injectable,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import {
  X509Certificate,
  createDecipheriv,
  createPublicKey,
  createSign,
  createVerify,
  randomUUID,
} from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { AppConfigService } from '../../../../config/app-config.service.js';
import {
  DEFAULT_SHOP_TIMEZONE,
  formatShopDateTime,
  shopLocalToUtc,
} from '../../common/shop-time.js';
import {
  type ChannelBillRecord,
  type ChannelOrderState,
  type ChannelRefundInput,
  type ChannelRefundResult,
  type NativeOrderInput,
  type NativeOrderResult,
  type NotifyPayload,
  type NotifyVerifyInput,
  PaymentChannelProvider,
  ChannelFailureKind,
} from './channel.interface.js';
import type { ChannelReply } from './channel.interface.js';

/** 微信支付 APIv3 网关 */
const WXPAY_BASE_URL = 'https://api.mch.weixin.qq.com';
/** 平台证书缓存时长（12 小时，官方建议定期刷新） */
const PLATFORM_CERT_TTL_MS = 12 * 60 * 60 * 1000;
/** 回调时间戳容差（秒），防重放 */
const NOTIFY_CLOCK_SKEW_SECONDS = 300;
/** 单次 HTTP 请求超时（毫秒）；回调处理必须在渠道 3 秒超时内应答，故取 5 秒并靠事务外的关单兜底 */
const REQUEST_TIMEOUT_MS = 5000;
/**
 * 出站调用最多尝试次数（含首次）。
 *
 * 为什么敢重试：本 provider 的写操作都以**商户单号**为幂等键 ——
 * 下单用 `out_trade_no`、退款用 `out_refund_no`，同号重试微信返回同一笔；
 * 查单是 GET。所以「请求超时但实际已成功」也不会重复扣款/重复退款。
 */
const REQUEST_MAX_ATTEMPTS = 3;
/** 重试退避基数（第 n 次重试等 n × 基数） */
const REQUEST_RETRY_BASE_MS = 200;

type WxpayCredential = {
  appId: string;
  mchId: string;
  serialNo: string;
  privateKey: string;
  apiV3Key: string;
  notifyUrl: string | null;
};

/**
 * 微信支付 Native 扫码（§17.1）。
 *
 * 真实协议骨架：`Authorization: WECHATPAY2-SHA256-RSA2048` 签名、`/v3/pay/transactions/native`
 * 统一下单、`/v3/pay/transactions/out-trade-no/{no}` 查单、`/v3/refund/domestic/refunds` 退款、
 * `/v3/certificates` 下载并解密平台证书后验签回调、`/v3/bill/tradebill` 下载账单。
 *
 * 密钥未配置时 `configured = false`，所有方法抛 `ConflictException('微信支付通道未启用')`，
 * 绝不用假数据放行。
 */
@Injectable()
export class WxpayNativeProvider extends PaymentChannelProvider {
  readonly channel = 'wxpay_native' as const;
  readonly label = '微信支付';

  private readonly logger = new Logger(WxpayNativeProvider.name);
  /** serial_no → 平台证书公钥（SPKI PEM） */
  private platformKeys = new Map<string, string>();
  private platformLoadedAt = 0;
  /** 最近一次渠道调用的 Request-Id（排障用） */
  private lastRequestId: string | null = null;

  constructor(private readonly appConfig: AppConfigService) {
    super();
  }

  get configured(): boolean {
    return this.appConfig.wxpay.configured;
  }

  async createNativeOrder(input: NativeOrderInput): Promise<NativeOrderResult> {
    const credential = this.credential();
    const body = {
      appid: credential.appId,
      mchid: credential.mchId,
      description: input.description.slice(0, 127),
      out_trade_no: input.outTradeNo,
      // 渠道要求 RFC3339 带偏移；店内时区即东八区
      time_expire: formatShopDateTime(input.expireAt, DEFAULT_SHOP_TIMEZONE),
      ...(input.notifyUrl ? { notify_url: input.notifyUrl } : {}),
      amount: { total: input.amount, currency: 'CNY' },
    };
    const { status, data } = await this.request(
      'POST',
      '/v3/pay/transactions/native',
      body,
    );
    const codeUrl = textField(data, 'code_url');
    if (status >= 400 || !codeUrl)
      throw new ConflictException(
        `微信支付下单失败：${this.failureText(data, status)}`,
      );
    return { codeUrl, expireAt: input.expireAt, raw: data };
  }

  async queryOrder(outTradeNo: string): Promise<ChannelOrderState> {
    const credential = this.credential();
    const urlPath =
      `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}` +
      `?mchid=${encodeURIComponent(credential.mchId)}`;
    const { status, data } = await this.request('GET', urlPath);
    // 订单不存在：可能下单请求没到达渠道，保持 pending 交由关单任务处理
    if (status === 404)
      return {
        status: 'pending',
        transactionId: null,
        amount: 0,
        paidAt: null,
        raw: data,
      };
    if (status >= 400)
      throw new ConflictException(
        `微信支付查单失败：${this.failureText(data, status)}`,
      );

    const tradeState = textField(data, 'trade_state');
    const mapped: ChannelOrderState['status'] =
      tradeState === 'SUCCESS'
        ? 'success'
        : tradeState === 'CLOSED' || tradeState === 'REVOKED'
          ? 'closed'
          : tradeState === 'PAYERROR'
            ? 'failed'
            : 'pending';
    return {
      status: mapped,
      transactionId: textField(data, 'transaction_id') ?? null,
      amount: nestedNumber(data, ['amount', 'total']) ?? 0,
      paidAt: parseChannelInstant(textField(data, 'success_time')),
      raw: data,
    };
  }

  async refund(input: ChannelRefundInput): Promise<ChannelRefundResult> {
    const { status, data } = await this.request(
      'POST',
      '/v3/refund/domestic/refunds',
      {
        out_trade_no: input.outTradeNo,
        out_refund_no: input.outRefundNo,
        reason: input.reason.slice(0, 80),
        amount: {
          refund: input.refundAmount,
          total: input.totalAmount,
          currency: 'CNY',
        },
      },
    );
    if (status >= 400)
      throw new ConflictException(
        `微信支付退款失败：${this.failureText(data, status)}`,
      );
    const refundStatus = textField(data, 'status');
    return {
      channelRefundId: textField(data, 'refund_id') ?? null,
      status:
        refundStatus === 'SUCCESS'
          ? 'success'
          : refundStatus === 'PROCESSING'
            ? 'processing'
            : 'failed',
      raw: data,
    };
  }

  async verifyNotify(input: NotifyVerifyInput): Promise<NotifyPayload> {
    const credential = this.credential();
    const signature = headerValue(input.headers, 'wechatpay-signature');
    const timestamp = headerValue(input.headers, 'wechatpay-timestamp');
    const nonce = headerValue(input.headers, 'wechatpay-nonce');
    const serial = headerValue(input.headers, 'wechatpay-serial');
    if (!signature || !timestamp || !nonce)
      throw new BadRequestException('微信支付回调缺少验签头');

    const seconds = Number(timestamp);
    if (
      !Number.isFinite(seconds) ||
      Math.abs(Date.now() / 1000 - seconds) > NOTIFY_CLOCK_SKEW_SECONDS
    )
      throw new BadRequestException('微信支付回调时间戳超出容差');

    // 微信签名串必须使用**原样**报文；Nest 未开启 rawBody 时退化为重新序列化（见交付说明）
    const rawBody = input.rawBody ?? JSON.stringify(input.body ?? {});
    const publicKey = await this.platformPublicKey(serial);
    const verified = createVerify('RSA-SHA256')
      .update(`${timestamp}\n${nonce}\n${rawBody}\n`)
      .verify(publicKey, signature, 'base64');
    if (!verified) throw new BadRequestException('微信支付回调验签失败');

    const body = asRecord(input.body) ?? {};
    const resource = asRecord(body['resource']);
    if (!resource) throw new BadRequestException('微信支付回调缺少 resource');
    const plaintext = decryptResource(resource, credential.apiV3Key);
    const data = asRecord(safeJsonParse(plaintext));
    if (!data) throw new BadRequestException('微信支付回调解密失败');

    const tradeState = textField(data, 'trade_state');
    if (tradeState !== 'SUCCESS')
      throw new BadRequestException(`非支付成功通知：${tradeState ?? '未知'}`);

    const outTradeNo = textField(data, 'out_trade_no');
    const transactionId = textField(data, 'transaction_id');
    const amount = nestedNumber(data, ['amount', 'total']);
    const successTime = parseChannelInstant(textField(data, 'success_time'));
    if (!outTradeNo || !transactionId || amount === undefined || !successTime)
      throw new BadRequestException('微信支付回调字段不完整');
    return {
      outTradeNo,
      transactionId,
      amount,
      successTime,
      raw: { event_type: body['event_type'] ?? null, resource: data },
    };
  }

  async downloadBill(billDate: string): Promise<ChannelBillRecord[]> {
    if (!this.configured) {
      this.logger.warn('微信支付通道未配置，跳过账单下载');
      return [];
    }
    try {
      const urlPath =
        `/v3/bill/tradebill?bill_date=${encodeURIComponent(billDate)}` +
        `&bill_type=ALL&tar_type=GZIP`;
      const { status, data } = await this.request('GET', urlPath);
      const downloadUrl = textField(data, 'download_url');
      if (status >= 400 || !downloadUrl) {
        this.logger.warn(
          `微信支付账单不可得（${billDate}）：${this.failureText(data, status)}`,
        );
        return [];
      }
      const response = await fetch(downloadUrl, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 4),
      });
      if (!response.ok) {
        this.logger.warn(`微信支付账单下载失败：HTTP ${response.status}`);
        return [];
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      return parseWxpayBillCsv(decodeGzip(buffer));
    } catch (error) {
      this.logger.warn(`微信支付账单解析失败：${messageOf(error)}`);
      return [];
    }
  }

  successReply(): ChannelReply {
    return {
      statusCode: 200,
      body: JSON.stringify({ code: 'SUCCESS', message: '成功' }),
    };
  }

  /**
   * 失败应答 —— **必须 4xx/5xx，绝不能回 200**。
   *
   * 微信 V3 的约定是「**HTTP 状态码**表达受理结果」：
   * - 验签**通过** → 200/204，微信不再重投；
   * - 验签**不通过** → **4xx/5xx**，微信按
   *   `15s/15s/30s/3m/10m/20m/30m/30m/30m/60m/3h/3h/3h/6h/6h` **重投 15 次**（约 24 小时）。
   *
   * 回 200 会有两个真实后果：
   * 1. 「平台证书尚未缓存好 / 时钟偏差」这类**重投就能成功**的情形被我们自己关掉，
   *    这笔支付再也落不了账（只剩主动查单兜底）；
   * 2. 微信会下发签名值带 `WECHATPAY/SIGNTEST/` 前缀的**探测流量**来检验商户是否真的验签，
   *    对它回 200 等于告诉微信「我验签失败也当成功」—— 官方明确的安全隐患。
   *
   * 注：`{code:'FAIL'}` 那套 body 语义是 **APIv2** 的约定，V3 不看它（body 只为排障留痕）。
   */
  failureReply(message: string, kind: ChannelFailureKind): ChannelReply {
    return {
      // 验签/解密失败 → 401（未通过鉴权）；业务不接受 → 400
      statusCode: kind === 'verify' ? 401 : 400,
      body: JSON.stringify({ code: 'FAIL', message: message.slice(0, 200) }),
    };
  }

  /* ------------------------------------------------------------------ *
   * 内部：凭据 / 签名 / 请求
   * ------------------------------------------------------------------ */

  private credential(): WxpayCredential {
    const wxpay = this.appConfig.wxpay;
    if (!wxpay.configured) throw new ConflictException('微信支付通道未启用');
    const privateKey = toPem(wxpay.privateKey ?? '', 'PRIVATE KEY');
    const apiV3Key = wxpay.apiV3Key ?? '';
    if (Buffer.byteLength(apiV3Key, 'utf8') !== 32)
      throw new ConflictException('微信支付 APIv3 密钥必须为 32 位');
    return {
      appId: wxpay.appId ?? '',
      mchId: wxpay.mchId ?? '',
      serialNo: wxpay.serialNo ?? '',
      privateKey,
      apiV3Key,
      notifyUrl: wxpay.notifyUrl ?? null,
    };
  }

  /** `WECHATPAY2-SHA256-RSA2048` 签名（`方法\nURL\n时间戳\n随机串\n报文\n`） */
  private signatureOf(privateKey: string, message: string): string {
    return createSign('RSA-SHA256').update(message).sign(privateKey, 'base64');
  }

  /**
   * 调微信 API：**有界重试 + `Request-Id` 留痕**。
   *
   * ## 为什么要重试
   * 只有超时、没有重试时，一次瞬时抖动就直接失败：下单失败要店员重来；
   * 退款失败更糟 —— `refunds.service` 会把它标成 `failed` 并**把重试责任推给人**
   * （「可重试或改为现金退」）。
   *
   * ## 重试边界（很重要）
   * - **网络异常 / 超时** → 重试；
   * - **5xx / 429** → 重试（服务端瞬时问题）；
   * - **4xx** → **不重试**（参数错、签名错、余额不足……重试多少次都一样）。
   *
   * ## Request-Id
   * 微信应答头带 `Request-Id`。失败时记进日志与报错文案，
   * 微信侧凭它可以直接定位到那一次调用，是排障最快的线索。
   */
  private async request(
    method: 'GET' | 'POST',
    urlPath: string,
    body?: unknown,
  ): Promise<{ status: number; data: unknown }> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= REQUEST_MAX_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.requestOnce(method, urlPath, body);
        const transient = result.status >= 500 || result.status === 429;
        if (transient && attempt < REQUEST_MAX_ATTEMPTS) {
          this.logger.warn(
            `微信支付 ${method} ${urlPath} 返回 ${result.status}，第 ${attempt} 次重试`,
          );
          await this.sleep(REQUEST_RETRY_BASE_MS * attempt);
          continue;
        }
        return result;
      } catch (error) {
        lastError = error;
        if (attempt < REQUEST_MAX_ATTEMPTS) {
          this.logger.warn(
            `微信支付 ${method} ${urlPath} 调用异常：${messageOfError(error)}，第 ${attempt} 次重试`,
          );
          await this.sleep(REQUEST_RETRY_BASE_MS * attempt);
          continue;
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new ConflictException('微信支付调用失败');
  }

  /** 单次调用（不重试） */
  private async requestOnce(
    method: 'GET' | 'POST',
    urlPath: string,
    body?: unknown,
  ): Promise<{ status: number; data: unknown }> {
    const credential = this.credential();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomUUID().replaceAll('-', '');
    const payload = body === undefined ? '' : JSON.stringify(body);
    const signature = this.signatureOf(
      credential.privateKey,
      `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${payload}\n`,
    );
    const authorization =
      'WECHATPAY2-SHA256-RSA2048 ' +
      `mchid="${credential.mchId}",nonce_str="${nonce}",signature="${signature}",` +
      `timestamp="${timestamp}",serial_no="${credential.serialNo}"`;

    const response = await fetch(`${WXPAY_BASE_URL}${urlPath}`, {
      method,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'manicure-booking/1.0',
        authorization,
      },
      ...(payload ? { body: payload } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    const requestId =
      response.headers.get('request-id') ?? response.headers.get('Request-Id');
    if (requestId) this.lastRequestId = requestId;
    if (response.status >= 400) {
      this.logger.warn(
        `微信支付 ${method} ${urlPath} → ${response.status}` +
          `（Request-Id ${requestId ?? '未返回'}）`,
      );
    }
    return { status: response.status, data: safeJsonParse(text) };
  }

  /**
   * 报错文案 + 最近一次调用的 `Request-Id`。
   *
   * 微信客服/工单只要这一个 id 就能定位到那次请求，比让商户描述时间点高效得多。
   */
  private failureText(data: unknown, status: number): string {
    const base = describeFailure(data, status);
    return this.lastRequestId ? `${base}（Request-Id ${this.lastRequestId}）` : base;
  }

  /** 重试退避（测试里可 stub 掉，避免真的等待） */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  /** 平台证书公钥（按 `Wechatpay-Serial` 取，带 12 小时缓存） */
  private async platformPublicKey(serial: string | null): Promise<string> {
    const stale = Date.now() - this.platformLoadedAt > PLATFORM_CERT_TTL_MS;
    if (stale || this.platformKeys.size === 0) await this.loadPlatformKeys();
    const key = serial
      ? this.platformKeys.get(serial)
      : [...this.platformKeys.values()][0];
    if (!key)
      throw new BadRequestException('找不到对应的微信支付平台证书，无法验签');
    return key;
  }

  private async loadPlatformKeys(): Promise<void> {
    const credential = this.credential();

    // 本地注入优先：内网 / 集成测试拿不到微信的 `/v3/certificates`，
    // 配了 `WXPAY_PLATFORM_PUBLIC_KEY` 就完全不走网络。
    const localPem = this.appConfig.wxpay.platformPublicKey;
    if (localPem) {
      const spki = toSpkiPublicKey(unescapePem(localPem));
      if (spki) {
        this.platformKeys = new Map([[credential.serialNo, spki]]);
        this.platformLoadedAt = Date.now();
        return;
      }
      this.logger.warn('WXPAY_PLATFORM_PUBLIC_KEY 不是合法的公钥/证书，回退到联网下载');
    }

    const { status, data } = await this.request('GET', '/v3/certificates');
    if (status >= 400)
      throw new ConflictException(
        `微信支付平台证书下载失败：${this.failureText(data, status)}`,
      );
    const list = asRecord(data)?.['data'];
    const keys = new Map<string, string>();
    if (Array.isArray(list)) {
      for (const item of list) {
        const record = asRecord(item);
        if (!record) continue;
        const serial = textField(record, 'serial_no');
        const encrypted = asRecord(record['encrypt_certificate']);
        if (!serial || !encrypted) continue;
        try {
          const pem = decryptResource(encrypted, credential.apiV3Key);
          const certificate = new X509Certificate(pem);
          keys.set(
            serial,
            certificate.publicKey
              .export({ type: 'spki', format: 'pem' })
              .toString(),
          );
        } catch (error) {
          this.logger.warn(`平台证书解密失败：${messageOf(error)}`);
        }
      }
    }
    if (keys.size === 0)
      throw new ConflictException('微信支付平台证书为空，无法验签');
    this.platformKeys = keys;
    this.platformLoadedAt = Date.now();
  }
}

/* ------------------------------------------------------------------ *
 * 纯函数工具
 * ------------------------------------------------------------------ */

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw ?? null;
}

/** 把可能的 base64 / 单行密钥补成 PEM */
/** env 里塞不进真实换行，约定用字面 `\n` 转义 */
function unescapePem(raw: string): string {
  return raw.includes('\\n') ? raw.replaceAll('\\n', '\n') : raw;
}

/**
 * 把「X509 证书 PEM」或「SPKI 公钥 PEM」统一成 SPKI 公钥 PEM。
 * 两者都收：微信官方给的是证书，自己造测试密钥时只有公钥。
 */
function toSpkiPublicKey(pem: string): string | null {
  try {
    return new X509Certificate(pem)
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
  } catch {
    // 不是证书，按公钥再试一次
  }
  try {
    return createPublicKey(pem)
      .export({ type: 'spki', format: 'pem' })
      .toString();
  } catch {
    return null;
  }
}

function toPem(raw: string, type: string): string {
  const value = raw.includes('\\n') ? raw.replaceAll('\\n', '\n') : raw;
  if (value.includes('-----BEGIN')) return value;
  const lines = value.replaceAll(/\s+/g, '').match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${type}-----\n${lines.join('\n')}\n-----END ${type}-----`;
}

/** APIv3 的 AES-256-GCM 报文解密（回调 resource 与平台证书共用） */
function decryptResource(
  encrypted: Record<string, unknown>,
  apiV3Key: string,
): string {
  const ciphertext = Buffer.from(
    textField(encrypted, 'ciphertext') ?? '',
    'base64',
  );
  const authTag = ciphertext.subarray(ciphertext.length - 16);
  const payload = ciphertext.subarray(0, ciphertext.length - 16);
  const nonce = textField(encrypted, 'nonce') ?? '';
  const associated = textField(encrypted, 'associated_data');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(apiV3Key, 'utf8'),
    Buffer.from(nonce, 'utf8'),
  );
  decipher.setAuthTag(authTag);
  if (associated) decipher.setAAD(Buffer.from(associated, 'utf8'));
  return Buffer.concat([decipher.update(payload), decipher.final()]).toString(
    'utf8',
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textField(value: unknown, key: string): string | undefined {
  const record = asRecord(value);
  const field = record?.[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

function nestedNumber(value: unknown, path: string[]): number | undefined {
  let current: unknown = value;
  for (const key of path) {
    current = asRecord(current)?.[key];
  }
  return typeof current === 'number' && Number.isFinite(current)
    ? current
    : undefined;
}

function safeJsonParse(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** 渠道 RFC3339（带偏移）→ Date；非法/空返回 null */
function parseChannelInstant(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** 微信账单里的时间固定为北京时间 `YYYY-MM-DD HH:MM:SS` */
function parseBillLocalTime(value: string): Date | null {
  if (value.length < 19) return null;
  try {
    return shopLocalToUtc(
      value.slice(0, 10),
      value.slice(11, 19),
      DEFAULT_SHOP_TIMEZONE,
    );
  } catch {
    return null;
  }
}

function messageOfError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeFailure(data: unknown, status: number): string {
  const code = textField(data, 'code');
  const message = textField(data, 'message');
  if (code || message) return `${code ?? status} ${message ?? ''}`.trim();
  return typeof data === 'string' && data
    ? data.slice(0, 200)
    : `HTTP ${status}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeGzip(buffer: Buffer): string {
  try {
    return gunzipSync(buffer).toString('utf8');
  } catch {
    // 未启用 GZIP 时渠道直接返回纯文本 CSV
    return buffer.toString('utf8');
  }
}

/**
 * 解析微信「交易账单」CSV。
 *
 * 列序（官方 v3 账单，金额单位：`订单金额` 为分）：
 * `0 交易时间,1 公众账号ID,2 商户号,3 特约商户号,4 设备号,5 微信订单号,6 商户订单号,
 *  7 用户标识,8 交易类型,9 交易状态,…,24 订单金额`
 * 汇总行以 `` ` `` 开头，遇到即结束。
 */
function parseWxpayBillCsv(csv: string): ChannelBillRecord[] {
  const records: ChannelBillRecord[] = [];
  const lines = csv.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line || line.startsWith('`')) break;
    if (index === 0 && line.includes('交易时间')) continue;
    const columns = splitCsvLine(line);
    if (columns.length < 25) continue;
    const outTradeNo = columns[6] ?? '';
    const transactionId = columns[5] ?? '';
    if (!outTradeNo || !transactionId) continue;
    const tradeState = columns[9] ?? '';
    const amount = Number(columns[24] ?? '');
    records.push({
      outTradeNo,
      transactionId,
      amount: Number.isFinite(amount) ? Math.trunc(amount) : 0,
      status:
        tradeState === 'SUCCESS'
          ? 'success'
          : tradeState === 'REFUND'
            ? 'refunded'
            : tradeState === 'CLOSED' || tradeState === 'REVOKED'
              ? 'closed'
              : 'failed',
      paidAt: parseBillLocalTime(columns[0] ?? ''),
    });
  }
  return records;
}

/** 支持双引号包裹的 CSV 行拆分（账单里商品名常含逗号） */
function splitCsvLine(line: string): string[] {
  const columns: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === ',' && !quoted) {
      columns.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  columns.push(current);
  return columns.map((value) => value.trim());
}
