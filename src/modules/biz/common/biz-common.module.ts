import { Global, Module } from '@nestjs/common';
import { BizConfigService } from './biz-config.service.js';

/**
 * 业务公共能力（全局模块）。
 *
 * 所有 `biz/*` 模块都能直接注入 `BizConfigService`，不需要各自 import，
 * 避免循环依赖；配置解析只此一处（§5.6）。
 */
@Global()
@Module({
  providers: [BizConfigService],
  exports: [BizConfigService],
})
export class BizCommonModule {}
