import { Module } from '@nestjs/common';
import { BizCommonModule } from '../common/biz-common.module.js';
import { SchedulingController } from './scheduling.controller.js';
import { SchedulingService } from './scheduling.service.js';

/**
 * 排班（B1）：周模板整体替换 + 日期例外 + 与既有预约的冲突保护（§6.4 / §9.3）。
 */
@Module({
  imports: [BizCommonModule],
  controllers: [SchedulingController],
  providers: [SchedulingService],
  exports: [SchedulingService],
})
export class SchedulingModule {}
