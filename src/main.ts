import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { zhCN } from 'zod/v4/locales';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

// 全局启用 zod 中文校验提示（需在任意 schema 解析前生效）
z.config(zhCN());

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // trustProxy：反向代理（nginx）场景下让 request.ip 解析 x-forwarded-for，
    // 配合 nginx 的 Proxy_set_header X-Forwarded-For 才能拿到真实客户端 IP
    new FastifyAdapter({ logger: true, trustProxy: true }),
    // rawBody：微信支付 V3 回调验签必须用**原样报文**（键顺序敏感），
    // 仅靠 JSON.stringify(body) 在真实环境会验签失败
    { rawBody: true },
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  const config = app.get(AppConfigService);
  await app.register(helmet);
  await app.register(rateLimit, { max: 1000, timeWindow: '1 minute' });
  await app.register(multipart, {
    // 5MB：手机原图直出通常 3~5MB，上传后由 `image-compress.ts` 压到 1MB 以下落盘。
    // 改这里要同步改三处：`files.service.ts` 的 MAX_FILE_SIZE、`web/nginx.conf` 的
    // client_max_body_size、`web/src/utils/upload-limits.ts` 的前端预检值。
    limits: { files: 1, fileSize: 5 * 1024 * 1024 },
  });
  app.enableCors({ origin: config.corsOrigins, credentials: true });
  app.setGlobalPrefix(config.apiPrefix);
  app.enableShutdownHooks();

  if (config.swagger.SWAGGER_ENABLED) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle(config.swagger.SWAGGER_TITLE)
      .setDescription(config.swagger.SWAGGER_DESCRIPTION)
      .setVersion(config.swagger.SWAGGER_VERSION)
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        'access-token',
      )
      // 小程序端（B6）独立 token 域：/api/v1/app/** 的 @ApiBearerAuth('app-token')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            '小程序端 app token（登录接口下发，payload 含 scope=app）',
        },
        'app-token',
      )
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);

    // Merge zod-to-openapi registry schemas into the NestJS-generated document
    const { getComponentSchemas } =
      await import('./common/swagger/zod-schema.helper');
    const zodSchemas = getComponentSchemas();
    if (document.components) {
      document.components.schemas = {
        ...document.components.schemas,
        ...zodSchemas,
      };
    }

    SwaggerModule.setup(config.swagger.SWAGGER_PATH, app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
    Logger.log(
      `Swagger docs available at /${config.apiPrefix}/${config.swagger.SWAGGER_PATH}`,
      'Bootstrap',
    );
  }

  await app.listen({ port: config.port, host: '0.0.0.0' });
  Logger.log(`API listening on ${config.port}`, 'Bootstrap');
}

void bootstrap();
