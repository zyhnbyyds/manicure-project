import { shopApi } from '../../api/index';
import type { ShopBrief, ShopProfile } from '../../api/types';
import { SHOP } from '../../config';
import { setCurrentStoreId } from '../../store/shop';
import { formatDistance, sortByDistance } from '../../utils/geo';
import type { LatLng } from '../../utils/geo';
import type { IconName } from '../../utils/icons';
import { goServices } from '../../utils/nav';
import { definePage } from '../../utils/page';
import { toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['clock', 'location', 'headset', 'chat'];

/** 门店列表项（视图用：多一个算好的距离文案） */
type StoreItem = ShopBrief & { distanceText: string };

/** 列表项 + 距离：算不出距离的（门店没配坐标）排在最后，只是不显示距离 */
function toStoreItems(items: ShopBrief[], origin: LatLng | null): StoreItem[] {
  return sortByDistance(items, origin).map((item) => ({
    ...item,
    distanceText: formatDistance(item.distance),
  }));
}

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
    /** 门店头图：后台图集第一张，没传过时用内置素材 */
    shopImage: SHOP.image,
    rows: toRows(SHOP),
    /** 门店公告（配置里没有就是空串，WXML 里据此不显示这一块） */
    notice: '',
    /** 门店列表（只有 >1 家时才会渲染）（单店期不该看到「选门店」这个概念） */
    stores: [] as StoreItem[],
    /** 当前门店 id；0 = 没选过（后端回落默认门店） */
    currentStoreId: 0,
    /** 定位得到的坐标（用于算距离）；null = 还没定位 */
    origin: null as LatLng | null,
    /** 定位中（按钮防重 + 文案） */
    locating: false,
    /** 已经定位过（按钮文案切换，避免重复请求定位） */
    located: false,
  },

  onLoad() {
    void this.load();
  },

  async load() {
    try {
      // 门店列表与档案一起拿：列表用于「切换门店」，档案用于当前店的展示
      const [profile, list]: [ShopProfile, { items: ShopBrief[] }] =
        await Promise.all([shopApi.get(), shopApi.list()]);
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
        // 门店图集第一张当封面（后台没传过就用内置素材，不掉图）
        shopImage: profile.images[0] || SHOP.image,
        // `storeId` 由后端根据「当前门店」头算出（带过了且有效就是那家，否则默认门店）
        currentStoreId: profile.storeId ?? 0,
        stores: toStoreItems(list.items, this.data.origin),
      });
    } catch {
      // 门店档案拿不到就继续用常量：这页是「看一眼」的内容，不该因为网络抖动变空
    }
  },

  /**
   * 定位找最近的门店。
   *
   * 拿到的坐标只用于**本地排序**，不上报（后端不碰顾客位置）。
   * 用户拒绝授权 / 系统定位关闭 → 提示一句、列表保持后台排序，
   * **不要把列表清空**：门店是「看一眼」的内容，定位是锦上添花。
   */
  async onLocate() {
    if (this.data.locating) return; // 连点防重
    this.setData({ locating: true });
    try {
      const location =
        await new Promise<WechatMiniprogram.GetLocationSuccessCallbackResult>(
          (resolve, reject) => {
            wx.getLocation({ type: 'gcj02', success: resolve, fail: reject });
          },
        );
      const origin: LatLng = {
        latitude: location.latitude,
        longitude: location.longitude,
      };
      const list = await shopApi.list();
      this.setData({
        origin,
        located: true,
        stores: toStoreItems(list.items, origin),
      });
      toast('已按距离由近到远排序');
    } catch {
      toast('定位没成功，默认按门店排序显示');
    } finally {
      this.setData({ locating: false });
    }
  },

  /**
   * 切换当前门店：写本地 → 重新拉数据（档案跟着变），
   * 之后的所有请求都会带上新的 `x-store-id` 头（美甲师目录、可约时段、下单落店都跟着走）。
   */
  async onPickStore(event: WechatMiniprogram.TouchEvent) {
    const id = Number(event.currentTarget.dataset.id);
    if (!Number.isSafeInteger(id) || id <= 0) return;
    if (id === this.data.currentStoreId) return; // 点的就是当前店，不折腾
    setCurrentStoreId(id);
    await this.load();
    const picked = this.data.stores.find((item) => item.id === id);
    toast(picked ? `已切换到「${picked.name}」` : '已切换门店');
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
