import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { createSign, createVerify } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
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

/** 支付宝开放平台网关 */
const ALIPAY_GATEWAY = 'https://openapi.alipay.com/gateway.do';
const REQUEST_TIMEOUT_MS = 5000;

type AlipayCredential = {
  appId: string;
  privateKey: string;
  publicKey: string;
  notifyUrl: string | null;
};

/**
 * 支付宝当面付（预下单 / 扫码，§17.1）。
 *
 * 真实协议骨架：`RSA2(SHA256withRSA)` 签名、`alipay.trade.precreate` 预下单拿 `qr_code`、
 * `alipay.trade.query` 查单、`alipay.trade.refund` 退款、`alipay.data.dataservice.bill.downloadurl.query`
 * 取账单下载地址（ZIP/CSV 解析）、回调按「去掉 sign/sign_type 后按 key 升序拼接」验签。
 *
 * 密钥未配置时 `configured = false`，方法抛 `ConflictException('支付宝通道未启用')`。
 */
@Injectable()
export class AlipayQrProvider extends PaymentChannelProvider {
  readonly channel = 'alipay_qr' as const;
  readonly label = '支付宝';

  private readonly logger = new Logger(AlipayQrProvider.name);

  constructor(private readonly appConfig: AppConfigService) {
    super();
  }

  get configured(): boolean {
    return this.appConfig.alipay.configured;
  }

  async createNativeOrder(input: NativeOrderInput): Promise<NativeOrderResult> {
    const minutes = Math.max(
      Math.ceil((input.expireAt.getTime() - Date.now()) / 60_000),
      1,
    );
    const data = await this.call('alipay.trade.precreate', {
      out_trade_no: input.outTradeNo,
      total_amount: centsToYuan(input.amount),
      subject: input.description.slice(0, 256),
      timeout_express: `${minutes}m`,
    });
    const qrCode = textField(data, 'qr_code');
    if (textField(data, 'code') !== '10000' || !qrCode)
      throw new ConflictException(`支付宝下单失败：${describeFailure(data)}`);
    return { codeUrl: qrCode, expireAt: input.expireAt, raw: data };
  }

  async queryOrder(outTradeNo: string): Promise<ChannelOrderState> {
    const data = await this.call(
      'alipay.trade.query',
      { out_trade_no: outTradeNo },
      true,
    );
    const code = textField(data, 'code');
    // 交易不存在：保持 pending，交由关单任务兜底
    if (code === 'ACQ.TRADE_NOT_EXIST')
      return {
        status: 'pending',
        transactionId: null,
        amount: 0,
        paidAt: null,
        raw: data,
      };
    if (code !== '10000')
      throw new ConflictException(`支付宝查单失败：${describeFailure(data)}`);

    const tradeStatus = textField(data, 'trade_status');
    return {
      status:
        tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED'
          ? 'success'
          : tradeStatus === 'TRADE_CLOSED'
            ? 'closed'
            : 'pending',
      transactionId: textField(data, 'trade_no') ?? null,
      amount: yuanToCents(textField(data, 'total_amount')),
      paidAt: parseBillLocalTime(textField(data, 'send_pay_date')),
      raw: data,
    };
  }

  async refund(input: ChannelRefundInput): Promise<ChannelRefundResult> {
    const data = await this.call('alipay.trade.refund', {
      out_trade_no: input.outTradeNo,
      refund_amount: centsToYuan(input.refundAmount),
      out_request_no: input.outRefundNo,
      refund_reason: input.reason.slice(0, 256),
    });
    if (textField(data, 'code') !== '10000')
      throw new ConflictException(`支付宝退款失败：${describeFailure(data)}`);
    return {
      // 支付宝退款结果按 `out_request_no` 幂等，响应里没有独立退款单号
      channelRefundId: input.outRefundNo,
      status: 'success',
      raw: data,
    };
  }

  async verifyNotify(input: NotifyVerifyInput): Promise<NotifyPayload> {
    const credential = this.credential();
    const params = asRecord(input.body);
    if (!params) throw new BadRequestException('支付宝回调报文格式不正确');
    const sign = textField(params, 'sign');
    if (!sign) throw new BadRequestException('支付宝回调缺少 sign');
    const signType = textField(params, 'sign_type');
    if (signType && signType !== 'RSA2')
      throw new BadRequestException(`不支持的签名算法：${signType}`);

    const content = canonicalParams(params);
    const verified = createVerify('RSA-SHA256')
      .update(content, 'utf8')
      .verify(credential.publicKey, sign, 'base64');
    if (!verified) throw new BadRequestException('支付宝回调验签失败');

    const appId = textField(params, 'app_id');
    if (appId && appId !== credential.appId)
      throw new BadRequestException('支付宝回调 app_id 不匹配');

    const tradeStatus = textField(params, 'trade_status');
    if (tradeStatus !== 'TRADE_SUCCESS' && tradeStatus !== 'TRADE_FINISHED')
      throw new BadRequestException(`非支付成功通知：${tradeStatus ?? '未知'}`);

    const outTradeNo = textField(params, 'out_trade_no');
    const transactionId = textField(params, 'trade_no');
    const amount = yuanToCents(textField(params, 'total_amount'));
    const successTime = parseBillLocalTime(
      textField(params, 'gmt_payment') ?? textField(params, 'notify_time'),
    );
    if (!outTradeNo || !transactionId || amount <= 0 || !successTime)
      throw new BadRequestException('支付宝回调字段不完整');
    return { outTradeNo, transactionId, amount, successTime, raw: params };
  }

  async downloadBill(billDate: string): Promise<ChannelBillRecord[]> {
    if (!this.configured) {
      this.logger.warn('支付宝通道未配置，跳过账单下载');
      return [];
    }
    try {
      const data = await this.call(
        'alipay.data.dataservice.bill.downloadurl.query',
        {
          bill_type: 'trade',
          bill_date: billDate,
        },
      );
      const url = textField(data, 'bill_download_url');
      if (textField(data, 'code') !== '10000' || !url) {
        this.logger.warn(
          `支付宝账单不可得（${billDate}）：${describeFailure(data)}`,
        );
        return [];
      }
      const response = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 4),
      });
      if (!response.ok) {
        this.logger.warn(`支付宝账单下载失败：HTTP ${response.status}`);
        return [];
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      // 官方账单是 ZIP（内含 GBK 编码 CSV），个别环境直接给 CSV
      const csv =
        buffer.subarray(0, 2).toString('latin1') === 'PK'
          ? decodeGbk(extractFirstZipEntry(buffer) ?? Buffer.alloc(0))
          : decodeGbk(buffer);
      return parseAlipayBillCsv(csv);
    } catch (error) {
      this.logger.warn(`支付宝账单解析失败：${messageOf(error)}`);
      return [];
    }
  }

  successReply(): ChannelReply {
    return { statusCode: 200, body: 'success' };
  }

  /**
   * 失败应答。**支付宝与微信不同**：HTTP 固定 200，用**响应体文本**表达 ——
   * 返回 `success` 才停止重投，其它内容（这里是 `failure`）支付宝会重试。
   * 所以 `kind` 不影响这里的状态码（保留参数只为两个渠道共用同一套契约）。
   */
  failureReply(message: string, _kind: ChannelFailureKind): ChannelReply {
    this.logger.warn(`支付宝回调失败应答：${message}`);
    return { statusCode: 200, body: 'failure' };
  }

  /* ------------------------------------------------------------------ *
   * 内部：凭据 / 签名 / 请求
   * ------------------------------------------------------------------ */

  private credential(): AlipayCredential {
    const alipay = this.appConfig.alipay;
    if (!alipay.configured) throw new ConflictException('支付宝通道未启用');
    return {
      appId: alipay.appId ?? '',
      privateKey: toPem(alipay.privateKey ?? '', 'PRIVATE KEY'),
      publicKey: toPem(alipay.publicKey ?? '', 'PUBLIC KEY'),
      notifyUrl: alipay.notifyUrl ?? null,
    };
  }

  /**
   * 调用开放平台接口。
   *
   * `tolerateBusinessError` = true 时把业务错误码原样返回给调用方判断（查单要区分「交易不存在」）。
   */
  private async call(
    method: string,
    bizContent: Record<string, unknown>,
    tolerateBusinessError = false,
  ): Promise<Record<string, unknown>> {
    const credential = this.credential();
    const params: Record<string, string> = {
      app_id: credential.appId,
      method,
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: shopTimestamp(new Date()),
      version: '1.0',
      biz_content: JSON.stringify(bizContent),
    };
    if (
      credential.notifyUrl &&
      method !== 'alipay.data.dataservice.bill.downloadurl.query'
    )
      params['notify_url'] = credential.notifyUrl;

    const signature = createSign('RSA-SHA256')
      .update(canonicalParams(params), 'utf8')
      .sign(credential.privateKey, 'base64');
    const form = new URLSearchParams({ ...params, sign: signature });

    const response = await fetch(ALIPAY_GATEWAY, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok)
      throw new ConflictException(
        `支付宝接口失败：HTTP ${response.status} ${text.slice(0, 200)}`,
      );
    const parsed = asRecord(safeJsonParse(text));
    // 响应节点名 = 方法名里的 `.` 换成 `_`（如 alipay_trade_precreate_response）
    const node = asRecord(parsed?.[`${method.replaceAll('.', '_')}_response`]);
    if (!node)
      throw new ConflictException(
        `支付宝接口响应无法解析：${text.slice(0, 200)}`,
      );
    if (!tolerateBusinessError && textField(node, 'code') !== '10000')
      throw new ConflictException(`支付宝接口失败：${describeFailure(node)}`);
    return node;
  }
}

/* ------------------------------------------------------------------ *
 * 纯函数工具
 * ------------------------------------------------------------------ */

/** 去 `sign` / `sign_type` 后按 key 升序拼 `k=v&k=v`（支付宝签名原串） */
function canonicalParams(params: Record<string, unknown>): string {
  return Object.keys(params)
    .filter((key) => key !== 'sign' && key !== 'sign_type')
    .filter((key) => params[key] !== undefined && params[key] !== null)
    .sort()
    .map((key) => `${key}=${String(params[key])}`)
    .join('&');
}

/** 北京时间戳 `yyyy-MM-dd HH:mm:ss` */
function shopTimestamp(now: Date): string {
  return formatShopDateTime(now, DEFAULT_SHOP_TIMEZONE)
    .replace('T', ' ')
    .slice(0, 19);
}

/** 分 → 元（两位小数字符串） */
function centsToYuan(cents: number): string {
  return (Math.trunc(cents) / 100).toFixed(2);
}

/** 元 → 分（四舍五入） */
function yuanToCents(yuan: string | undefined): number {
  if (!yuan) return 0;
  const value = Number(yuan);
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

function toPem(raw: string, type: string): string {
  const value = raw.includes('\\n') ? raw.replaceAll('\\n', '\n') : raw;
  if (value.includes('-----BEGIN')) return value;
  const lines = value.replaceAll(/\s+/g, '').match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${type}-----\n${lines.join('\n')}\n-----END ${type}-----`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textField(value: unknown, key: string): string | undefined {
  const field = asRecord(value)?.[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

function safeJsonParse(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function describeFailure(data: unknown): string {
  const record = asRecord(data);
  const code = textField(data, 'code');
  const message =
    textField(data, 'sub_msg') ??
    textField(data, 'msg') ??
    textField(data, 'sub_code');
  if (code || message) return `${code ?? ''} ${message ?? ''}`.trim();
  return record
    ? JSON.stringify(record).slice(0, 200)
    : String(data).slice(0, 200);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 账单/通知里的北京时间 `YYYY-MM-DD HH:MM:SS` 转绝对时刻 */
function parseBillLocalTime(value: string | undefined): Date | null {
  if (!value || value.length < 19) return null;
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

function decodeGbk(buffer: Buffer): string {
  try {
    // Node/Bun 的 TextDecoder 类型只声明了 utf-8 等少数标签，GBK 需显式放宽
    const Decoder = TextDecoder as unknown as new (
      label: string,
    ) => TextDecoder;
    return new Decoder('gbk').decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

/**
 * 取出 ZIP 里的第一个文件内容。
 *
 * 从「中央目录」读压缩大小与本地头偏移（流式 ZIP 的本地头大小字段可能为 0），
 * 支持 `store`(0) 与 `deflate`(8) 两种方式；解析失败返回 null。
 */
function extractFirstZipEntry(buffer: Buffer): Buffer | null {
  try {
    const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) return null;
    const entryCount = buffer.readUInt16LE(eocd + 10);
    if (entryCount < 1) return null;
    const centralOffset = buffer.readUInt32LE(eocd + 16);
    if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) return null;

    const method = buffer.readUInt16LE(centralOffset + 10);
    const compressedSize = buffer.readUInt32LE(centralOffset + 20);
    const nameLength = buffer.readUInt16LE(centralOffset + 28);
    const extraLength = buffer.readUInt16LE(centralOffset + 30);
    const commentLength = buffer.readUInt16LE(centralOffset + 32);
    const localOffset = buffer.readUInt32LE(centralOffset + 42);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) return null;

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const payload = buffer.subarray(dataStart, dataStart + compressedSize);
    void nameLength;
    void extraLength;
    void commentLength;
    return method === 8 ? inflateRawSync(payload) : Buffer.from(payload);
  } catch {
    return null;
  }
}

/**
 * 解析支付宝「交易账单」CSV。
 *
 * 前几行是抬头（账号 / 日期区间），随后一行是表头，按**表头列名**定位字段，
 * 汇总行以 `#` 开头，遇到即结束。金额单位：元。
 */
function parseAlipayBillCsv(csv: string): ChannelBillRecord[] {
  const records: ChannelBillRecord[] = [];
  const lines = csv.split(/\r?\n/);
  let header: string[] | null = null;
  for (const line of lines) {
    if (!line.trim() || line.startsWith('#')) {
      if (header) break;
      continue;
    }
    const columns = splitCsvLine(line);
    if (!header) {
      if (columns.includes('交易号') && columns.includes('商户订单号'))
        header = columns;
      continue;
    }
    const pick = (name: string): string | undefined => {
      const index = header?.indexOf(name) ?? -1;
      return index >= 0 ? columns[index] : undefined;
    };
    const transactionId = pick('交易号');
    const outTradeNo = pick('商户订单号');
    if (!transactionId || !outTradeNo) continue;
    const amount =
      yuanToCents(pick('商家实收')) || yuanToCents(pick('订单金额')) || 0;
    records.push({
      outTradeNo,
      transactionId,
      amount,
      status: 'success',
      paidAt: parseBillLocalTime(pick('完成时间') ?? pick('创建时间')),
    });
  }
  return records;
}

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
