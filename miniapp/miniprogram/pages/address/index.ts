import type { IconName } from '../../utils/icons';
import { definePage } from '../../utils/page';
import { toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['location'];

/**
 * 收货地址（docs/manicure-ui-batch4 第 6 屏）。
 *
 * **先问一句「这页该不该存在」**：本店的核心是**到店服务**，
 * 顾客来店里做美甲，不需要邮寄地址。设计稿里出现「收货地址」，
 * 大概率是生成时混入了电商模板 —— 只有把这些条件都满足时才需要它：
 * 1. 有**实物商品**要寄（设计稿里的「周边好物」），且
 * 2. 这些实物支持**邮寄**而不是仅到店自提。
 *
 * 所以在 1、2 未成立前，这页**保留设计稿的空态骨架**（列表 + 底部新增按钮），
 * 但不做假数据；`biz_customer_address` 表在模型里也不存在。
 *
 * 若确定要做实物邮寄，需要：`biz_customer_address`
 * （customer_id / 收货人 / 手机号 / 省市区 / 详址 / is_default + 唯一天然键）
 * + `GET/POST/PATCH/DELETE /app/addresses`，且默认地址要用条件更新保证唯一。
 */
definePage({
  chromeIcons: PAGE_ICONS,

  data: {
    /** 地址列表：模型不存在，恒为空 */
    addresses: [] as unknown[],
  },

  onAdd() {
    toast('收货地址需要「实物邮寄」功能支撑，当前不支持');
  },

  onEdit() {
    toast('地址编辑开发中');
  },

  onDelete() {
    toast('地址删除开发中');
  },
});
