import { Module } from '@nestjs/common';
import { BizCommonModule } from '../common/biz-common.module';
import { CustomersController } from './customers/customers.controller';
import { CustomersService } from './customers/customers.service';
import { ServiceItemsController } from './service-items/service-items.controller';
import { ServiceItemsService } from './service-items/service-items.service';
import { StaffsController } from './staffs/staffs.controller';
import { StaffsService } from './staffs/staffs.service';
import { StoresController } from './stores/stores.controller';
import { StoresService } from './stores/stores.service';

/**
 * 基础数据（B1）：服务项目 / 美甲师（含可做项目）/ 顾客档案 / 门店档案。
 *
 * 只依赖端口与公共工具；端口到具体实现的绑定由根模块 `BizModule` 统一负责（§1.1）。
 */
@Module({
  imports: [BizCommonModule],
  controllers: [
    ServiceItemsController,
    StaffsController,
    CustomersController,
    StoresController,
  ],
  providers: [
    ServiceItemsService,
    StaffsService,
    CustomersService,
    StoresService,
  ],
  exports: [
    ServiceItemsService,
    StaffsService,
    CustomersService,
    StoresService,
  ],
})
export class BaseDataModule {}
