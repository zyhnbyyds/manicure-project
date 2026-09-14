/**
 * 颜色工具：主题「只配一个主色，其余自动派生」的基础。
 *
 * 为什么自己派生而不是每个主题手写全部色值：
 * 用户自定义主色时不可能手写一套配色，派生规则必须和预设主题走同一套，
 * 否则自定义主题和预设主题的观感会分裂。
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX_RE = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** 归一化成 `#RRGGBB` 大写；非法输入回落到黑色而不是抛错（主题坏了不能白屏） */
export function normalizeHex(hex: string): string {
  const matched = HEX_RE.exec(String(hex).trim());
  if (!matched) return '#000000';
  const body = matched[1];
  const full =
    body.length === 3
      ? body
          .split('')
          .map((char) => char + char)
          .join('')
      : body;
  return `#${full.toUpperCase()}`;
}

export function hexToRgb(hex: string): Rgb {
  const value = normalizeHex(hex).slice(1);
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

export function rgbToHex(color: Rgb): string {
  const toHex = (value: number) =>
    clampChannel(value).toString(16).padStart(2, '0');
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`.toUpperCase();
}

/** `ratio = 1` 取 `a`，`ratio = 0` 取 `b` */
export function mix(a: string, b: string, ratio: number): string {
  const colorA = hexToRgb(a);
  const colorB = hexToRgb(b);
  const weight = Math.max(0, Math.min(1, ratio));
  return rgbToHex({
    r: colorA.r * weight + colorB.r * (1 - weight),
    g: colorA.g * weight + colorB.g * (1 - weight),
    b: colorA.b * weight + colorB.b * (1 - weight),
  });
}

/** 向白色靠拢：`amount = 0.9` 接近白 */
export function lighten(hex: string, amount: number): string {
  return mix('#FFFFFF', hex, amount);
}

/** 向黑色靠拢：`amount = 0.2` 明显加深 */
export function darken(hex: string, amount: number): string {
  return mix('#000000', hex, amount);
}

export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 相对亮度（WCAG），用于决定前景文字用黑还是白 */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const channel = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.03928
      ? scaled / 12.92
      : Math.pow((scaled + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** 主色上的可读前景色（微信 `navigationBarTextStyle` 只认黑白） */
export function readableOn(hex: string): '#FFFFFF' | '#000000' {
  return luminance(hex) > 0.62 ? '#000000' : '#FFFFFF';
}
