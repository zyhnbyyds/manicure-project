import { Module } from '@nestjs/common';
import { ReportsController } from './analytics/reports.controller.js';
import { ReportsService } from './analytics/reports.service.js';
import { CommissionController } from './commission/commission.controller.js';
import { CommissionService } from './commission/commission.service.js';

/**
 * 报表中心 + 提成（B4，§20）。
 *
 * - `ReportsService`：6 张只读报表 + CSV 导出；
 * - `CommissionService`：提成规则 / 计提 / 结算 / 冲销，
 *   继承 `common/ports.ts` 的 `CommissionPort`（由根模块 `BizModule` 用
 *   `useExisting` 绑定到端口 token，供需方注入）。
 */
@Module({
  controllers: [ReportsController, CommissionController],
  providers: [ReportsService, CommissionService],
  exports: [ReportsService, CommissionService],
})
export class ReportsModule {}
