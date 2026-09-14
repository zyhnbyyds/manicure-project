import { shopApi } from '../../api/index';
import type { ShopProfile } from '../../api/types';
import { SHOP } from '../../config';
import type { IconName } from '../../utils/icons';
import { goServices } from '../../utils/nav';
import { definePage } from '../../utils/page';
import { toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['clock', 'location', 'headset', 'chat'];

/** 把档案拼成「展示行」：门店改配置后这些行跟着变，页面本身不用动 */
function toRows(shop: {
  hours: string;
  address: string;
  phone: string;
  wechat: string;
}): { key: string; label: string; value: string; icon: IconName }[] {
  return [
    { key: 'hours', label: '营业时间', value: shop.hours, icon: 'clock' },
    {
      key: 'address',
      label: '门店地址',
      value: shop.address,
      icon: 'location',
    },
    { key: 'phone', label: '联系电话', value: shop.phone, icon: 'headset' },
    { key: 'wechat', label: '客服微信', value: shop.wechat, icon: 'chat' },
  ];
}

/**
 * 门店信息（docs/manicure-ui-batch1 第 6 屏）。
 *
 * ## 门店档案现在来自后端
 *
 * `GET /app/shop` 读 `sys_config` —— 门店在后台「参数配置」里改完最多 10 秒生效，
 * **不用重新发版**（门店电话、营业时间恰恰是最常改的信息）。
 *
 * `config.ts` 的 `SHOP` 常量退居**兜底**：首屏先用它渲染（不发白），请求回来再覆盖；
 * 请求失败也继续用常量 —— 门店信息是「看一眼」的内容，不该因为网络抖一下就空着。
 * `wechat` / `image` / `slogan` 这些配置里没有的字段仍然取常量。
 */
definePage({
  chromeIcons: PAGE_ICONS,
  data: {
    shop: SHOP,
    /** 门店照片（本地占位素材） */
    shopImage: SHOP.image,
    rows: toRows(SHOP),
    /** 门店公告（配置里没有就是空串，WXML 里据此不显示这一块） */
    notice: '',
  },

  onLoad() {
    void this.load();
  },

  async load() {
    try {
      const profile: ShopProfile = await shopApi.get();
      const merged = {
        ...SHOP,
        name: profile.name,
        nameEn: profile.nameEn,
        phone: profile.phone,
        address: profile.address,
        hours: profile.hours,
        latitude: profile.latitude ?? SHOP.latitude,
        longitude: profile.longitude ?? SHOP.longitude,
      };
      this.setData({
        shop: merged,
        rows: toRows({ ...merged, wechat: SHOP.wechat }),
        notice: profile.notice ?? '',
      });
    } catch {
      // 门店档案拿不到就继续用常量：这页是「看一眼」的内容，不该因为网络抖动变空
    }
  },

  onRowTap(event: WechatMiniprogram.TouchEvent) {
    const key = String(event.currentTarget.dataset.key);
    // 用 data 里合并后的门店信息（不是常量），否则改了后台配置导航还是老地址
    const shop = this.data.shop;
    if (key === 'address') {
      // 真实动作：打开地图选点（不需要额外权限）
      wx.openLocation({
        latitude: shop.latitude,
        longitude: shop.longitude,
        name: shop.name,
        address: shop.address,
        scale: 16,
      });
      return;
    }
    if (key === 'phone') {
      wx.makePhoneCall({ phoneNumber: shop.phone });
      return;
    }
    if (key === 'wechat') {
      wx.setClipboardData({
        data: SHOP.wechat,
        success: () => toast('微信号已复制'),
      });
      return;
    }
    toast(`营业时间 ${shop.hours}`);
  },

  goBooking() {
    goServices();
  },
});
