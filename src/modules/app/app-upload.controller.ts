import {
  BadRequestException,
  Controller,
  HttpCode,
  Post,
  Query,
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
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../common/auth/public.decorator';
import {
  AppAccessTokenGuard,
  type AppRequest,
} from './auth/app-access-token.guard';
import { FilePort } from '../biz/common/ports';
import type { AppUploadVo } from './dto/app-vo';

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
 * 2. **大小上限 5MB**（`@fastify/multipart` 全局配置）：手机直出照片也就 3~5MB；
 *    落盘前会把超过 1MB 的图片**压缩到 1MB 以下**（`image-compress.ts`，与后台同一套）；
 * 3. **限流 20 次/分钟/IP**（基线是全站 100/分钟）—— 上传是最贵的接口，
 *    比登录的 10 次宽松一点（顾客可能连传几张），但远低于全局值。
 *
 * 返回 `{ id, url, mime, size, compressed, originalSize }`：`url` 已经是可以直接塞进
 * 小程序 `<image src>` 的路径；`size` 是压缩后的实际字节数，`originalSize` 是上传时的原图大小。
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
      '单文件上限 5MB（multipart 全局配置），超过 1MB 的图片会被压缩到 1MB 以下；' +
      '传 `compress=0` 可关闭压缩（原样保存）；限流 20 次/分钟/IP。' +
      '返回的 `url` 可直接用于小程序 `<image src>`。',
  })
  @ApiQuery({
    name: 'compress',
    required: false,
    description: '传 0 关闭图片压缩，原样保存（默认压缩）',
  })
  @ApiResponse({ status: 200, description: '成功' })
  @ApiResponse({ status: 400, description: '未选择文件 / 不是图片 / 内容为空' })
  @ApiResponse({ status: 413, description: '文件超过上限' })
  @ApiResponse({ status: 429, description: '上传过于频繁' })
  async upload(
    @Req() request: UploadRequest,
    @Query('compress') compress?: string,
  ): Promise<AppUploadVo> {
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
      // 与后台同一个口径：默认压缩，只有显式 `compress=0` 才原样保存
      { compress: compress !== '0' },
    );
    return {
      id: saved.id,
      url: saved.url,
      mime: saved.mime,
      size: saved.size,
      compressed: saved.compressed,
      originalSize: saved.originalSize,
    };
  }
}
