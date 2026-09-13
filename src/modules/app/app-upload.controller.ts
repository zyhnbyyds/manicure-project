import {
  BadRequestException,
  Controller,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { MultipartFile } from '@fastify/multipart';
import { RouteConfig } from '@nestjs/platform-fastify';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../common/auth/public.decorator.js';
import {
  AppAccessTokenGuard,
  type AppRequest,
} from './auth/app-access-token.guard.js';
import { FilePort } from '../biz/common/ports.js';
import type { AppUploadVo } from './dto/app-vo.js';

/** Fastify 上传请求（与后台 `FilesController` 同一套取文件方式） */
type UploadRequest = AppRequest & {
  file: () => Promise<MultipartFile | undefined>;
};

/**
 * C 端图片上传（评价配图 / 意见反馈截图）。
 *
 * ## 为什么必须单独开一个接口
 *
 * 后台的 `POST /files/upload` 走**后台 token 域**（`AccessTokenGuard`），
 * 小程序拿的是 app token，打过去只会 401。而 C 端上传又确实需要：
 * 设计稿里评价与意见反馈都有图片位。
 *
 * ## 三条约束（C 端比后台更紧）
 *
 * 1. **只收图片**：按 MIME 与扩展名双重判断 —— 扩展名白名单由 `FilesService` 把关，
 *    这里再挡一层 MIME，避免「把 .php 改名成 .jpg」这类试探落到存储层；
 * 2. **大小上限沿用后台的 10MB**（`@fastify/multipart` 全局配置）：
 *    手机直出照片也就 3~5MB，再往上只会让弱网卡住；
 * 3. **限流 20 次/分钟/IP**（基线是全站 100/分钟）—— 上传是最贵的接口，
 *    比登录的 10 次宽松一点（顾客可能连传几张），但远低于全局值。
 *
 * 返回 `{ id, url, mime, size }`：`url` 已经是可以直接塞进小程序 `<image src>` 的路径。
 */
@ApiTags('小程序端')
@ApiBearerAuth('app-token')
@Public()
@UseGuards(AppAccessTokenGuard)
@Controller('app')
export class AppUploadController {
  constructor(private readonly filePort: FilePort) {}

  @Post('upload')
  @HttpCode(200)
  @RouteConfig({ rateLimit: { max: 20, timeWindow: '1 minute' } })
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: '上传图片（评价配图 / 意见反馈）',
    description:
      '只接受图片（MIME 与扩展名双重判断，扩展名白名单由文件服务把关）；' +
      '单文件上限 10MB（multipart 全局配置）；限流 20 次/分钟/IP。' +
      '返回的 `url` 可直接用于小程序 `<image src>`。',
  })
  @ApiResponse({ status: 200, description: '成功' })
  @ApiResponse({ status: 400, description: '未选择文件 / 不是图片 / 内容为空' })
  @ApiResponse({ status: 413, description: '文件超过上限' })
  @ApiResponse({ status: 429, description: '上传过于频繁' })
  async upload(@Req() request: UploadRequest): Promise<AppUploadVo> {
    const appUser = request.appUser;
    if (!appUser) throw new UnauthorizedException();
    const file = await request.file();
    if (!file) throw new BadRequestException('未选择文件');
    if (!file.mimetype?.startsWith('image/')) {
      throw new BadRequestException('只能上传图片');
    }
    const saved = await this.filePort.save(
      file,
      /**
       * **刻意传 `undefined` 而不是 app 身份 id。**
       *
       * `sys_file.created_by` 是指向 `sys_user` 的外键，而小程序顾客**不是后台用户** ——
       * 传 app 身份 id 会直接撞外键（实测：`insert into sys_file` 500），
       * 更糟的是万一撞上某个真实 `sys_user.id`，这次上传就会被记到别人名下。
       * 顾客上传的溯源在业务侧（反馈/评价记录里带顾客 id），不靠文件表。
       */
      undefined,
    );
    return {
      id: saved.id,
      url: saved.url,
      mime: saved.mime,
      size: saved.size,
    };
  }
}
