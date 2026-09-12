/**
 * 图片地址显示态归一化的回归测试。
 *
 * 守的是一个**真实踩过的坑**：编辑服务项目时图片反显不出来 ——
 * lew-ui 的 `LewUpload` 只把「以图片扩展名结尾」的 url 当图片渲染，
 * 而项目的预览地址是 `/files/:id/download?inline=1`，于是被渲染成文件图标。
 *
 * 这两条断言一旦失败，说明「反显」又会坏：
 * 1. 归一化后的地址必须**能通过 lew-ui 那条正则**；
 * 2. 提交前剥回原样（否则每保存一次地址就长一截）。
 */
import { describe, expect, it } from 'vitest';
import {
  stripDisplayImageUrl,
  stripDisplayImageUrls,
  toDisplayImageUrl,
  toDisplayImageUrls,
} from './image-url';

/** 照抄自 `lew-ui/dist/index.js` 的判定正则（lew-ui 改了这里要跟着改） */
const LEW_IMAGE_RE =
  /\.(?:jpg|jpeg|png|webp|bmp|gif|svg|tiff|ico|heif|jfif|pjpeg|pjp|avif)$/i;

/** 项目里真实的存储值（相对路径形态） */
const STORED = '/api/v1/files/10/download?inline=1';

describe('图片地址显示态归一化', () => {
  it('**让 lew-ui 认得出这是图片**（它要求 url 以图片扩展名结尾）', () => {
    // 原始地址：lew-ui 判成「不是图片」→ 渲染成文件图标（反显看不到的根因）
    expect(LEW_IMAGE_RE.test(STORED)).toBe(false);
    // 归一化后必须能通过
    expect(LEW_IMAGE_RE.test(toDisplayImageUrl(STORED))).toBe(true);
  });

  it('提交前剥回原样，且反复「显示 ↔ 剥离」不会越滚越长', () => {
    const shown = toDisplayImageUrl(STORED);
    expect(stripDisplayImageUrl(shown)).toBe(STORED);
    // 幂等：再走一轮也不会重复追加标记
    expect(toDisplayImageUrl(stripDisplayImageUrl(shown))).toBe(shown);
    expect(stripDisplayImageUrl(stripDisplayImageUrl(shown))).toBe(STORED);
  });

  it('本来就带扩展名的地址原样返回（绝对地址 / 静态图）', () => {
    for (const url of [
      '/images/a.png',
      'https://cdn.test/b.JPEG',
      '/api/v1/files/3/download/photo.webp',
    ]) {
      expect(toDisplayImageUrl(url)).toBe(url);
    }
  });

  it('`data:` / `blob:` 一律不动（拼查询串会把地址弄坏）', () => {
    const dataUri = 'data:image/png;base64,iVBORw0KGgo=';
    const blob = 'blob:http://localhost/abc-def';
    expect(toDisplayImageUrl(dataUri)).toBe(dataUri);
    expect(toDisplayImageUrl(blob)).toBe(blob);
  });

  it('空值与锚点都处理得当', () => {
    expect(toDisplayImageUrl('')).toBe('');
    // 锚点必须留在最后，参数不能拼到 `#` 后面
    expect(toDisplayImageUrl('/f/1/download#frag')).toBe(
      '/f/1/download?__img=.png#frag',
    );
  });

  it('批量版本行为一致', () => {
    const urls = [STORED, '/images/a.png'];
    const shown = toDisplayImageUrls(urls);
    expect(shown).toHaveLength(2);
    expect(LEW_IMAGE_RE.test(shown[0] ?? '')).toBe(true);
    expect(stripDisplayImageUrls(shown)).toEqual(urls);
  });
});
