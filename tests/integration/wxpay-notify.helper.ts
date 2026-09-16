/**
 * 造一份**能被真验签通过**的微信支付 V3 回调报文。
 *
 * 为什么单独放一个文件：`/app/payments/wxpay/notify`（A13）与后台
 * `/biz/payments/notify/wxpay`（B3，之前只有单测）要用同一套报文，
 * 各写一份迟早会长歪。
 *
 * 签的是「原样报文」：`${timestamp}\n${nonce}\n${rawBody}\n`。
 * 这里刻意用 `JSON.stringify` 之后**不再二次序列化**的字符串当 rawBody
 * ——正是生产上最容易踩的那一点（键顺序敏感）。
 */
import {
  createCipheriv,
  createSign,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { wxpayTestCredential } from './harness';

export type NotifyInput = {
  outTradeNo: string;
  transactionId?: string;
  /** 分 */
  amount: number;
  successTime?: Date;
  /** 造错报文用（如 `NOTPAY` → 应被拒） */
  tradeState?: string;
};

export type SignedNotify = {
  headers: Record<string, string>;
  body: unknown;
  rawBody: string;
  /** 明文里的 `transaction_id`，供断言「渠道流水号真的落库了」 */
  transactionId: string;
};

/** AES-256-GCM 加密，与 provider 的 `decryptResource` 严格对称（密文尾部 16 字节是 tag） */
function encryptResource(plaintext: string, apiV3Key: string, nonce: string) {
  const cipher = createCipheriv(
    'aes-256-gcm',
    Buffer.from(apiV3Key, 'utf8'),
    Buffer.from(nonce, 'utf8'),
  );
  cipher.setAAD(Buffer.from('transaction', 'utf8'));
  const payload = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([payload, authTag]).toString('base64');
}

/** 微信要求 RFC3339（带时区偏移）的北京时间 */
function rfc3339(date: Date): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
}

export function buildWxpayNotify(input: NotifyInput): SignedNotify {
  const credential = wxpayTestCredential();
  const data = {
    appid: 'wx_test_appid',
    mchid: '1900000000',
    out_trade_no: input.outTradeNo,
    transaction_id: input.transactionId ?? `4200${randomUUID().slice(0, 24)}`,
    trade_type: 'JSAPI',
    trade_state: input.tradeState ?? 'SUCCESS',
    trade_state_desc: '支付成功',
    bank_type: 'OTHERS',
    success_time: rfc3339(input.successTime ?? new Date()),
    amount: { total: input.amount, currency: 'CNY', payer_total: input.amount },
  };

  const nonce = randomBytes(12).toString('hex').slice(0, 12);
  const resource = {
    algorithm: 'AEAD_AES_256_GCM',
    ciphertext: encryptResource(
      JSON.stringify(data),
      credential.apiV3Key,
      nonce,
    ),
    nonce,
    associated_data: 'transaction',
    original_type: 'transaction',
  };

  const body = {
    id: randomUUID(),
    create_time: rfc3339(new Date()),
    event_type: 'TRANSACTION.SUCCESS',
    resource_type: 'encrypt-resource',
    summary: '支付成功',
    resource,
  };
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signatureNonce = randomBytes(8).toString('hex');

  const signature = createSign('RSA-SHA256')
    .update(`${timestamp}\n${signatureNonce}\n${rawBody}\n`)
    .sign(credential.privateKeyPem, 'base64');

  return {
    headers: {
      'content-type': 'application/json',
      'wechatpay-signature': signature,
      'wechatpay-timestamp': timestamp,
      'wechatpay-nonce': signatureNonce,
      'wechatpay-serial': credential.serialNo,
    },
    body,
    rawBody,
    transactionId: data.transaction_id,
  };
}

/** 篡改签名：把最后一个字符换掉，用来验「验签失败必须拒绝」 */
export function tamperSignature(notify: SignedNotify): SignedNotify {
  const signature = notify.headers['wechatpay-signature'] ?? '';
  return {
    ...notify,
    headers: {
      ...notify.headers,
      'wechatpay-signature': `${signature.slice(0, -2)}xy`,
    },
  };
}
