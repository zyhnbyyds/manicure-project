/**
 * 图片查看器纯逻辑的回归测试。
 *
 * 这里守的是**手感**而不是像素：缩放要围绕指针、平移不能飞出边界、
 * 空集 / 越界下标不能把组件搞崩。查看器本身（DOM / 事件）没有自动化测试，
 * 所以凡是能从组件里拎出来的算术，都拎到这里来钉住。
 */
import { describe, expect, it } from 'vitest';
import {
  CLICK_SLOP,
  MAX_SCALE,
  MIN_SCALE,
  clampIndex,
  clampPan,
  clampScale,
  normalizePreviewImages,
  previewImageName,
  wheelPaging,
  wrapIndex,
  zoomAround,
} from './image-viewer';

describe('预览图集归一化', () => {
  it('字符串与对象混着传都能吃下', () => {
    expect(
      normalizePreviewImages(['/a.png', { url: '/b.png', name: '封面' }]),
    ).toEqual([{ url: '/a.png' }, { url: '/b.png', name: '封面' }]);
  });

  it('空地址 / 空白地址丢掉，首尾空格去掉', () => {
    expect(
      normalizePreviewImages(['  /a.png  ', '', '   ', null as never]),
    ).toEqual([{ url: '/a.png' }]);
  });

  it('空值入参回空数组（调用方不用先判空）', () => {
    expect(normalizePreviewImages(null)).toEqual([]);
    expect(normalizePreviewImages(undefined)).toEqual([]);
  });
});

describe('下标运算', () => {
  it('越界一律夹回区间内', () => {
    expect(clampIndex(-3, 5)).toBe(0);
    expect(clampIndex(9, 5)).toBe(4);
    expect(clampIndex(2, 5)).toBe(2);
  });

  it('空集与非数字回 0（不抛错、不返回 NaN）', () => {
    expect(clampIndex(3, 0)).toBe(0);
    expect(clampIndex(Number.NaN, 5)).toBe(0);
    expect(clampIndex(1, Number.NaN)).toBe(0);
  });

  it('环形切换：首张往前是末张，末张往后是首张', () => {
    expect(wrapIndex(0, -1, 4)).toBe(3);
    expect(wrapIndex(3, 1, 4)).toBe(0);
    expect(wrapIndex(1, 1, 4)).toBe(2);
    expect(wrapIndex(1, 0, 4)).toBe(1);
  });

  it('环形切换在空集上安全', () => {
    expect(wrapIndex(0, -1, 0)).toBe(0);
  });
});

describe('缩放', () => {
  it('夹在 [MIN, MAX] 之间，非数字回最小值', () => {
    expect(clampScale(0.1)).toBe(MIN_SCALE);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(2)).toBe(2);
    expect(clampScale(Number.NaN)).toBe(MIN_SCALE);
  });

  it('抹掉浮点尾巴（连点几次「放大」不该显示 300.00000000000006%）', () => {
    expect(clampScale(1 + 0.2 + 0.2)).toBe(1.4);
    expect(clampScale(0.1 + 0.2, 0, 9)).toBe(0.3);
  });

  it('围绕锚点缩放时，锚点下的那个像素**不动**', () => {
    const offset = { x: 30, y: -20 };
    const scale = 2;
    const anchor = { x: 120, y: 60 };
    const factor = 1.5;
    // 锚点在屏幕上的位置：s = offset + scale * u  ⇒  u = (s - offset) / scale
    const u = {
      x: (anchor.x - offset.x) / scale,
      y: (anchor.y - offset.y) / scale,
    };
    const moved = zoomAround(offset, factor, anchor);
    const now = {
      x: moved.x + scale * factor * u.x,
      y: moved.y + scale * factor * u.y,
    };
    expect(now.x).toBeCloseTo(anchor.x, 6);
    expect(now.y).toBeCloseTo(anchor.y, 6);
  });

  it('倍数为 1 时平移量不变', () => {
    expect(zoomAround({ x: 12, y: -8 }, 1, { x: 200, y: 100 })).toEqual({
      x: 12,
      y: -8,
    });
  });
});

describe('平移边界', () => {
  const viewport = { width: 800, height: 600 };

  it('图片装得下时强制居中（不允许拖出空白边）', () => {
    const rendered = { width: 400, height: 300 };
    expect(clampPan({ x: 120, y: -90 }, rendered, viewport)).toEqual({
      x: 0,
      y: 0,
    });
  });

  it('图片超出视口时可拖到边缘对齐，但不能更远', () => {
    const rendered = { width: 1200, height: 900 };
    // 横向最多 (1200-800)/2 = 200，纵向最多 (900-600)/2 = 150
    expect(clampPan({ x: 500, y: -400 }, rendered, viewport)).toEqual({
      x: 200,
      y: -150,
    });
    expect(clampPan({ x: 100, y: -60 }, rendered, viewport)).toEqual({
      x: 100,
      y: -60,
    });
  });

  it('只有一个方向超出时，另一个方向保持居中', () => {
    const rendered = { width: 1600, height: 300 };
    expect(clampPan({ x: 900, y: 50 }, rendered, viewport)).toEqual({
      x: 400,
      y: 0,
    });
  });
});

describe('标题与滚轮方向', () => {
  it('调用方给的名字优先', () => {
    expect(previewImageName({ url: '/a.png', name: '封面图' }, 0, 3)).toBe(
      '封面图',
    );
  });

  it('地址尾段像文件名才拿来做标题', () => {
    expect(
      previewImageName(
        { url: '/api/v1/files/3/download/photo.webp?x=1' },
        0,
        1,
      ),
    ).toBe('photo.webp');
  });

  it('预览接口的尾段是 download，不当标题，退回张数', () => {
    // 这是项目里真实形态：/api/v1/files/10/download?inline=1
    expect(
      previewImageName({ url: '/api/v1/files/10/download?inline=1' }, 1, 5),
    ).toBe('第 2 / 5 张');
    // 单图时退回通用名
    expect(previewImageName({ url: '/api/v1/files/10/download' }, 0, 1)).toBe(
      '图片预览',
    );
    expect(previewImageName(undefined, 0, 0)).toBe('图片预览');
  });

  it('非法百分号转义不会把预览搞崩', () => {
    expect(previewImageName({ url: '/a/%E4%B8%AD.png' }, 0, 1)).toBe('中.png');
    expect(previewImageName({ url: '/a/100%.png' }, 0, 1)).toBe('100%.png');
  });

  it('只有横向为主的滚动才算翻页', () => {
    expect(wheelPaging(60, 10)).toBe(1);
    expect(wheelPaging(-60, 10)).toBe(-1);
    expect(wheelPaging(10, 60)).toBe(0);
    expect(wheelPaging(0, 0)).toBe(0);
  });

  it('点击 / 拖拽阈值是正数（组件靠它决定松手后关不关弹层）', () => {
    expect(CLICK_SLOP).toBeGreaterThan(0);
  });
});
