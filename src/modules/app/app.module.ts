import { Module } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { AppAccessTokenGuard } from './auth/app-access-token.guard';
import { AppAuthController } from './auth/app-auth.controller';
import { AppAuthService } from './auth/app-auth.service';
import {
  FakeWxMiniappProvider,
  HttpWxMiniappProvider,
  WxMiniappProvider,
} from './auth/wx-miniapp.provider';
import { AppCatalogController } from './catalog/app-catalog.controller';
import { AppCatalogService } from './catalog/app-catalog.service';
import { AppUploadController } from './app-upload.controller';
import { AppCustomerDataController } from './member/app-customer-data.controller';
import { AppCustomerDataService } from './member/app-customer-data.service';
import { AppMemberController } from './member/app-member.controller';
import { AppMemberService } from './member/app-member.service';
import { AppPaymentsController } from './payments/app-payments.controller';
import { AppStaffGrantsController } from './staff/app-staff-grants.controller';
import { AppStaffGrantsService } from './staff/app-staff-grants.service';
import { AppStaffWorkbenchController } from './staff/app-staff-workbench.controller';
import { AppStaffWorkbenchService } from './staff/app-staff-workbench.service';
import { AppStaffController } from './staff/app-staff.controller';
import { AppStaffService } from './staff/app-staff.service';
import { AppStaffScopeGuard } from './staff/app-staff-scope.guard';

/**
 * 小程序端（B6，spec §16）—— 只做接口与认证域预留，**不做 UI**。
 *
 * 依赖：只依赖 `src/modules/biz/common/ports.ts` 的抽象类
 * （`ServiceItemPort` / `StaffPort` / `SlotPort` / `MemberAccountPort`），
 * 由根模块的 `BizModule`（@Global）用 `useExisting` 绑定到这些 token 上，
 * 因此本模块**不 import 任何业务模块**，没有编译期耦合与循环依赖。
 *
 * 路由前缀由 `src/main.ts` 的 `setGlobalPrefix(apiPrefix)` 统一添加：
 * controller 里写 `app/...`，实际暴露为 `/api/v1/app/...`。
 */
@Module({
  controllers: [
    AppAuthController,
    AppCatalogController,
    AppMemberController,
    AppCustomerDataController,
    AppUploadController,
    AppPaymentsController,
    AppStaffController,
    AppStaffGrantsController,
    AppStaffWorkbenchController,
  ],
  providers: [
    AppAuthService,
    AppCatalogService,
    AppMemberService,
    AppCustomerDataService,
    AppStaffService,
    AppStaffGrantsService,
    AppStaffWorkbenchService,
    AppStaffScopeGuard,
    AppAccessTokenGuard,
    /**
     * 微信能力端口：按配置二选一。
     *
     * 默认走真实实现（直连微信开放接口）；`WX_MINIAPP_FAKE=true` 且**非生产环境**时走假实现，
     * 让「凭据没到位」不阻塞业务开发与自动化测试。
     * `AppConfigService.wxMiniappFake` 已在生产环境强制返回 false，
     * `FakeWxMiniappProvider` 的构造函数还有第二道拒绝，避免误配把提权口子开到线上。
     */
    {
      provide: WxMiniappProvider,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): WxMiniappProvider =>
        config.wxMiniappFake
          ? new FakeWxMiniappProvider()
          : new HttpWxMiniappProvider(config),
    },
  ],
  exports: [AppAccessTokenGuard],
})
export class AppModule {}

/**
 * 别名：根模块 `src/app.module.ts` 里已经有一个 `AppModule` 类，
 * 注册本模块时用别名导入可避免重名：
 * `import { MiniappModule } from './modules/app/app.module';`
 */
export { AppModule as MiniappModule };
