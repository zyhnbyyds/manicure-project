import { SHOP } from '../../config';
import type { IconName } from '../../utils/icons';
import { goServices } from '../../utils/nav';
import { definePage } from '../../utils/page';
import { toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['clock', 'location', 'headset', 'chat'];

/**
 * 门店信息（docs/manicure-ui-batch1 第 6 屏）。
 *
 * 门店档案目前来自 `config.ts` 的 `SHOP` 常量（app 域还没有门店档案接口），
 * 页面本身只负责展示与三个真实动作：导航 / 拨号 / 复制微信号。
 */
definePage({
  chromeIcons: PAGE_ICONS,
  data: {
    shop: SHOP,
    /** 门店照片（本地占位素材） */
    shopImage: SHOP.image,
    rows: [
      { key: 'hours', label: '营业时间', value: SHOP.hours, icon: 'clock' as IconName },
      { key: 'address', label: '门店地址', value: SHOP.address, icon: 'location' as IconName },
      { key: 'phone', label: '联系电话', value: SHOP.phone, icon: 'headset' as IconName },
      { key: 'wechat', label: '客服微信', value: SHOP.wechat, icon: 'chat' as IconName },
    ],
  },

  onRowTap(event: WechatMiniprogram.TouchEvent) {
    const key = String(event.currentTarget.dataset.key);
    if (key === 'address') {
      // 真实动作：打开地图选点（不需要额外权限）
      wx.openLocation({
        latitude: SHOP.latitude,
        longitude: SHOP.longitude,
        name: SHOP.name,
        address: SHOP.address,
        scale: 16,
      });
      return;
    }
    if (key === 'phone') {
      wx.makePhoneCall({ phoneNumber: SHOP.phone });
      return;
    }
    if (key === 'wechat') {
      wx.setClipboardData({
        data: SHOP.wechat,
        success: () => toast('微信号已复制', 'success'),
      });
      return;
    }
    toast(`营业时间 ${SHOP.hours}`);
  },

  goBooking() {
    goServices();
  },
});
