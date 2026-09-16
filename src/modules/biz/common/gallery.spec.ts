import { describe, expect, it } from 'vitest';
import { DEFAULT_GALLERY_LIMIT, normalizeImages } from './gallery';

describe('normalizeImages（图集归一化）', () => {
  it('没传 / null / 空数组都归一成 null', () => {
    expect(normalizeImages(undefined)).toBeNull();
    expect(normalizeImages(null)).toBeNull();
    expect(normalizeImages([])).toBeNull();
  });

  it('全空白也归一成 null（不允许存一个「有数组但没图」的形态）', () => {
    expect(normalizeImages(['', '   '])).toBeNull();
  });

  it('去掉首尾空白', () => {
    expect(normalizeImages(['  /files/1.png  '])).toEqual(['/files/1.png']);
  });

  it('按首次出现去重且保持原顺序', () => {
    expect(normalizeImages(['b', 'a', 'b', 'c', 'a'])).toEqual(['b', 'a', 'c']);
  });

  it('顺序即展示顺序，不做排序', () => {
    expect(normalizeImages(['/3.png', '/1.png', '/2.png'])).toEqual([
      '/3.png',
      '/1.png',
      '/2.png',
    ]);
  });

  it('默认上限 9 张（服务项目图集），超出截断保留前 9 张', () => {
    const many = Array.from({ length: 12 }, (_, i) => `/files/${i}.png`);
    const normalized = normalizeImages(many);
    expect(DEFAULT_GALLERY_LIMIT).toBe(9);
    expect(normalized).toHaveLength(9);
    expect(normalized?.[0]).toBe('/files/0.png');
    expect(normalized?.[8]).toBe('/files/8.png');
  });

  it('上限可传：门店图集是 5 张', () => {
    const many = Array.from({ length: 8 }, (_, i) => `/files/${i}.png`);
    const normalized = normalizeImages(many, 5);
    expect(normalized).toHaveLength(5);
    expect(normalized?.[4]).toBe('/files/4.png');
  });

  it('不去重以外的清洗：不做 url 合法性判断（与 biz_review.images 口径一致）', () => {
    expect(normalizeImages(['not-a-url'])).toEqual(['not-a-url']);
  });
});
