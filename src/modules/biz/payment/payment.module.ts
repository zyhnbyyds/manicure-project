import { Module } from '@nestjs/common';
import { AlipayQrProvider } from './channels/alipay-qr.provider.js';
import { WxpayNativeProvider } from './channels/wxpay-native.provider.js';
import { PaymentDiffsController } from './diffs/payment-diffs.controller.js';
import { PaymentDiffsService } from './diffs/payment-diffs.service.js';
import { PaymentsController } from './payments/payments.controller.js';
import { PaymentsService } from './payments/payments.service.js';
import { RefundsController } from './refunds/refunds.controller.js';
import { RefundsService } from './refunds/refunds.service.js';

/**
 * 收银模块（B3）。
 *
 * 跨模块能力（`MemberAccountPort` / `MemberCardPort` / `SettlementPort` / `NoticePort` /
 * `CommissionPort`）由根模块 `BizModule`（@Global）用 `useExisting` 绑定，
 * 这里只提供自己的 service 与渠道 Provider，不 import 任何别的模块。
 */
@Module({
  controllers: [PaymentsController, RefundsController, PaymentDiffsController],
  providers: [
    PaymentsService,
    RefundsService,
    PaymentDiffsService,
    WxpayNativeProvider,
    AlipayQrProvider,
  ],
  exports: [PaymentsService, RefundsService, PaymentDiffsService],
})
export class PaymentModule {}
