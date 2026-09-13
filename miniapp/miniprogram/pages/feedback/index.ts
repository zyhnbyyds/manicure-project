import { feedbackApi } from '../../api/index';
import type { IconName } from '../../utils/icons';
import { isApiFailure } from '../../utils/request';
import { definePage } from '../../utils/page';
import { hideLoading, showLoading, toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['chat'];

/** 反馈类型（设计稿四档，单选） */
const TYPES = ['功能异常', '体验建议', '内容问题', '其他'];

/** 图片位（设计稿三格） */
const IMAGE_SLOTS = [0, 1, 2];

/**
 * 意见反馈（docs/manicure-ui-batch5 第 4 屏）。
 *
 * 表单按设计稿完整还原（类型单选、描述与字数、图片位、联系方式、匿名开关），
 * 提交走 `POST /app/feedback` → 落 `biz_feedback`，门店在后台跟进。
 *
 * 两条口径：
 * 1. **不要求绑定手机号**：访客也有意见要说，硬拦只会让他去别处说；
 * 2. **匿名真的匿名**：`anonymous: true` 时后端一律落 `customer_id = null` ——
 *    「记了身份再标匿名」等于骗人，而这是当着顾客的面做出的承诺。
 *
 * **图片位暂未接入**：设计稿有三格图片，需要先把小程序上传接到文件接口
 * （后端的文件存储与管理端上传已有，缺的是 C 端上传入口与配额约束）。
 * 现在点它如实提示，不假装能传。
 */
definePage({
  chromeIcons: PAGE_ICONS,

  data: {
    types: TYPES,
    activeType: '',
    content: '',
    contact: '',
    anonymous: false,
    imageSlots: IMAGE_SLOTS,
    submitting: false,
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
    toast('图片上传还在接入，先写文字也能提交');
  },

  /**
   * 提交反馈。
   *
   * 本地只拦「明显不完整」（类型、最少字数），真正的规则在服务端（`.strict()` + 长度）。
   * 提交成功**清空表单**并弹确认 —— 反馈是只写不读的通道，没有列表可以回去看，
   * 表单不清空的话顾客会怀疑到底提交上没有。
   */
  async onSubmit() {
    const { activeType, content, contact, anonymous } = this.data;
    if (!activeType) {
      toast('先选一个反馈类型吧～');
      return;
    }
    if (content.trim().length < 5) {
      toast('再多写两句，方便我们定位问题');
      return;
    }
    if (this.data.submitting) return;

    this.setData({ submitting: true });
    showLoading('提交中');
    try {
      const result = await feedbackApi.submit({
        type: activeType,
        content: content.trim(),
        ...(contact.trim() ? { contact: contact.trim() } : {}),
        anonymous,
      });
      hideLoading();
      this.setData({
        submitting: false,
        activeType: '',
        content: '',
        contact: '',
        anonymous: false,
      });
      wx.showModal({
        title: '已收到你的反馈',
        content: result.anonymous
          ? '这条反馈以匿名方式提交，门店看不到你的身份。'
          : '门店会尽快查看；留了联系方式的话，需要时会联系你。',
        showCancel: false,
        confirmText: '好',
        confirmColor: '#B45F6B',
      });
    } catch (error) {
      hideLoading();
      this.setData({ submitting: false });
      toast(isApiFailure(error) ? error.message : '提交失败，请稍后再试');
    }
  },
});
