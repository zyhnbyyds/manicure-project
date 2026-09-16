import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ZodError, type ZodIssue } from 'zod';

/** 常用字段中文名映射，未命中时回退为原始字段 key */
const FIELD_LABELS: Record<string, string> = {
  username: '用户名',
  password: '密码',
  oldPassword: '原密码',
  newPassword: '新密码',
  email: '邮箱',
  phone: '手机号',
  name: '名称',
  key: '标识',
  sort: '排序',
  title: '标题',
  remark: '备注',
  status: '状态',
  dataScope: '数据范围',
  roleId: '角色',
  deptId: '部门',
  menuIds: '菜单',
  type: '类型',
  path: '路径',
  component: '组件',
  permission: '权限标识',
  label: '标签',
  value: '值',
  page: '页码',
  pageSize: '每页条数',
};

function fieldLabel(issue: ZodIssue): string {
  const path = issue.path.join('.');
  const last = issue.path[issue.path.length - 1];
  return FIELD_LABELS[String(last)] ?? path ?? '请求体';
}

/**
 * 把 zod issue 按具体场景映射成自然的中文提示，
 * 避免直接展示 zod 的直译文案（如「数值过小：期望 string >=1 字符」）。
 */
function friendlyIssue(issue: ZodIssue): string {
  const extra = issue as ZodIssue & Record<string, unknown>;
  const origin = extra.origin as string | undefined;
  const isString = origin === 'string';

  switch (issue.code) {
    case 'too_small': {
      const min = extra.minimum as number | undefined;
      if (isString) return min === 1 ? '不能为空' : `至少 ${min} 个字符`;
      return min === undefined ? '数值过小' : `不能小于 ${min}`;
    }
    case 'too_big': {
      const max = extra.maximum as number | undefined;
      if (isString) return `最多 ${max} 个字符`;
      return max === undefined ? '数值过大' : `不能大于 ${max}`;
    }
    case 'invalid_format': {
      const format = extra.format as string | undefined;
      if (format === 'email') return '邮箱格式不正确';
      if (format === 'url') return '链接格式不正确';
      if (format === 'uuid') return 'ID 格式不正确';
      return '格式不正确';
    }
    case 'invalid_type':
      return extra.received === 'undefined' ? '不能为空' : '类型不正确';
    case 'not_multiple_of':
      return `必须是 ${extra.multipleOf} 的倍数`;
    case 'unrecognized_keys':
      return '包含未定义的字段';
    default:
      return issue.message;
  }
}

/**
 * 只认这些 4xx：Fastify 插件抛的是**带 `statusCode` 的普通 Error**，不是 `HttpException`。
 *
 * 为什么必须单列：`@fastify/rate-limit` 超限走的是
 * `throw errorResponseBuilder(...)`（插件内 `defaultErrorResponse` 构造 `new Error()` 后挂
 * `statusCode = 429`）。不认这个约定，限流就**静默降级成 500**——请求确实被拦了，但客户端
 * 收到「服务器内部错误」，既分不清是被限流还是服务挂了，还会诱导重试（正好是限流要防的）。
 * 同时每一次限流都会打一条 ERROR 堆栈，把日志刷满。
 *
 * 只放行 4xx：5xx 一律仍按未知异常处理，绝不让第三方插件的 `statusCode` 决定成功/失败语义。
 */
function fastifyClientErrorStatus(exception: unknown): number | null {
  if (!(exception instanceof Error)) return null;
  const status = (exception as Error & { statusCode?: unknown }).statusCode;
  if (typeof status !== 'number' || !Number.isInteger(status)) return null;
  return status >= 400 && status < 500 ? status : null;
}

/**
 * 全局异常过滤器：统一错误响应结构，优化前端错误提示。
 *
 * - ZodError（入参校验失败）→ 400，message 为「字段：原因」的中文数组；
 * - HttpException（业务异常）→ 原样透传状态码与响应体；
 * - **Fastify 插件的 4xx**（带 `statusCode` 的 Error，如限流 429）→ 透传状态码 + 中文提示，
 *   只记 warn 不打堆栈（限流属于正常防御，不是故障）；
 * - 其它未知异常 → 500，返回通用中文提示并记录堆栈，避免把
 *   "Internal server error" 直接抛给前端。
 */
/**
 * 取这次请求的 id。
 *
 * Fastify 的 `requestIdHeader` 默认就是 `request-id` —— 客户端（web / 小程序）
 * 自带的那个值会**原样成为 reqId**，并被 Fastify 的日志逐行带上；
 * 客户端没带时 Fastify 会自己生成一个。把它回填进异常响应体，
 * 用户报「付了钱但没到账」时，客服拿这一个号就能在日志里定位到那次请求。
 */
function requestIdOf(host: ArgumentsHost): string | null {
  try {
    const request = host.switchToHttp().getRequest<{ id?: unknown }>();
    return typeof request?.id === 'string' && request.id ? request.id : null;
  } catch {
    return null;
  }
}
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<{
      status: (code: number) => { send: (body: unknown) => void };
    }>();
    const requestId = requestIdOf(host);
    /** 所有异常响应都带上请求号（排障时前后端说的是同一个号） */
    const withRequestId = <T extends object>(body: T): T =>
      requestId ? { ...body, requestId } : body;

    // 入参校验失败：整理成可读的中文字段提示
    if (exception instanceof ZodError) {
      const messages = exception.issues.map((issue) => {
        return `${fieldLabel(issue)}：${friendlyIssue(issue)}`;
      });
      reply.status(HttpStatus.BAD_REQUEST).send(
        withRequestId({
          statusCode: HttpStatus.BAD_REQUEST,
          message: messages,
          error: 'Bad Request',
        }),
      );
      return;
    }

    // 业务异常：保持 NestJS 原有结构
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const body =
        typeof response === 'string'
          ? { statusCode: status, message: response }
          : response;
      reply.status(status).send(withRequestId(body));
      return;
    }

    // Fastify 插件的客户端错误（限流 429 / 请求体过大 413 等）：透传状态码，不打堆栈
    const pluginStatus = fastifyClientErrorStatus(exception);
    if (pluginStatus !== null) {
      this.logger.warn(
        `${pluginStatus}：${exception instanceof Error ? exception.message : ''}`,
      );
      reply.status(pluginStatus).send(
        withRequestId({
          statusCode: pluginStatus,
          message:
            pluginStatus === HttpStatus.TOO_MANY_REQUESTS
              ? '请求过于频繁，请稍后再试'
              : pluginStatus === HttpStatus.PAYLOAD_TOO_LARGE
                ? // 上传超限是**用户看得见**的错误。multipart 抛的原文是英文
                  // `request file too large`，直接透传等于把英文甩给店员。
                  // 这里不写具体数字：上限值在 files 模块，common 层不该反向依赖它，
                  // 前端 `MAX_UPLOAD_FILE_SIZE_LABEL` 已经会在提交前给出带数字的提示。
                  '上传的文件超过大小上限'
                : exception instanceof Error
                  ? exception.message
                  : '请求不被受理',
          error:
            pluginStatus === HttpStatus.TOO_MANY_REQUESTS
              ? 'Too Many Requests'
              : pluginStatus === HttpStatus.PAYLOAD_TOO_LARGE
                ? 'Payload Too Large'
                : 'Client Error',
        }),
      );
      return;
    }

    // 未知异常：兜底 500 + 中文提示
    this.logger.error(
      `[${requestId ?? '-'}] ` +
        (exception instanceof Error ? exception.stack : String(exception)),
    );
    reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send(
      withRequestId({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: '服务器内部错误，请稍后重试',
        error: 'Internal Server Error',
      }),
    );
  }
}
