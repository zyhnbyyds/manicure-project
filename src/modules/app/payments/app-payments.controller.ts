import {
  Body,
  Controller,
  NotImplementedException,
  Post,
} from '@nestjs/common';
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../../common/auth/public.decorator.js';
import { appWxpayNotifyRequestSchema } from '../dto/app-vo.js';

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
 * > 复用建议：后台 `PaymentsService.handleNotify(channel, raw)`（实施计划 §2.3）已是同一套
 * > 验签/幂等/发货流程，P2 应把它挂到端口上（当前 `PaymentPort` 没有 `handleNotify`，
 * > 需在 `ports.ts` 补一个方法或在 `BizModule` 导出 `PaymentsService`），避免小程序侧再写一份。
 */
@ApiTags('小程序端')
@Public()
@Controller('app/payments/wxpay')
export class AppPaymentsController {
  @Post('notify')
  @ApiOperation({
    summary: '微信支付回调（契约骨架，本期返回 501）',
    description:
      '渠道回调：不带 app token，靠验签保证真伪。本期只冻结报文与应答契约，不落库、不发货。' +
      'P2 实现：验签（V3 平台证书）→ 解密 → 金额校验 → ' +
      "`WHERE out_trade_no=? AND status='pending'` 幂等条件更新 → 同事务发货 → 3 秒内应答 " +
      "`{code:'SUCCESS',message:'OK'}` / 失败 `{code:'FAIL',message}`。",
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
    description:
      '渠道应答（P2：`{code:"SUCCESS",message:"OK"}` 或 `{code:"FAIL",message}`）',
    schema: { $ref: '#/components/schemas/AppWxpayNotifyVo' },
  })
  @ApiResponse({ status: 501, description: '本期未实现' })
  notify(@Body() body: unknown): never {
    // 报文形态只做契约自检（safeParse）：真伪由验签决定，失败也必须回渠道应答而不是 HTTP 400。
    // 本期无论内容一律 501，且不写任何表。
    appWxpayNotifyRequestSchema.safeParse(body);
    throw new NotImplementedException('微信支付回调将在 P2 接入支付通道时实现');
  }
}
