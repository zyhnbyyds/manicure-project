/**
 * 资源地址绝对化的回归测试。
 *
 * 守的坑：后端存的是服务端相对路径（`/api/v1/files/:id/download?inline=1`），
 * 而小程序把 `/` 开头的地址当**包内本地文件** → 封面/头像静默加载失败。
 */
import { describe, expect, it } from 'vitest';
import { API_BASE } from '../config';
import { absoluteAssetUrl } from './asset-url';

/** 与实现同源的推断：API_BASE 去掉 `/api/v1` */
const ORIGIN = API_BASE.replace(/\/api\/v\d+\/?$/i, '').replace(/\/+$/, '');

describe('absoluteAssetUrl', () => {
  it('**服务端相对路径 → 拼上 origin**（否则小程序当成本地文件，加载必然失败）', () => {
    expect(absoluteAssetUrl('/api/v1/files/10/download?inline=1')).toBe(
      `${ORIGIN}/api/v1/files/10/download?inline=1`,
    );
  });

  it('已经是绝对地址的原样返回', () => {
    for (const url of [
      'http://cdn.test/a.png',
      'https://cdn.test/b.png',
      'cloud://env.abc/a.png',
      '//cdn.test/c.png',
    ]) {
      expect(absoluteAssetUrl(url)).toBe(url);
    }
  });

  it('包内相对素材（不带前导斜杠）原样返回', () => {
    expect(absoluteAssetUrl('assets/svc-a.png')).toBe('assets/svc-a.png');
    expect(absoluteAssetUrl('./assets/svc-b.png')).toBe('./assets/svc-b.png');
  });

  it('空值返回 null（调用方走占位图）', () => {
    expect(absoluteAssetUrl('')).toBeNull();
    expect(absoluteAssetUrl(null)).toBeNull();
    expect(absoluteAssetUrl(undefined)).toBeNull();
  });
});
