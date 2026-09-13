import { Module } from '@nestjs/common';
import { BizCommonModule } from '../common/biz-common.module.js';
import { CustomersController } from './customers/customers.controller.js';
import { CustomersService } from './customers/customers.service.js';
import { ServiceItemsController } from './service-items/service-items.controller.js';
import { ServiceItemsService } from './service-items/service-items.service.js';
import { StaffsController } from './staffs/staffs.controller.js';
import { StaffsService } from './staffs/staffs.service.js';
import { StoresController } from './stores/stores.controller.js';
import { StoresService } from './stores/stores.service.js';

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
