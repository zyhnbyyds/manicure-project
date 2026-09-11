import { catalogApi } from '../../api/index';
import { setDraftItems } from '../../store/draft';
import { goStaffs } from '../../utils/nav';
import { basePageData } from '../../utils/page';
import { toServiceItemVM, type ServiceItemVM } from '../../utils/present';
import { isApiFailure } from '../../utils/request';

/**
 * 项目详情。
 *
 * 注意一个契约事实：**app 域没有「单个项目详情」接口**（spec §9.7 只有列表）。
 * 所以这里拉列表再按 id 取——项目数量在几十条量级，多一次列表请求是可以接受的；
 * 若将来项目数量级变大，应向后台申请 `GET /app/service-items/:id`，
 * 而不是在客户端做缓存或提前把数据塞进 URL（URL 会超长且不可分享）。
 */
Page({
  data: {
    ...basePageData(),
    loading: true,
    errorText: '',
    item: null as ServiceItemVM | null,
  },

  /** 非响应式属性：不需要进 setData（避免无谓的视图层通信） */
  serviceItemId: 0,

  onLoad(query: Record<string, string | undefined>) {
    this.serviceItemId = Number(query.id ?? 0);
    this.load();
  },

  onShow() {
    this.setData(basePageData());
  },

  async load() {
    if (!this.serviceItemId) {
      this.setData({ loading: false, errorText: '没找到这个款式' });
      return;
    }
    this.setData({ loading: true, errorText: '' });
    try {
      const page = await catalogApi.listServiceItems(1, 100);
      const found = page.items.find((candidate) => candidate.id === this.serviceItemId);
      this.setData({
        loading: false,
        item: found ? toServiceItemVM(found) : null,
        errorText: found ? '' : '这个款式可能已经下架了',
      });
    } catch (error) {
      this.setData({
        loading: false,
        errorText: isApiFailure(error) ? error.message : '加载失败，请稍后再试',
      });
    }
  },

  goBook() {
    const { item } = this.data;
    if (!item) return;
    setDraftItems([
      {
        id: item.id,
        name: item.name,
        category: item.category,
        durationMinutes: item.durationMinutes,
        price: item.price,
        description: item.description,
        image: item.image,
      },
    ]);
    goStaffs();
  },
});
