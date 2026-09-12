import { Global, Module } from '@nestjs/common';
import { BaseDataModule } from './base-data/base-data.module.js';
import { BookingModule } from './booking/booking.module.js';
import { BookingSettlementService } from './booking/booking-settlement.service.js';
import { BookingsService } from './booking/bookings.service.js';
import { SlotsService } from './booking/slots.service.js';
import { BizCommonModule } from './common/biz-common.module.js';
import {
  BookingOpsPort,
  BookingPort,
  CommissionPort,
  CreditPort,
  CustomerPort,
  MemberAccountPort,
  MemberCardPort,
  NoticePort,
  PaymentPort,
  RecurrencePort,
  RefundPort,
  ReviewPort,
  SchedulePort,
  ServiceItemPort,
  SettlementPort,
  SlotPort,
  StaffPort,
} from './common/ports.js';
import { CreditModule } from './credit/credit.module.js';
import { ReceivablesService } from './credit/receivables/receivables.service.js';
import { MembershipModule } from './membership/membership.module.js';
import { MemberAccountsService } from './membership/member-accounts/member-accounts.service.js';
import { MemberCardsService } from './membership/member-cards/member-cards.service.js';
import { OperationsModule } from './operations/operations.module.js';
import { NoticesService } from './operations/notices/notices.service.js';
import { ReviewsService } from './operations/reviews/reviews.service.js';
import { RecurrencesService } from './operations/recurrences/recurrences.service.js';
import { PaymentModule } from './payment/payment.module.js';
import { PaymentsService } from './payment/payments/payments.service.js';
import { RefundsService } from './payment/refunds/refunds.service.js';
import { ReportsModule } from './reports/reports.module.js';
import { CommissionService } from './reports/commission/commission.service.js';
import { SchedulingModule } from './scheduling/scheduling.module.js';
import { SchedulingService } from './scheduling/scheduling.service.js';
import { CustomersService } from './base-data/customers/customers.service.js';
import { ServiceItemsService } from './base-data/service-items/service-items.service.js';
import { StaffsService } from './base-data/staffs/staffs.service.js';
import { PointsGoodsService } from './membership/points-goods/points-goods.service.js';
import { PointsGoodsPort } from './common/ports.js';

/**
 * 业务域根模块（B1~B6）。
 *
 * 做两件事：
 * 1. 汇总全部业务子模块，让 controller 与 provider 都进入应用；
 * 2. 把各服务的具体实现**绑定到 `common/ports.ts` 的抽象类 token** 上。
 *
 * 这样模块之间只依赖端口（`MemberAccountPort` 等），不 import 别人的 service，
 * 既没有编译期耦合，也不会出现循环依赖（§实施计划 §1.1）。
 */
@Global()
@Module({
  imports: [
    BizCommonModule,
    BaseDataModule,
    SchedulingModule,
    BookingModule,
    MembershipModule,
    PaymentModule,
    CreditModule,
    ReportsModule,
    OperationsModule,
  ],
  providers: [
    { provide: ServiceItemPort, useExisting: ServiceItemsService },
    { provide: StaffPort, useExisting: StaffsService },
    { provide: CustomerPort, useExisting: CustomersService },
    { provide: SchedulePort, useExisting: SchedulingService },
    { provide: SlotPort, useExisting: SlotsService },
    { provide: SettlementPort, useExisting: BookingSettlementService },
    { provide: BookingOpsPort, useExisting: BookingsService },
    { provide: BookingPort, useExisting: BookingsService },
    { provide: MemberAccountPort, useExisting: MemberAccountsService },
    { provide: MemberCardPort, useExisting: MemberCardsService },
    { provide: PaymentPort, useExisting: PaymentsService },
    { provide: CreditPort, useExisting: ReceivablesService },
    { provide: RefundPort, useExisting: RefundsService },
    { provide: NoticePort, useExisting: NoticesService },
    { provide: CommissionPort, useExisting: CommissionService },
    { provide: RecurrencePort, useExisting: RecurrencesService },
    { provide: ReviewPort, useExisting: ReviewsService },
    // 积分兑换品：顾客侧只读目录（兑换动作仍走后台同一 service，避免算价口径分叉）
    { provide: PointsGoodsPort, useExisting: PointsGoodsService },
  ],
  exports: [
    ServiceItemPort,
    StaffPort,
    CustomerPort,
    SchedulePort,
    SlotPort,
    SettlementPort,
    BookingOpsPort,
    BookingPort,
    MemberAccountPort,
    MemberCardPort,
    PaymentPort,
    CreditPort,
    RefundPort,
    NoticePort,
    CommissionPort,
    RecurrencePort,
    ReviewPort,
    PointsGoodsPort,
    // 需要具体 service 时导出「模块」而不是 provider：Nest 不允许导出
    // 不属于当前模块的 provider（它们由 BookingModule 提供）
    BookingModule,
  ],
})
export class BizModule {}
