/**
 * 下拉选项的纯逻辑（可单测）。
 *
 * ## 为什么有「已停用」这一档
 *
 * 「美甲师可做项目」「次卡适用项目」这类配置是**白名单**：库里存着 id，
 * 而项目列表接口只返回**启用中**的项目。于是一个项目被停用之后：
 *
 * - 打开弹窗时它的名字查不到 → 多选框里**什么都不显示**（像是没配过）；
 * - 直接保存 → 后端判定「引用了停用项目」→ 409/400，用户完全不知道错在哪。
 *
 * 所以要把这些 id 补回选项里并标成 `disabled`：看得见、点不了、页面还能提示
 * 「请先取消勾选」——比静默丢弃或莫名报错都清楚。
 */

export interface SelectOption {
  label: string;
  value: string;
  disabled?: boolean;
}

/** 补全后的选项数组（**新数组**，不改调用方传进来的那个） */
export function withDisabledSelected(
  options: readonly SelectOption[],
  selected: readonly { id: number; name: string }[],
): SelectOption[] {
  const next = options.map((option) => ({ ...option }));
  const known = new Set(next.map((option) => option.value));
  for (const item of selected) {
    const value = String(item.id);
    if (known.has(value)) continue; // 启用中的项目：选项已经在列表里，保持原样
    known.add(value);
    next.push({ label: `${item.name}（已停用）`, value, disabled: true });
  }
  return next;
}
