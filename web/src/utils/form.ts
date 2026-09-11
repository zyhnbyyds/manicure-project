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
export function withPassThroughRule(
  options: LewFormOption[],
): LewFormOption[] {
  return options.map((option) =>
    option.rule ? option : { ...option, rule: PASS_THROUGH_RULE },
  );
}
