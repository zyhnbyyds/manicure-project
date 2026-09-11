import { getThemeTokens } from '../../theme/theme';
import { buildIcons, type IconName } from '../../utils/icons';
import { basePageData } from '../../utils/page';
import { toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['calendar', 'gift', 'star', 'chat', 'check'];

/** 页签（设计稿五档） */
const TABS = [
  { key: 'all', label: '全部' },
  { key: 'system', label: '系统通知' },
  { key: 'booking', label: '预约提醒' },
  { key: 'promo', label: '活动优惠' },
  { key: 'service', label: '客服消息' },
];

/**
 * 消息中心（docs/manicure-ui-batch5 第 2 屏）。
 *
 * **模型状态比「没有」更微妙，值得写清楚**：
 * 站内消息的**表与发送链路已经有了** —— `sys_notice_log` + `NoticePort` 的
 * `recipientType: 'customer'` 与 `channels: ['site']`，也就是后台完全可以给
 * 某位顾客落一条站内消息（预约提醒、活动通知等）。
 * **缺的只是顾客侧的读取接口**（app 域没有任何 notice 控制器）。
 *
 * 所以这页保留设计稿的骨架（五个页签、「全部已读」、卡片与分类图标、底部「没有更多了」），
 * 列表为空并如实说明。补齐需要：
 * 1. `GET /app/notices?category=&page=`（只返回 `recipient_type='customer'`
 *    且 `recipient_id = 当前绑定顾客` 的记录 —— 与 §8.3「只有本人数据」一致）；
 * 2. `POST /app/notices/read`（批量已读；必须带 `recipient_id` 条件，否则能改别人的）；
 * 3. 页签的分类需要落到模板：`sys_notice_template.code` 前缀或新增分类列。
 */
Page({
  data: {
    ...basePageData(),
    icons: buildIcons(PAGE_ICONS, '#2D221E'),
    tabs: TABS,
    activeTab: 'all',
    /** 消息列表：缺读取接口，恒为空 */
    notices: [] as unknown[],
  },

  onShow() {
    this.setData({
      ...basePageData(),
      icons: buildIcons(PAGE_ICONS, getThemeTokens().text),
    });
  },

  onTab(event: WechatMiniprogram.TouchEvent) {
    const key = String(event.currentTarget.dataset.key);
    if (key === this.data.activeTab) return;
    this.setData({ activeTab: key });
    if (this.data.notices.length === 0) return;
    toast('消息分类待接口接入后可用');
  },

  onReadAll() {
    if (this.data.notices.length === 0) {
      toast('暂时没有未读消息');
      return;
    }
    toast('批量已读待接口接入');
  },
});
