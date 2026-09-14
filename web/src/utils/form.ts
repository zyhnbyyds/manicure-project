import type { LewFormOption } from 'lew-ui';

/**
 * 给「不参与校验」的字段挂的放行规则。
 *
 * `LewForm` 只把**带 `rule` 的字段**放进 yup schema，而 `LewFormItem` 的字段级
 * 校验走 `Yup.reach(formSchema, field)`：schema 里没有这个 path 时会**同步抛错**
 * （`The schema does not contain the path: xxx`），但 `LewFormItem` 只挂了
 * `.catch()`，接不住同步异常，于是变成 Uncaught Error 刷控制台。
 *
 * 触发条件是「非必填 **且** 当前值为真值」——注意**空数组 `[]` 也是真值**，
 * 所以上传类字段（`as: 'upload'`）一定会踩到；开关类字段（`as: 'switch'`，
 * 值为 `true`）同理。
 *
 * `Yup.mixed()` 放行任何值，且不会把字段标记成 required（不会多出必填星号）。
 */
export const PASS_THROUGH_RULE = 'Yup.mixed()';

/**
 * 给所有没写 `rule` 的字段补上放行规则，保证每个字段都出现在 yup schema 里。
 *
 * 逐个手写太啰嗦也容易漏 —— 漏一个就会在「非必填 + 值为真值」时炸控制台，
 * 所以统一在 `formOptions` 外面包一层，新增字段不用再操心这件事。
 *
 * ```ts
 * const formOptions = withPassThroughRule([...]);
 * ```
 */
export function withPassThroughRule(options: LewFormOption[]): LewFormOption[] {
  return options.map((option) =>
    option.rule ? option : { ...option, rule: PASS_THROUGH_RULE },
  );
}

/**
 * `as: 'input-number'` 的 props —— **要小数就必须用它**，别写 `precision`。
 *
 * ## 为什么 `precision` 是错的
 *
 * lew-ui 的 `LewInputNumber` **没有 `precision` 这个 prop**（`props.d.ts` 里只有
 * `min` / `max` / `step` / `size` / `align` …）。写上去既不被组件识别，落到原生
 * `<input type="number">` 上也不是标准属性 —— 而原生 input 的 `step` **默认是 1**，
 * 于是任何小数都被浏览器判成 `:invalid`：
 *
 * - lew-ui 的样式给值画**删除线**（`.lew-input-number:invalid { text-decoration: line-through }`）；
 * - 提交/失焦时浏览器还会弹「Please enter a valid value. The two nearest valid values are 31 and 32.」
 *   —— 用户根本填不进 `31.229` 这种经纬度，也填不进 `68.50` 这种金额。
 *
 * 正确做法是把 `step` 设成「允许的最小步进」：金额按元输入就 `0.01`，经纬度 `0.000001`。
 *
 * ```ts
 * props: numberProps({ min: 0, decimals: 2 })              // 金额（元）
 * props: numberProps({ min: -90, max: 90, decimals: 6 })   // 经纬度
 * props: numberProps({ min: 1 })                           // 整数（默认 step=1）
 * ```
 */
export function numberProps(
  options: {
    min?: number;
    max?: number;
    /** 允许的小数位；省略 / 0 = 只收整数 */
    decimals?: number;
    placeholder?: string;
    /** 其余 props 原样透传给 `LewInputNumber`（如 `align` / `width` / `disabled`） */
    [key: string]: unknown;
  } = {},
): Record<string, unknown> {
  const { decimals, ...rest } = options;
  return { ...rest, step: decimals ? 10 ** -decimals : 1 };
}
