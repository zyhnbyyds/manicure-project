import { CUSTOM_PALETTE, PRESETS } from '../../theme/presets';
import {
  getThemeState,
  resetTheme,
  setCustomPrimary,
  setPreset,
} from '../../theme/theme';
import { basePageData } from '../../utils/page';
import { toast } from '../../utils/ui';

/**
 * 主题设置。
 *
 * 交互取舍：**点击即生效**（不做「预览 - 保存」两步）。
 * 理由：本页自身就是最真实的预览（卡片、按钮、价格、导航栏都跟着变），
 * 再叠一层「预览态」只会让用户怀疑「到底哪个算数」。
 * 误触成本也低——主题随时可再改，且提供「恢复默认」。
 */
Page({
  data: {
    ...basePageData(),
    presets: PRESETS,
    palette: CUSTOM_PALETTE,
    activePresetId: '',
    customPrimary: '',
    isCustom: false,
  },

  onLoad() {
    this.syncState();
  },

  onShow() {
    this.syncState();
  },

  syncState() {
    const state = getThemeState();
    this.setData({
      ...basePageData(),
      activePresetId: state.presetId,
      customPrimary: state.customPrimary ?? '',
      isCustom: state.isCustom,
    });
  },

  onPreset(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id);
    setPreset(id);
    this.syncState();
    const state = getThemeState();
    toast(`已换成「${state.name}」${state.emoji}`, 'success');
  },

  onCustom(event: WechatMiniprogram.TouchEvent) {
    const hex = String(event.currentTarget.dataset.hex);
    setCustomPrimary(hex);
    this.syncState();
    toast('已应用自定义主色', 'success');
  },

  onReset() {
    resetTheme();
    this.syncState();
    toast('已恢复默认主题', 'success');
  },
});
