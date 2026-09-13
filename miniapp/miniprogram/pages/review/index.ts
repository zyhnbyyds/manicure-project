import { bookingApi } from '../../api/index';
import { fenToYuan } from '../../utils/format';
import { starIcons } from '../../utils/icons';
import { goBack, goBookings } from '../../utils/nav';
import { definePage } from '../../utils/page';
import { isApiFailure } from '../../utils/request';
import { hideLoading, showLoading, toast } from '../../utils/ui';
import { chooseAndUploadImage } from '../../utils/upload';

/** 设计稿里的快捷标签（点选后拼进评价内容） */
const TAGS = ['手艺细腻', '沟通耐心', '环境干净', '款式还原度高'];

/** 图片上限：与后端 `appCreateReviewRequestSchema` 的 `images` 上限一致 */
const MAX_IMAGES = 9;

/**
 * 服务评价（docs/manicure-ui-batch1 第 5 屏）。
 *
 * 入参 `bookingId`，提交走 `POST /app/reviews`（后端已是真实现：
 * 仅本人 + 仅已完成 + 一单一评）。评分与文字是真提交；
 * **配图先传后提交**：选图即刻上传（/app/upload），提交时只带地址（单张失败不影响文字提交）。
 * 所以图片位保留设计稿视觉，点击如实提示。
 */
definePage({
  extra: () => starIcons(),

  data: {
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
    /** 已上传的配图：src 用于预览、path 提交给后端 */
    images: [] as { src: string; path: string }[],
    submitting: false,
    uploading: false,
  },

  /** 被评价的订单 id（实例属性，不进 data） */
  targetBookingId: 0,

  onLoad(query: Record<string, string | undefined>) {
    this.targetBookingId = Number(query.bookingId ?? 0);
    this.load();
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
    void this.addImage();
  },

  /** 选图并上传：选完立刻传，提交时只带地址（提交那一刻不该再等网络） */
  async addImage() {
    if (this.data.uploading) return;
    const room = MAX_IMAGES - this.data.images.length;
    if (room <= 0) {
      toast(`最多传 ${MAX_IMAGES} 张`);
      return;
    }
    this.setData({ uploading: true });
    const uploaded = await chooseAndUploadImage(room);
    this.setData({
      uploading: false,
      images: uploaded ? [...this.data.images, uploaded] : this.data.images,
    });
  },

  onRemoveImage(event: WechatMiniprogram.TouchEvent) {
    const index = Number(event.currentTarget.dataset.index);
    this.setData({ images: this.data.images.filter((_, i) => i !== index) });
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
        // 图片先传后提交：这里只带地址（后端 images 上限 9，与设计稿一致）
        ...(this.data.images.length > 0
          ? { images: this.data.images.map((item) => item.path) }
          : {}),
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
