/**
 * 主题系统：**一处定义主色，全局派生**，并支持用户修改 + 持久化。
 *
 * 设计取舍（为什么这么做）：
 * 1. 令牌（tokens）用「语义名」而不是「颜色名」：`--c-primary` / `--c-bg` / `--c-text`，
 *    页面只写语义，换主题时页面零改动；
 * 2. 派生集中在 `buildTokens()`：预设主题与自定义主色**同一条派生链路**，
 *    避免「预设好看、自定义翻车」；
 * 3. 主题不只作用于页面：导航栏颜色一起改（`wx.setNavigationBarColor`），
 *    否则顶部还是默认白，主题感断掉；
 * 4. 页面刷新走 `onShow` 重新取一次（主题页返回时恰好触发），
 *    自定义 TabBar 则是常驻组件，用订阅。
 */
import {
  darken,
  lighten,
  mix,
  normalizeHex,
  readableOn,
  withAlpha,
} from '../utils/color';
import {
  CUSTOM_PALETTE,
  DEFAULT_PRESET_ID,
  findPreset,
  type ThemePreset,
} from './presets';

const STORAGE_KEY = 'manicure:theme';

export interface ThemeState {
  /** 预设主题 ID；自定义主色时仍保留用户最后一次选的预设，方便一键切回 */
  presetId: string;
  /** 自定义主色（`null` = 使用预设主题） */
  customPrimary: string | null;
  /** 当前生效主题名 */
  name: string;
  /** 当前生效主题 emoji */
  emoji: string;
  /** 是否自定义 */
  isCustom: boolean;
}

export interface ThemeTokens {
  primary: string;
  primarySoft: string;
  primaryDeep: string;
  onPrimary: '#FFFFFF' | '#000000';
  accent: string;
  accentSoft: string;
  /** 未选中胶囊 / 浅色块底 */
  chipBg: string;
  bg: string;
  bgSoft: string;
  card: string;
  text: string;
  textSub: string;
  textWeak: string;
  border: string;
  shadow: string;
  shadowStrong: string;
  gradient: string;
}

type Listener = (payload: { state: ThemeState; tokens: ThemeTokens }) => void;

const listeners = new Set<Listener>();

let state: ThemeState = {
  presetId: DEFAULT_PRESET_ID,
  customPrimary: null,
  name: '',
  emoji: '🍓',
  isCustom: false,
};

let tokens: ThemeTokens = buildTokensFromPreset(DEFAULT_PRESET_ID);

/* ------------------------------------------------------------------ *
 * 派生
 * ------------------------------------------------------------------ */

function buildTokens(base: {
  primary: string;
  accent: string;
  bg: string;
  text: string;
  card: string;
}): ThemeTokens {
  const primary = normalizeHex(base.primary);
  const accent = normalizeHex(base.accent);
  const text = normalizeHex(base.text);
  const card = normalizeHex(base.card);
  const bg = normalizeHex(base.bg);

  return {
    primary,
    primarySoft: mix(primary, card, 0.14),
    primaryDeep: darken(primary, 0.2),
    onPrimary: readableOn(primary),
    accent,
    accentSoft: mix(accent, card, 0.35),
    // 设计稿的未选中胶囊是浅暖灰（不是主色淡粉），故从 accent 派生
    chipBg: mix(accent, card, 0.22),
    bg,
    bgSoft: mix(primary, card, 0.04),
    card,
    text,
    textSub: mix(text, card, 0.56),
    textWeak: mix(text, card, 0.34),
    // 边框与阴影都用中性暖色，避免整页泛粉（设计稿即如此）
    border: mix(text, card, 0.09),
    shadow: withAlpha(text, 0.06),
    shadowStrong: withAlpha(text, 0.1),
    gradient: `linear-gradient(135deg, ${lighten(accent, 0.45)} 0%, ${lighten(primary, 0.78)} 100%)`,
  };
}

function buildTokensFromPreset(presetId: string): ThemeTokens {
  const preset: ThemePreset = findPreset(presetId) ?? {
    id: DEFAULT_PRESET_ID,
    name: '柔光玫瑰',
    emoji: '🌹',
    desc: '',
    primary: '#B45F6B',
    accent: '#D8B4A6',
    bg: '#FBF5F0',
    text: '#2D221E',
    card: '#FFFFFF',
  };
  return buildTokens(preset);
}

/** 自定义主色 → 一整套令牌（与预设同一套规则，只是色相来自用户选色） */
function buildTokensFromCustom(hex: string): ThemeTokens {
  const primary = normalizeHex(hex);
  return buildTokens({
    primary,
    accent: lighten(primary, 0.42),
    bg: mix(primary, '#FFFFFF', 0.07),
    text: mix(primary, '#2B2B2B', 0.24),
    card: '#FFFFFF',
  });
}

/* ------------------------------------------------------------------ *
 * 持久化
 * ------------------------------------------------------------------ */

function persist(): void {
  wx.setStorageSync(STORAGE_KEY, {
    presetId: state.presetId,
    customPrimary: state.customPrimary,
  });
}

function restore(): void {
  const raw = wx.getStorageSync(STORAGE_KEY) as
    | { presetId?: string; customPrimary?: string | null }
    | '';
  if (!raw || typeof raw !== 'object') return;
  const presetId =
    typeof raw.presetId === 'string' ? raw.presetId : DEFAULT_PRESET_ID;
  const customPrimary =
    typeof raw.customPrimary === 'string' && raw.customPrimary.length > 0
      ? normalizeHex(raw.customPrimary)
      : null;
  if (!findPreset(presetId) && customPrimary === null) return;
  state = { ...state, presetId, customPrimary };
}

/* ------------------------------------------------------------------ *
 * 应用
 * ------------------------------------------------------------------ */

/** 把 tokens 摊平成 WXSS 自定义属性串，页面根节点直接挂 `style="{{themeStyle}}"` */
export function toStyleString(input: ThemeTokens): string {
  return Object.entries(input)
    .map(([key, value]) => {
      const kebab = key.replace(
        /[A-Z]/g,
        (letter) => `-${letter.toLowerCase()}`,
      );
      return `--c-${kebab}:${value}`;
    })
    .join(';');
}

function syncChrome(input: ThemeTokens): void {
  try {
    // 设计稿的导航栏是**奶油底色 + 深色标题**（不是主色底白字），
    // 所以这里用 bg 作底色、黑色作前景；主色只留给按钮与价格。
    wx.setNavigationBarColor({
      frontColor: '#000000',
      backgroundColor: input.bg,
      fail: () => {
        /* 部分基础库/低版本不支持时忽略：页面内样式仍然正确 */
      },
    });
  } catch {
    /* 忽略：导航栏不是关键路径 */
  }
}

function refresh(): void {
  const preset = findPreset(state.presetId);
  if (state.customPrimary) {
    tokens = buildTokensFromCustom(state.customPrimary);
    state = {
      ...state,
      name: '自定义',
      emoji: '🎨',
      isCustom: true,
    };
  } else {
    tokens = buildTokensFromPreset(state.presetId);
    state = {
      ...state,
      name: preset?.name ?? '草莓奶昔',
      emoji: preset?.emoji ?? '🍓',
      isCustom: false,
    };
  }
  syncChrome(tokens);
  const payload = { state, tokens };
  listeners.forEach((listener) => listener(payload));
}

/* ------------------------------------------------------------------ *
 * 对外
 * ------------------------------------------------------------------ */

/** `app.onLaunch` 调用一次：读本地偏好并套用 */
export function initTheme(): void {
  restore();
  refresh();
}

export function getThemeState(): ThemeState {
  return state;
}

export function getThemeTokens(): ThemeTokens {
  return tokens;
}

export function themeStyle(): string {
  return toStyleString(tokens);
}

export function setPreset(presetId: string): void {
  if (!findPreset(presetId)) return;
  state = { ...state, presetId, customPrimary: null };
  persist();
  refresh();
}

export function setCustomPrimary(hex: string | null): void {
  state = {
    ...state,
    customPrimary: hex ? normalizeHex(hex) : null,
  };
  persist();
  refresh();
}

export function resetTheme(): void {
  state = { ...state, presetId: DEFAULT_PRESET_ID, customPrimary: null };
  persist();
  refresh();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 选色板透出（主题页用） */
export { CUSTOM_PALETTE };
