import { CUSTOM_PALETTE, PRESETS } from '../../theme/presets';
import {
  getThemeState,
  resetTheme,
  setCustomPrimary,
  setPreset,
} from '../../theme/theme';
import { definePage } from '../../utils/page';
import { toast } from '../../utils/ui';

/**
 * 主题设置。
 *
 * 这一页**设计稿里没有**（是「主题可修改」这个需求带来的自有页面），
 * 所以它的任务是：**用设计稿的语言把功能装进去** —— 语义令牌、衬线标题、
 * 细线图标、暖奶油底色，以及与其它页面一致的间距节奏。
 *
 * 两处刻意的选择：
 * 1. **点击即生效**，不做「预览 - 保存」两步：本页自身就是最真实的预览
 *    （卡片、按钮、价格、导航栏都跟着变），再叠一层预览态只会让人怀疑哪个算数；
 * 2. **不显示 emoji**：预设数据里保留了 `emoji` 字段（历史数据），但界面上不用 ——
 *    整套视觉的硬要求是不用 emoji，主题卡片改用**色板圆点**表达差异，更准确也更克制。
 */
definePage({
  data: {
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
      activePresetId: state.presetId,
      customPrimary: state.customPrimary ?? '',
      isCustom: state.isCustom,
    });
  },

  onPreset(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id);
    setPreset(id);
    this.syncState();
    toast(`已换成「${getThemeState().name}」`, 'success');
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
