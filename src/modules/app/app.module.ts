import { Module } from '@nestjs/common';
import { AppAccessTokenGuard } from './auth/app-access-token.guard.js';
import { AppAuthController } from './auth/app-auth.controller.js';
import { AppAuthService } from './auth/app-auth.service.js';
import { AppCatalogController } from './catalog/app-catalog.controller.js';
import { AppCatalogService } from './catalog/app-catalog.service.js';
import { AppMemberController } from './member/app-member.controller.js';
import { AppMemberService } from './member/app-member.service.js';

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
  controllers: [AppAuthController, AppCatalogController, AppMemberController],
  providers: [
    AppAuthService,
    AppCatalogService,
    AppMemberService,
    AppAccessTokenGuard,
  ],
  exports: [AppAccessTokenGuard],
})
export class AppModule {}

/**
 * 别名：根模块 `src/app.module.ts` 里已经有一个 `AppModule` 类，
 * 注册本模块时用别名导入可避免重名：
 * `import { MiniappModule } from './modules/app/app.module.js';`
 */
export { AppModule as MiniappModule };
