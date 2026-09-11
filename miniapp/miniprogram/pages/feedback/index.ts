import { getThemeTokens } from '../../theme/theme';
import { buildIcons, type IconName } from '../../utils/icons';
import { basePageData } from '../../utils/page';
import { toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['chat'];

/** 反馈类型（设计稿四档，单选） */
const TYPES = ['功能异常', '体验建议', '内容问题', '其他'];

/** 图片位（设计稿三格） */
const IMAGE_SLOTS = [0, 1, 2];

/**
 * 意见反馈（docs/manicure-ui-batch5 第 4 屏）。
 *
 * **模型里不存在**：`biz_*` 里没有任何 feedback / 工单表，后端也没有接收接口
 * （注意：`sys_notice` 是**发出的通知**，不是顾客提交的反馈，两者不能混用同一张表）。
 *
 * 所以这页把表单按设计稿完整还原（类型单选、描述与字数、图片位、联系方式、匿名开关），
 * 提交时如实提示；本地只做**必填校验**（类型与描述），不落任何数据。
 *
 * 补齐需要：`biz_feedback`
 * （customer_id 可空以支持匿名 / type / content / images json / contact / created_at）
 * + `POST /app/feedback`，且匿名提交要**不写 customer_id**（否则「匿名」是假的）。
 */
Page({
  data: {
    ...basePageData(),
    icons: buildIcons(PAGE_ICONS, '#2D221E'),
    types: TYPES,
    activeType: '',
    content: '',
    contact: '',
    anonymous: false,
    imageSlots: IMAGE_SLOTS,
    submitting: false,
  },

  onShow() {
    this.setData({
      ...basePageData(),
      icons: buildIcons(PAGE_ICONS, getThemeTokens().text),
    });
  },

  onType(event: WechatMiniprogram.TouchEvent) {
    this.setData({ activeType: String(event.currentTarget.dataset.type) });
  },

  onContentInput(event: WechatMiniprogram.Input) {
    this.setData({ content: event.detail.value });
  },

  onContactInput(event: WechatMiniprogram.Input) {
    this.setData({ contact: event.detail.value });
  },

  onAnonymous(event: WechatMiniprogram.SwitchChange) {
    this.setData({ anonymous: event.detail.value });
  },

  onAddImage() {
    toast('图片上传开发中，先写文字也能提交');
  },

  onSubmit() {
    const { activeType, content } = this.data;
    if (!activeType) {
      toast('先选一个反馈类型吧～');
      return;
    }
    if (content.trim().length < 5) {
      toast('再多写两句，方便我们定位问题');
      return;
    }
    // 没有接收接口：如实提示，不假装已提交
    toast('反馈通道正在接入，可先联系门店客服');
  },
});
