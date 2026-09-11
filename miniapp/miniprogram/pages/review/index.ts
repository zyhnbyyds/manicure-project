import { bookingApi } from '../../api/index';
import { getThemeTokens } from '../../theme/theme';
import { fenToYuan } from '../../utils/format';
import { buildIcons, type IconName } from '../../utils/icons';
import { goBack, goBookings } from '../../utils/nav';
import { basePageData } from '../../utils/page';
import { isApiFailure } from '../../utils/request';
import { hideLoading, showLoading, toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['star'];

/** 设计稿里的快捷标签（点选后拼进评价内容） */
const TAGS = ['手艺细腻', '沟通耐心', '环境干净', '款式还原度高'];

/** 图片上限：与后端 `appCreateReviewRequestSchema` 的 `images` 上限一致 */
const MAX_IMAGES = 9;

/**
 * 服务评价（docs/manicure-ui-batch1 第 5 屏）。
 *
 * 入参 `bookingId`，提交走 `POST /app/reviews`（后端已是真实现：
 * 仅本人 + 仅已完成 + 一单一评）。评分与文字是真提交；
 * **图片上传降级**：app 域没有文件上传接口（后端的上传在管理端），
 * 所以图片位保留设计稿视觉，点击如实提示。
 */
Page({
  data: {
    ...basePageData(),
    iconsStarOn: buildIcons(PAGE_ICONS, '#B45F6B', 24, true),
    iconsStarOff: buildIcons(PAGE_ICONS, '#D9D2CD'),
    stars: [1, 2, 3, 4, 5],
    loading: true,
    errorText: '',
    /** 图片上限（WXML 只能读 data，不能读实例属性） */
    maxImages: MAX_IMAGES,
    itemName: '',
    itemPriceText: '',
    dateText: '',
    rating: 5,
    ratingText: '非常满意',
    tags: TAGS.map((label) => ({ label, checked: false })),
    content: '',
    /** 图片位：默认展示 3 个占位格（设计稿即 3 格 + 「+」） */
    imageSlots: [0, 1, 2],
    submitting: false,
  },

  /** 被评价的订单 id（实例属性，不进 data） */
  targetBookingId: 0,

  onLoad(query: Record<string, string | undefined>) {
    this.targetBookingId = Number(query.bookingId ?? 0);
    this.load();
  },

  onShow() {
    this.setData({
      ...basePageData(),
      iconsStarOn: buildIcons(PAGE_ICONS, getThemeTokens().primary, 24, true),
    });
  },

  async load() {
    if (!this.targetBookingId) {
      this.setData({ loading: false, errorText: '没找到这笔订单' });
      return;
    }
    this.setData({ loading: true, errorText: '' });
    try {
      const page = await bookingApi.list({ page: 1, pageSize: 50 });
      const found = page.items.find((item) => item.id === this.targetBookingId);
      if (!found) {
        this.setData({ loading: false, errorText: '没找到这笔订单' });
        return;
      }
      this.setData({
        loading: false,
        itemName: found.items.map((item) => item.name).join(' · '),
        itemPriceText: fenToYuan(found.payableAmount),
        dateText: found.startAt.slice(0, 10).replace(/-/g, '.'),
      });
    } catch (error) {
      this.setData({
        loading: false,
        errorText: isApiFailure(error) ? error.message : '网络连接失败',
      });
    }
  },

  onPickStar(event: WechatMiniprogram.TouchEvent) {
    const rating = Number(event.currentTarget.dataset.value);
    const text =
      rating >= 5 ? '非常满意' : rating === 4 ? '还不错' : rating === 3 ? '一般' : '不太满意';
    this.setData({ rating, ratingText: text });
  },

  onToggleTag(event: WechatMiniprogram.TouchEvent) {
    const index = Number(event.currentTarget.dataset.index);
    const tags = this.data.tags.map((item, i) =>
      i === index ? { ...item, checked: !item.checked } : item,
    );
    this.setData({ tags });
  },

  onContentInput(event: WechatMiniprogram.Input) {
    this.setData({ content: event.detail.value });
  },

  onAddImage() {
    // app 域没有文件上传接口（上传能力在管理端），保留设计稿的图片位
    toast('图片上传开发中，先写点文字吧');
  },

  async onSubmit() {
    if (this.data.submitting) return;
    if (!this.data.rating) {
      toast('先给个评分吧～');
      return;
    }
    // 快捷标签拼进评价内容：后端 `content` 是自由文本，没有标签字段
    const pickedTags = this.data.tags.filter((item) => item.checked).map((item) => item.label);
    const content = [pickedTags.join('、'), this.data.content.trim()]
      .filter((part) => part.length > 0)
      .join('；');

    this.setData({ submitting: true });
    showLoading('提交中');
    try {
      await bookingApi.createReview({
        bookingId: this.targetBookingId,
        rating: this.data.rating,
        content: content || undefined,
      });
      hideLoading();
      wx.showModal({
        title: '评价成功',
        content: '谢谢你的反馈，我们会继续加油～',
        showCancel: false,
        confirmText: '好',
        confirmColor: '#B45F6B',
        complete: () => goBookings(),
      });
    } catch (error) {
      hideLoading();
      toast(isApiFailure(error) ? error.message : '提交失败，请稍后再试');
    } finally {
      this.setData({ submitting: false });
    }
  },

  onBack() {
    goBack();
  },
});
