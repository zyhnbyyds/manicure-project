import { Module } from '@nestjs/common';
import { AlipayQrProvider } from './channels/alipay-qr.provider';
import { WxpayNativeProvider } from './channels/wxpay-native.provider';
import { PaymentDiffsController } from './diffs/payment-diffs.controller';
import { PaymentDiffsService } from './diffs/payment-diffs.service';
import { PaymentsController } from './payments/payments.controller';
import { PaymentsService } from './payments/payments.service';
import { RefundsController } from './refunds/refunds.controller';
import { RefundsService } from './refunds/refunds.service';

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
