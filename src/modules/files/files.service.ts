import {
  BadRequestException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { MultipartFile } from '@fastify/multipart';
import { createReadStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { AppConfigService } from '../../config/app-config.service';
import { DatabaseService } from '../../database/database.service';
import { files } from '../../database/schema/index';

const ALLOWED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.svg',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.zip',
  '.mp3',
  '.mp4',
]);
const MAX_FILE_SIZE = 10 * 1024 * 1024;

type FileRow = typeof files.$inferSelect;
export type FileDto = {
  id: number;
  name: string;
  originalName: string;
  url: string;
  mime: string;
  ext: string;
  size: number;
  createdAt: Date;
};

@Injectable()
export class FilesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: AppConfigService,
  ) {}

  async list(page: number, pageSize: number) {
    const rows = await this.database.db
      .select()
      .from(files)
      .orderBy(desc(files.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return { items: rows.map((row) => this.toDto(row)), page, pageSize };
  }

  async detail(id: number): Promise<FileDto> {
    return this.toDto(await this.findOne(id));
  }

  async save(
    part: MultipartFile,
    actorId: number | undefined,
  ): Promise<FileDto> {
    const originalName = sanitizeFilename(decodeFilename(part.filename));
    const ext = path.extname(originalName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext))
      throw new BadRequestException('不允许的文件类型');
    const buffer = await part.toBuffer();
    if (buffer.length === 0) throw new BadRequestException('文件内容为空');
    if (buffer.length > MAX_FILE_SIZE)
      throw new PayloadTooLargeException('文件超过允许的最大大小');
    const name = `${randomUUID()}${ext}`;
    const dir = path.resolve(this.config.uploadDir);
    await mkdir(dir, { recursive: true });
    const absolutePath = path.join(dir, name);
    await writeFile(absolutePath, buffer);
    const result = await this.database.db.insert(files).values({
      name,
      originalName,
      path: absolutePath,
      mime: part.mimetype || 'application/octet-stream',
      ext,
      size: buffer.length,
      createdBy: actorId ?? null,
    });
    const id = Number(result[0].insertId);
    return this.toDto({
      id,
      name,
      originalName,
      path: absolutePath,
      mime: part.mimetype || 'application/octet-stream',
      ext,
      size: buffer.length,
      createdBy: actorId ?? null,
      createdAt: new Date(),
    });
  }

  async open(id: number): Promise<{
    stream: ReturnType<typeof createReadStream>;
    mime: string;
    originalName: string;
  }> {
    const file = await this.findOne(id);
    return {
      stream: createReadStream(file.path),
      mime: file.mime,
      originalName: file.originalName,
    };
  }

  async remove(id: number): Promise<void> {
    const file = await this.findOne(id);
    await this.database.db.delete(files).where(eq(files.id, id));
    try {
      await unlink(file.path);
    } catch {
      /* the file may already be gone */
    }
  }

  private async findOne(id: number): Promise<FileRow> {
    const [file] = await this.database.db
      .select()
      .from(files)
      .where(and(eq(files.id, id)))
      .limit(1);
    if (!file) throw new NotFoundException('文件不存在');
    return file;
  }

  private toDto(row: FileRow): FileDto {
    return {
      id: row.id,
      name: row.name,
      originalName: row.originalName,
      url: `/${this.config.apiPrefix}/files/${row.id}/download`,
      mime: row.mime,
      ext: row.ext,
      size: row.size,
      createdAt: row.createdAt,
    };
  }
}

/**
 * 纠正 multipart 文件名编码。
 *
 * busboy 默认按 latin1 解码 `Content-Disposition: filename`，浏览器/小程序发送的
 * UTF-8 中文名会被解成乱码（`å¥¶è¶£`），所以要把 latin1 再编回去、按 UTF-8 重解一次。
 *
 * ⚠️ **不能无条件地做这个转换**：只有在「确实是 latin1 误解码」时才该转。
 * latin1 误解码的字符串，每个字符都落在 **U+0080–U+00FF**；一旦文件名里出现
 * 更高码位的字符（CJK 都 ≥ U+0100），说明拿到手的**本来就是正确字符串**，
 * 再按 latin1 取低字节只会把它毁掉。
 *
 * 这不是假想：`奶茶色猫眼.jpg` 的每个字低字节恰好拼成合法 UTF-8（`v6r+<`），
 * 于是「转一次」既不产生 U+FFFD、也不会被下面的兜底拦住 →
 * 存进 `sys_file.original_name` 就成了 `v6r__.jpg`（确定性复现，见同名用例）。
 *
 * 兜底：转换后若出现 U+FFFD 替换符，说明这串本来就不是 latin1 误解码的产物，保持原样。
 */
function decodeFilename(filename: string): string {
  // 只在含 latin1 高位字符（即「可能是误解码」）时才尝试还原
  if (!/[\u0080-\u00ff]/.test(filename)) return filename;
  const corrected = Buffer.from(filename, 'latin1').toString('utf8');
  return corrected.includes('\uFFFD') ? filename : corrected;
}

/** 供单测直接验证（不属于对外 API） */
export const __decodeFilenameForTest = decodeFilename;

function sanitizeFilename(name: string): string {
  const base = path
    .basename(name)
    // 保留任意语言的字母/数字、下划线、连字符、点与空格，其余字符替换为下划线
    .replace(/[^\p{L}\p{N}._\- ]/gu, '_')
    .slice(0, 255);
  return base || 'file';
}
