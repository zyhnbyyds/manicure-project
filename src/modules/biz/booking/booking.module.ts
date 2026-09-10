import { Module } from '@nestjs/common';
import { BookingSettlementService } from './booking-settlement.service.js';
import { BookingsController } from './bookings.controller.js';
import { BookingsService } from './bookings.service.js';
import { SlotsService } from './slots.service.js';

/**
 * 预约主链路（B1）。
 *
 * 只导出服务类，端口 token（`SlotPort` / `SettlementPort`）由根模块
 * `BizModule` 用 `useExisting` 统一绑定，避免模块之间互相 import 造成循环依赖。
 */
@Module({
  controllers: [BookingsController],
  providers: [SlotsService, BookingsService, BookingSettlementService],
  exports: [SlotsService, BookingsService, BookingSettlementService],
})
export class BookingModule {}
