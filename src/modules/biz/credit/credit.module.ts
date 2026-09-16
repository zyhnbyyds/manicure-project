import { Module } from '@nestjs/common';
import { CreditAccountsController } from './credit-accounts/credit-accounts.controller';
import { CreditAccountsService } from './credit-accounts/credit-accounts.service';
import { ReceivablesController } from './receivables/receivables.controller';
import { ReceivablesService } from './receivables/receivables.service';

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
