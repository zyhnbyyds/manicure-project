import { ref } from 'vue';
import { listCustomers } from '~/api/biz/customers';

/** 顾客下拉选项（`disabled` 用于「无手机号不能入会」这类前置条件） */
export interface CustomerOption {
  label: string;
  value: string;
  disabled?: boolean;
}

/**
 * 只需要这几个字段，别要求调用方凑出完整的 `Customer` ——
 * 会员详情返回的是 `MemberDetail`，结构上就少几个审计字段，按完整类型签名会平白报错。
 */
export interface CustomerLike {
  id: number;
  name: string;
  phone: string | null;
  /** 有值 = 已入会 */
  memberNo?: string | null;
}

/** 选项文案里给运营看的状态标记 */
function marksOf(customer: CustomerLike): string[] {
  const marks: string[] = [];
  // 手机号是会员的必填锚点：没有手机号就入不了会，标出来省一次 400
  if (!customer.phone) marks.push('无手机号');
  if (customer.memberNo) marks.push('已入会');
  return marks;
}

/**
 * 顾客下拉选项（姓名 / 手机号搜索）。
 *
 * 此前每个页面各写一份 `listCustomers` → `options`，而且**多处直接让运营手填「顾客 ID」**——
 * 内部主键不是给人看的。统一走这里：能搜、能看名字、能标出「无手机号 / 已入会」。
 *
 * ```ts
 * const { options, searching, search, ensure } = useCustomerOptions();
 * void search();                    // 首次载入
 * await search('张三');             // 关键词搜索
 * ensure(customer);                 // 从行内打开弹窗：把已知顾客塞进选项，否则下拉是空白
 * void search('', 30, { requirePhone: true }); // 入会场景：无手机号项置灰
 * ```
 */
export function useCustomerOptions() {
  const options = ref<CustomerOption[]>([]);
  const searching = ref(false);

  function toOption(
    customer: CustomerLike,
    requirePhone = false,
  ): CustomerOption {
    const marks = marksOf(customer);
    return {
      label: `${customer.name}${customer.phone ? ` / ${customer.phone}` : ''}${
        marks.length ? `（${marks.join('·')}）` : ''
      }`,
      value: String(customer.id),
      disabled: requirePhone && !customer.phone,
    };
  }

  async function search(
    keyword = '',
    size = 30,
    { requirePhone = false }: { requirePhone?: boolean } = {},
  ) {
    searching.value = true;
    try {
      const trimmed = keyword.trim();
      const data = await listCustomers(
        1,
        size,
        trimmed ? { keyword: trimmed } : {},
      );
      options.value = data.items.map((item) => toOption(item, requirePhone));
    } finally {
      searching.value = false;
    }
  }

  /** 把已知顾客插到选项最前面（已存在则原地更新），用于「从行内打开弹窗」预置选中项 */
  function ensure(customer: CustomerLike, requirePhone = false) {
    const option = toOption(customer, requirePhone);
    const index = options.value.findIndex(
      (item) => item.value === option.value,
    );
    if (index >= 0) options.value.splice(index, 1, option);
    else options.value = [option, ...options.value];
  }

  return { options, searching, search, ensure, toOption };
}
