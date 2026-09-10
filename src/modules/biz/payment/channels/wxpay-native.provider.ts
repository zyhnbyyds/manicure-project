import {
  ConflictException,
  Injectable,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import {
  X509Certificate,
  createDecipheriv,
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
        `微信支付下单失败：${describeFailure(data, status)}`,
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
        `微信支付查单失败：${describeFailure(data, status)}`,
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
        `微信支付退款失败：${describeFailure(data, status)}`,
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
          `微信支付账单不可得（${billDate}）：${describeFailure(data, status)}`,
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
   * 失败应答走 **HTTP 200 + `{code:'FAIL'}`**。
   *
   * 微信 V3 的约定是「HTTP 状态码表示传输结果、body 的 code 表示业务处理结果」：
   * 回 5xx 会被当成传输失败并按退避策略反复重投（通道未启用、金额不一致这类
   * 问题重投多少次都不会成功），因此失败也用 200 把原因带回去，只让渠道停止重试。
   */
  failureReply(message: string): ChannelReply {
    return {
      statusCode: 200,
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

  private async request(
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
    return { status: response.status, data: safeJsonParse(text) };
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
    const { status, data } = await this.request('GET', '/v3/certificates');
    if (status >= 400)
      throw new ConflictException(
        `微信支付平台证书下载失败：${describeFailure(data, status)}`,
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
