import { Module } from '@nestjs/common';
import { NoticesController } from './notices/notices.controller';
import { NoticesService } from './notices/notices.service';
import { AliyunSmsProvider, SmsProvider } from './notices/sms/sms.provider';
import { RecurrencesController } from './recurrences/recurrences.controller';
import { RecurrencesService } from './recurrences/recurrences.service';
import { ReviewsController } from './reviews/reviews.controller';
import { ReviewsService } from './reviews/reviews.service';

/**
 * 运营模块（B5）：评价 / 周期预约 / 通知（模板 + 短信 + 站内消息）。
 *
 * - 服务类以端口抽象类为 DI token 对外暴露（`NoticePort` / `RecurrencePort`），
 *   由根 `BizModule` 统一 `useExisting` 绑定，模块之间没有编译期耦合；
 * - `SmsProvider` 是抽象基类（同时充当 token），**必须以 token 形式注册**，
 *   不能裸写类名——裸写会被 Nest 实例化成一个没有实现的抽象对象。
 */
@Module({
  controllers: [ReviewsController, RecurrencesController, NoticesController],
  providers: [
    ReviewsService,
    RecurrencesService,
    NoticesService,
    AliyunSmsProvider,
    { provide: SmsProvider, useExisting: AliyunSmsProvider },
  ],
  exports: [ReviewsService, RecurrencesService, NoticesService],
})
export class OperationsModule {}
