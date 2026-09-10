import { Module } from '@nestjs/common';
import { CreditAccountsController } from './credit-accounts/credit-accounts.controller.js';
import { CreditAccountsService } from './credit-accounts/credit-accounts.service.js';
import { ReceivablesController } from './receivables/receivables.controller.js';
import { ReceivablesService } from './receivables/receivables.service.js';

/**
 * 挂账与应收（B4，§18）。
 *
 * 对外只暴露服务实例：根模块 `BizModule` 用
 * `{ provide: CreditPort, useExisting: ReceivablesService }` 绑定端口，
 * 其它模块因此不依赖本模块的类（§1.1）。
 */
@Module({
  controllers: [CreditAccountsController, ReceivablesController],
  providers: [CreditAccountsService, ReceivablesService],
  exports: [CreditAccountsService, ReceivablesService],
})
export class CreditModule {}
