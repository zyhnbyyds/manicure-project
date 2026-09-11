import { Injectable } from '@nestjs/common';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  API_PREFIX: z.string().default('api/v1'),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url().optional(),
  JWT_ISSUER: z.string().min(1),
  JWT_AUDIENCE: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  UPLOAD_DIR: z.string().default('uploads'),
  SWAGGER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  SWAGGER_PATH: z.string().default('docs'),
  SWAGGER_TITLE: z.string().default('美甲店管理系统 API'),
  SWAGGER_DESCRIPTION: z
    .string()
    .default('美甲店到店预约、会员、收银与经营管理 API'),
  SWAGGER_VERSION: z.string().default('0.1.0'),
  AI_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_BASE_URL: z.string().default('https://api.deepseek.com'),
  DEEPSEEK_MODEL: z.string().default('deepseek-chat'),
  // 小程序（B6 预留）：未配置时 app 域登录返回「小程序端未启用」，不影响进程启动
  WX_MINIAPP_APPID: z.string().optional(),
  WX_MINIAPP_SECRET: z.string().optional(),
  // 微信支付 Native 扫码（B3）：未配置时通道返回「未启用」
  WXPAY_APPID: z.string().optional(),
  WXPAY_MCHID: z.string().optional(),
  WXPAY_SERIAL_NO: z.string().optional(),
  WXPAY_PRIVATE_KEY: z.string().optional(),
  WXPAY_API_V3_KEY: z.string().optional(),
  WXPAY_NOTIFY_URL: z.string().optional(),
  // 支付宝当面付（B3）
  ALIPAY_APP_ID: z.string().optional(),
  ALIPAY_PRIVATE_KEY: z.string().optional(),
  ALIPAY_PUBLIC_KEY: z.string().optional(),
  ALIPAY_NOTIFY_URL: z.string().optional(),
  // 短信通道（B5）：未配置时只写站内消息 + 失败日志，不阻塞业务
  SMS_PROVIDER: z.enum(['none', 'aliyun', 'tencent', 'mock']).default('none'),
  SMS_ACCESS_KEY_ID: z.string().optional(),
  SMS_ACCESS_KEY_SECRET: z.string().optional(),
  SMS_SIGN_NAME: z.string().optional(),
});
export type AppEnvironment = z.infer<typeof envSchema>;

/** 通道配置是否齐全（未配置时业务侧降级而不是启动失败） */
function complete<T extends Record<string, string | undefined>>(
  values: T,
): T & { configured: boolean } {
  return {
    ...values,
    configured: Object.values(values).every(
      (value) => typeof value === 'string' && value.length > 0,
    ),
  };
}

@Injectable()
export class AppConfigService {
  private readonly values: AppEnvironment = envSchema.parse(process.env);
  get port(): number {
    return this.values.PORT;
  }
  get apiPrefix(): string {
    return this.values.API_PREFIX;
  }
  get databaseUrl(): string {
    return this.values.DATABASE_URL;
  }
  get redisUrl(): string | undefined {
    return this.values.REDIS_URL;
  }
  get uploadDir(): string {
    return this.values.UPLOAD_DIR;
  }
  get corsOrigins(): string[] {
    return this.values.CORS_ORIGINS.split(',').map((value) => value.trim());
  }
  get environment(): AppEnvironment['NODE_ENV'] {
    return this.values.NODE_ENV;
  }
  get swagger(): Pick<
    AppEnvironment,
    | 'SWAGGER_ENABLED'
    | 'SWAGGER_PATH'
    | 'SWAGGER_TITLE'
    | 'SWAGGER_DESCRIPTION'
    | 'SWAGGER_VERSION'
  > {
    const {
      SWAGGER_ENABLED,
      SWAGGER_PATH,
      SWAGGER_TITLE,
      SWAGGER_DESCRIPTION,
      SWAGGER_VERSION,
    } = this.values;
    return {
      SWAGGER_ENABLED,
      SWAGGER_PATH,
      SWAGGER_TITLE,
      SWAGGER_DESCRIPTION,
      SWAGGER_VERSION,
    };
  }
  get jwt(): Pick<
    AppEnvironment,
    | 'JWT_ISSUER'
    | 'JWT_AUDIENCE'
    | 'JWT_ACCESS_SECRET'
    | 'JWT_REFRESH_SECRET'
    | 'JWT_ACCESS_TTL'
    | 'JWT_REFRESH_TTL'
  > {
    const {
      JWT_ISSUER,
      JWT_AUDIENCE,
      JWT_ACCESS_SECRET,
      JWT_REFRESH_SECRET,
      JWT_ACCESS_TTL,
      JWT_REFRESH_TTL,
    } = this.values;
    return {
      JWT_ISSUER,
      JWT_AUDIENCE,
      JWT_ACCESS_SECRET,
      JWT_REFRESH_SECRET,
      JWT_ACCESS_TTL,
      JWT_REFRESH_TTL,
    };
  }
  get ai(): Pick<
    AppEnvironment,
    'AI_ENABLED' | 'DEEPSEEK_API_KEY' | 'DEEPSEEK_BASE_URL' | 'DEEPSEEK_MODEL'
  > {
    const { AI_ENABLED, DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL } =
      this.values;
    return {
      AI_ENABLED,
      DEEPSEEK_API_KEY,
      DEEPSEEK_BASE_URL,
      DEEPSEEK_MODEL,
    };
  }
  /** 小程序凭据：`configured=false` 时 app 域登录降级为 503「小程序端未启用」 */
  get wxMiniapp(): {
    appId: string | undefined;
    secret: string | undefined;
    configured: boolean;
  } {
    return complete({
      appId: this.values.WX_MINIAPP_APPID,
      secret: this.values.WX_MINIAPP_SECRET,
    });
  }
  /** 微信支付 Native：`configured=false` 时通道返回「未启用」 */
  get wxpay(): {
    appId: string | undefined;
    mchId: string | undefined;
    serialNo: string | undefined;
    privateKey: string | undefined;
    apiV3Key: string | undefined;
    notifyUrl: string | undefined;
    configured: boolean;
  } {
    return complete({
      appId: this.values.WXPAY_APPID,
      mchId: this.values.WXPAY_MCHID,
      serialNo: this.values.WXPAY_SERIAL_NO,
      privateKey: this.values.WXPAY_PRIVATE_KEY,
      apiV3Key: this.values.WXPAY_API_V3_KEY,
      notifyUrl: this.values.WXPAY_NOTIFY_URL,
    });
  }
  /** 支付宝当面付：`configured=false` 时通道返回「未启用」 */
  get alipay(): {
    appId: string | undefined;
    privateKey: string | undefined;
    publicKey: string | undefined;
    notifyUrl: string | undefined;
    configured: boolean;
  } {
    return complete({
      appId: this.values.ALIPAY_APP_ID,
      privateKey: this.values.ALIPAY_PRIVATE_KEY,
      publicKey: this.values.ALIPAY_PUBLIC_KEY,
      notifyUrl: this.values.ALIPAY_NOTIFY_URL,
    });
  }
  /** 短信通道：`provider=none` 或凭据不全时降级为「只写站内 + failed 日志」 */
  get sms(): {
    provider: AppEnvironment['SMS_PROVIDER'];
    accessKeyId: string | undefined;
    accessKeySecret: string | undefined;
    signName: string | undefined;
    configured: boolean;
  } {
    const credentials = complete({
      accessKeyId: this.values.SMS_ACCESS_KEY_ID,
      accessKeySecret: this.values.SMS_ACCESS_KEY_SECRET,
      signName: this.values.SMS_SIGN_NAME,
    });
    return {
      provider: this.values.SMS_PROVIDER,
      accessKeyId: credentials.accessKeyId,
      accessKeySecret: credentials.accessKeySecret,
      signName: credentials.signName,
      configured: this.values.SMS_PROVIDER !== 'none' && credentials.configured,
    };
  }
}
