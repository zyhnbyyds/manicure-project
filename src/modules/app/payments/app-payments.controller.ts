import { Controller, Inject, Post, Req, Res } from '@nestjs/common';
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { Public } from '../../../common/auth/public.decorator.js';
import { PaymentPort } from '../../biz/common/ports.js';
import { appWxpayNotifyRequestSchema } from '../dto/app-vo.js';

/** 渠道回调请求：必须有 `rawBody`（验签用的是原样报文，`JSON.stringify` 会改变键顺序） */
type NotifyRequest = {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody?: string | undefined;
};

/**
 * 小程序端支付回调契约骨架（`/api/v1/app/payments/wxpay`，spec §9.7 / §16.1）。
 *
 * ## 认证：**渠道回调，不带 app token**
 *
 * 微信服务器直接 POST，不可能带 `Authorization: Bearer <app token>`，因此本 controller
 * **`@Public()` 且不挂 `AppAccessTokenGuard`**；报文真伪由**验签**保证，不是由 token 保证。
 * （它与 `/app/payments/wxpay/jsapi` 是两个不同方向：jsapi 是 C 端发起支付、需要 app token；
 * notify 是渠道回调、不需要任何 token。）
 *
 * ## P2 实现要点（本期只留契约，handler 一律 501、不落库）
 *
 * 1. **验签**：微信支付 V3 平台证书，对 `timestamp\nnonce\nbody\n` 做 SHA256-RSA 验签，
 *    并校验请求头 `Wechatpay-Serial` 与本地平台证书序号一致；`WXPAY_*` 未配置 → 应答 FAIL。
 *    **验签必须用原样报文**：`src/main.ts` 已为 Fastify 打开 `rawBody: true`，P2 用
 *    `@Req() request.rawBody`（不要用 `JSON.stringify(body)`，键顺序敏感会验签失败）。
 * 2. **解密**：AES-256-GCM（key = `WXPAY_API_V3_KEY`、`resource.nonce`、`associated_data`）
 *    解出 `out_trade_no` / `transaction_id` / `trade_state` / `amount.total`。
 * 3. **金额校验**：解出的 `amount.total` 必须等于 `biz_payment.amount`（分），否则写渠道差异记录
 *    并应答 FAIL，绝不发货。
 * 4. **幂等条件更新**（§6.6）：`WHERE out_trade_no = ? AND status = 'pending'`；`affectedRows = 0`
 *    说明已处理过（微信会重复通知）→ 直接应答 SUCCESS，不重复发货。
 * 5. **同事务发货**：`SettlementPort.recalc` 重算预约金额事实 + 会员消费落账
 *    （`MemberAccountPort.recordConsumption`）+ 通知 `enqueueInTx`；短信/查单等**网络 IO 一律事务后**。
 * 6. **3 秒内应答**：HTTP 200 + `{ code: 'SUCCESS', message: 'OK' }`；处理失败应答
 *    `{ code: 'FAIL', message }`（微信按策略重试），**不要**返回 HTTP 4xx/5xx。
 *
 * ## A13 已按上面的「复用建议」落地
 *
 * 资金逻辑**一行都没重写**：`PaymentPort.handleNotify`（A13 新增）直接复用后台
 * `PaymentsService.handleNotify`，即同一套验签 / 金额校验 / 幂等条件更新 / 同事务发货。
 * 这里只做三件事：取原样报文、调端口、原样透传渠道应答（含 content-type）。
 *
 * 通道用的是 `wxpay_native` 的 provider：JSAPI 与 Native 的 **V3 回调报文完全一致**
 * （同一商户号、同一平台证书），验签与解密逻辑通用；等 JSAPI 下单端点落地时再决定是否
 * 拆出独立的 `wxpay_jsapi` 通道。
 */
@ApiTags('小程序端')
@Public()
@Controller('app/payments/wxpay')
export class AppPaymentsController {
  constructor(@Inject(PaymentPort) private readonly payments: PaymentPort) {}

  @Post('notify')
  @ApiOperation({
    summary: '微信支付回调（公开端点，自行验签 + 幂等）',
    description:
      '渠道回调：不带 app token，靠验签保证真伪。' +
      '验签（V3 平台证书，用原样报文）→ 解密 → **金额必须等于订单金额**（否则记 ' +
      "`callback_invalid` 并拒绝，绝不按回调金额改账）→ `WHERE out_trade_no=? AND status='pending'` " +
      '幂等条件更新（重复通知直接答成功，不重复发货）→ 同事务发货 → 3 秒内应答。' +
      '**HTTP 恒为 200**，成败看应答体 `{code:"SUCCESS"}` / `{code:"FAIL"}`，' +
      '返回 4xx/5xx 只会招来无意义重试。',
  })
  @ApiHeader({
    name: 'Wechatpay-Signature',
    required: true,
    description: 'V3 签名（对 timestamp\\nnonce\\nbody\\n 做 SHA256-RSA）',
  })
  @ApiHeader({
    name: 'Wechatpay-Timestamp',
    required: true,
    description: '签名时间戳；与当前时间偏差过大应判定为过期通知',
  })
  @ApiHeader({ name: 'Wechatpay-Nonce', required: true, description: '随机串' })
  @ApiHeader({
    name: 'Wechatpay-Serial',
    required: true,
    description: '平台证书序号，需与本地证书匹配',
  })
  @ApiBody({ schema: { $ref: '#/components/schemas/AppWxpayNotifyRequest' } })
  @ApiResponse({
    status: 200,
    description: '渠道应答 `{code:"SUCCESS",message:"OK"}` 或 `{code:"FAIL",message}`',
    schema: { $ref: '#/components/schemas/AppWxpayNotifyVo' },
  })
  async notify(
    @Req() request: NotifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // 报文形态只做契约自检（safeParse）：真伪由验签决定，形态不对也必须回渠道应答而不是 HTTP 400。
    appWxpayNotifyRequestSchema.safeParse(request.body);
    const result = await this.payments.handleNotify('wxpay_native', {
      headers: request.headers,
      body: request.body,
      // 必须原样：验签串是 `timestamp\nnonce\nrawBody\n`，重新序列化会变键顺序导致验签失败
      rawBody: request.rawBody,
    });
    reply
      .status(result.statusCode)
      .header('content-type', 'application/json; charset=utf-8')
      .send(result.body);
  }
}
