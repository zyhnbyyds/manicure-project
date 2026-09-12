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
  // 未拿到凭据时的开发/测试开关：走假微信实现（**生产强制失效**，见 wxMiniappFake）
  WX_MINIAPP_FAKE: z.enum(['true', 'false']).default('false'),
  /**
   * 小程序内自助支付渠道（储值余额 / 次卡核销 / 积分抵扣）总开关。**默认关闭**。
   *
   * ⚠️ 这是**业务/合规前提，不是技术开关**：这三个渠道在技术上不依赖任何支付通道
   * （全是内部账务：扣已记录的余额 / 次数 / 积分），但在小程序里提供它们属于
   * 「小程序内提供虚拟支付业务」的判定范围，**在虚拟支付接入（或法务确认无需接入）
   * 之前不得开放**。
   *
   * 默认 `false` 是刻意的：**忘记配置 = 保持关闭**，而不是意外打开。
   * 后台收银台（web）不受这个开关影响 —— 它不是小程序。
   */
  APP_SELF_PAY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /**
   * 小程序自助支付的**放量比例**（0~100，默认 `0` = 谁都不放）。
   *
   * 一个旋钮覆盖两种模式与灰度：`0` = 小程序只做预约（完全不出现支付入口）；
   * `100` = 全量支持；中间值按 `app_wx_user.id` 稳定分桶放量
   * （见 `src/modules/app/pay-rollout.ts`）。
   *
   * ⚠️ **与 `APP_SELF_PAY_ENABLED` 是 AND，不是二选一**：
   * 合规是硬闸门（法规问题），放量是它之上的旋钮（产品问题）。
   * 合成一个数字的话，有人把比例调成 100 就等于顺手绕过了合规 —— 所以刻意分开。
   */
  APP_PAY_ROLLOUT_PERCENT: z.coerce.number().int().min(0).max(100).default(0),
  // 微信支付 Native 扫码（B3）：未配置时通道返回「未启用」
  WXPAY_APPID: z.string().optional(),
  WXPAY_MCHID: z.string().optional(),
  WXPAY_SERIAL_NO: z.string().optional(),
  WXPAY_PRIVATE_KEY: z.string().optional(),
  WXPAY_API_V3_KEY: z.string().optional(),
  WXPAY_NOTIFY_URL: z.string().optional(),
  /**
   * 平台证书公钥（**可选**）：不配就走 `/v3/certificates` 联网下载。
   * 给离线环境（集成测试 / 内网）留的注入点，内容可以是 SPKI 公钥 PEM 或 X509 证书 PEM。
   * ⚠️ **绝不参与 `configured` 判定**——配它只是「免联网」，配不配都不该影响通道能否启用。
   */
  WXPAY_PLATFORM_PUBLIC_KEY: z.string().optional(),
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
    /** 是否使用假微信实现（仅本地/测试可用） */
    fake: boolean;
  } {
    return {
      ...complete({
        appId: this.values.WX_MINIAPP_APPID,
        secret: this.values.WX_MINIAPP_SECRET,
      }),
      // fake 不参与 configured 计算：开了假实现也不需要真凭据
      fake: this.wxMiniappFake,
    };
  }
  /**
   * 假微信实现开关：**生产环境一律返回 false**。
   * 这不是「方便开关」而是安全底线——假实现下任意手机号都能登录成任意顾客/美甲师。
   */
  get wxMiniappFake(): boolean {
    if (this.environment === 'production') return false;
    return this.values.WX_MINIAPP_FAKE === 'true';
  }
  /**
   * 小程序内自助支付渠道是否可用（默认 `false`）。
   *
   * 服务端闸门：客户端把按钮藏起来**不算数** —— 只要接口还开着，
   * 一个手写的请求就能用这些渠道，合规风险并没有消失。
   */
  get appSelfPayEnabled(): boolean {
    return this.values.APP_SELF_PAY_ENABLED;
  }
  /**
   * 小程序自助支付的放量比例（0~100）。
   *
   * **必须与 `appSelfPayEnabled` 一起判断**（两者 AND）—— 单看这个值会把
   * 「合规未确认」当成「已放量」。判断统一走 `AppMemberService.selfPayEnabledFor`。
   */
  get appPayRolloutPercent(): number {
    return this.values.APP_PAY_ROLLOUT_PERCENT;
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
    /**
     * 平台证书公钥（可选，**不参与 `configured`**）：有值就免联网下载。
     * 内容可以是 SPKI 公钥 PEM，也可以是 X509 证书 PEM（会自动取其中的公钥）。
     */
    platformPublicKey: string | undefined;
  } {
    const base = complete({
      appId: this.values.WXPAY_APPID,
      mchId: this.values.WXPAY_MCHID,
      serialNo: this.values.WXPAY_SERIAL_NO,
      privateKey: this.values.WXPAY_PRIVATE_KEY,
      apiV3Key: this.values.WXPAY_API_V3_KEY,
      notifyUrl: this.values.WXPAY_NOTIFY_URL,
    });
    // 放在 complete() 之外：配不配它都不该让通道「未启用」
    return { ...base, platformPublicKey: this.values.WXPAY_PLATFORM_PUBLIC_KEY };
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
