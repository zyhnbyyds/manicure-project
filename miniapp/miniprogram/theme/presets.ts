/**
 * 主题预设。每个主题**只需要给主色 + 强调色 + 背景 + 文字色**，
 * 其余（浅色底、深色描边、阴影、渐变）全部由 `theme.ts` 用 `utils/color.ts` 派生，
 * 这样「预设主题」和「用户自定义主色」走的是同一套派生规则，观感不会分裂。
 *
 * 画风口径（可爱但不幼稚，保证可读性）：
 * - 背景用低饱和 pastel，卡片纯白 + 大圆角 + 主色淡阴影；
 * - 正文不用纯黑，用同色系深色（`#4A2C36` 这类），更柔；
 * - 强调色只用于徽标、进度、装饰点，不用于大面积填充。
 */

export interface ThemePreset {
  id: string;
  /** 主题名（可爱命名） */
  name: string;
  /** 主题 emoji，同时作为列表里的视觉标识 */
  emoji: string;
  /** 一句话风格描述 */
  desc: string;
  /** 主色：按钮、价格、选中态 */
  primary: string;
  /** 强调色：徽标、装饰、次级高亮 */
  accent: string;
  /** 页面背景（低饱和） */
  bg: string;
  /** 正文色（同色系深色） */
  text: string;
  /** 卡片底色 */
  card: string;
}

export const DEFAULT_PRESET_ID = 'softlight';

export const PRESETS: ThemePreset[] = [
  {
    // 设计稿配色：主色/底色/正文全部来自 docs/design.png 的像素采样
    id: 'softlight',
    name: '柔光玫瑰',
    emoji: '🌹',
    desc: '设计稿配色：干枯玫瑰 + 暖奶油',
    primary: '#B45F6B',
    accent: '#D8B4A6',
    bg: '#FBF5F0',
    text: '#2D221E',
    card: '#FFFFFF',
  },
  {
    id: 'strawberry',
    name: '草莓奶昔',
    emoji: '🍓',
    desc: '甜到心里的经典粉',
    primary: '#FF8BA7',
    accent: '#FFC2D1',
    bg: '#FFF5F8',
    text: '#4A2C36',
    card: '#FFFFFF',
  },
  {
    id: 'peach',
    name: '蜜桃气泡',
    emoji: '🍑',
    desc: '暖暖的橘粉，元气满满',
    primary: '#FF9E7D',
    accent: '#FFD3A5',
    bg: '#FFF7F2',
    text: '#4A3328',
    card: '#FFFFFF',
  },
  {
    id: 'taro',
    name: '紫芋波波',
    emoji: '🍠',
    desc: '温柔香芋紫，显白又高级',
    primary: '#A98BF5',
    accent: '#D9C8FF',
    bg: '#F8F5FF',
    text: '#362B4A',
    card: '#FFFFFF',
  },
  {
    id: 'mint',
    name: '薄荷奶绿',
    emoji: '🌿',
    desc: '清爽薄荷，夏天最舒服',
    primary: '#4FC9A0',
    accent: '#B7EBD8',
    bg: '#F2FBF7',
    text: '#23443A',
    card: '#FFFFFF',
  },
  {
    id: 'sky',
    name: '天空棉花糖',
    emoji: '☁️',
    desc: '软软的蓝，安静又干净',
    primary: '#6FB6FF',
    accent: '#BBDCFF',
    bg: '#F3F8FF',
    text: '#24384F',
    card: '#FFFFFF',
  },
  {
    id: 'lemon',
    name: '柠檬芝士',
    emoji: '🍋',
    desc: '明亮柠檬黄，好心情开关',
    primary: '#F5C242',
    accent: '#FFE79A',
    bg: '#FFFBF0',
    text: '#4A3C1E',
    card: '#FFFFFF',
  },
];

/**
 * 自定义主色可选色板。
 * 限定色板（而不是自由取色）是刻意的：这套色都能和白色卡片、深色正文配出合格对比度，
 * 自由取色很容易挑出「白字看不清」的主色，反而伤可用性。
 */
export const CUSTOM_PALETTE: { hex: string; name: string }[] = [
  { hex: '#FF6F9C', name: '樱花粉' },
  { hex: '#FF8A5B', name: '珊瑚橘' },
  { hex: '#F2B01E', name: '蜂蜜黄' },
  { hex: '#57C08A', name: '抹茶绿' },
  { hex: '#3FB6C8', name: '海盐青' },
  { hex: '#5C8DF6', name: '宝石蓝' },
  { hex: '#8B6DE8', name: '鸢尾紫' },
  { hex: '#E064B0', name: '莓果紫红' },
  { hex: '#C98A5B', name: '奶茶棕' },
  { hex: '#6B7280', name: '雾感灰' },
];

export function findPreset(id: string): ThemePreset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}
