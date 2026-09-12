/**
 * 表格 / 列表里的长文本单元格：**超出一行即省略，悬浮显示完整内容**。
 *
 * ## 为什么要有这一层
 *
 * 迁移前 11 个页面各写一遍：
 *
 * ```ts
 * return h('span', { class: 'block w-full truncate align-middle', title: text }, text);
 * ```
 *
 * 两个问题：
 * 1. `title` 是浏览器原生 tooltip —— 样式跟不了主题、延迟与位置不可控、
 *    移动端长按才出、和 lew-ui 其它组件的 tooltip 观感完全两套；
 * 2. 省略靠手写 `truncate`，每一处都得记得加，漏一处就撑破列宽（而且不会有人发现）。
 *
 * 现在统一走 lew-ui 的 `LewTextTrim`：省略、tooltip、溢出判定都由组件负责
 * （它在**没有溢出时不会弹 tooltip**，所以短文本单元格不会平白多出提示）。
 *
 * ## 用法
 *
 * ```ts
 * customRender: ({ row }) => trimCell(row.description)          // 空值显示 '-'
 * customRender: ({ row }) => trimCell(row.reason, { empty: '' }) // 空值留白
 * customRender: ({ row }) => trimCell(text, { class: 'max-w-320px' })
 * ```
 */
import { h, type VNode } from 'vue';
import { LewTextTrim } from 'lew-ui';

export interface TrimCellOptions {
  /** 空值占位（默认 `'-'`；传 `''` 表示留白，与迁移前「渲染空 span」等价） */
  empty?: string;
  /** 追加到组件根节点的类（尺寸 / 颜色 / flex 布局等仍由调用方决定） */
  class?: string;
}

export function trimCell(
  text: unknown,
  options: TrimCellOptions = {},
): VNode | string {
  const value = text === null || text === undefined ? '' : String(text);
  if (!value) return options.empty ?? '-';
  return h(LewTextTrim, { text: value, class: options.class });
}
