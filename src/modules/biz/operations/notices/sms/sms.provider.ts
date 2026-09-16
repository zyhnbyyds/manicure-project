import { createHmac, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../../../config/app-config.service';

/** 短信发送入参：内容已是**渲染后的最终文本**（不含 `{变量}` 残留，§19.3） */
export type SmsSendInput = {
  phone: string;
  content: string;
  /** 本项目内部模板 code（如 `booking_remind`），供应商报备号映射见 TODO */
  templateCode: string;
};

export type SmsSendResult = { providerMsgId: string };

const SMS_ENDPOINT = 'https://dysmsapi.aliyuncs.com/';
const SMS_TIMEOUT_MS = 5000;

/**
 * 短信通道抽象（同时充当 DI token，见 `operations.module.ts`）。
 *
 * 未配置通道时实现必须**抛错**，由 `NoticesService` 捕获后写 `failed` 日志——
 * 通知失败绝不能冒泡到业务调用方（§19.2 铁律 2）。
 */
export abstract class SmsProvider {
  abstract send(input: SmsSendInput): Promise<SmsSendResult>;
}

/**
 * 阿里云短信（RPC 风格签名）——真实协议骨架：签名 → 请求 → 解析。
 *
 * `appConfig.sms.configured === false`（`SMS_PROVIDER=none` 或凭据缺失）时抛
 * `Error('短信通道未配置')`；开发环境无需真实账号即可跑通站内消息链路。
 */
@Injectable()
export class AliyunSmsProvider extends SmsProvider {
  constructor(private readonly config: AppConfigService) {
    super();
  }

  async send(input: SmsSendInput): Promise<SmsSendResult> {
    const sms = this.config.sms;
    const { accessKeyId, accessKeySecret, signName } = sms;
    if (!sms.configured || !accessKeyId || !accessKeySecret || !signName)
      throw new Error('短信通道未配置');

    const parameters: Record<string, string> = {
      AccessKeyId: accessKeyId,
      Action: 'SendSms',
      Format: 'JSON',
      PhoneNumbers: input.phone,
      RegionId: 'cn-hangzhou',
      SignName: signName,
      SignatureMethod: 'HMAC-SHA1',
      SignatureNonce: randomUUID(),
      SignatureVersion: '1.0',
      TemplateCode: input.templateCode,
      // 短信模板里的业务变量：内容已渲染完成，这里再带一份便于供应商侧排查
      TemplateParam: JSON.stringify({ content: input.content }),
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      Version: '2017-05-25',
    };
    parameters.Signature = signParameters(parameters, accessKeySecret);

    const response = await fetch(SMS_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(parameters).toString(),
      signal: AbortSignal.timeout(SMS_TIMEOUT_MS),
    });
    if (!response.ok)
      throw new Error(
        `短信网关 HTTP ${response.status} ${response.statusText}`,
      );

    const payload = (await response.json()) as {
      Code?: string;
      Message?: string;
      BizId?: string;
      RequestId?: string;
    };
    if (payload.Code !== 'OK')
      throw new Error(
        `短信发送失败：${payload.Code ?? 'UNKNOWN'} ${payload.Message ?? ''}`.trim(),
      );
    return { providerMsgId: payload.BizId ?? payload.RequestId ?? '' };
  }
}

/** `POST&%2F&<规范化查询串>` 的 HMAC-SHA1（阿里云 RPC 签名口径） */
function signParameters(
  parameters: Record<string, string>,
  accessKeySecret: string,
): string {
  const canonical = Object.keys(parameters)
    .sort()
    .map(
      (key) => `${percentEncode(key)}=${percentEncode(parameters[key] ?? '')}`,
    )
    .join('&');
  const stringToSign = `POST&${percentEncode('/')}&${percentEncode(canonical)}`;
  return createHmac('sha1', `${accessKeySecret}&`)
    .update(stringToSign)
    .digest('base64');
}

function percentEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}
