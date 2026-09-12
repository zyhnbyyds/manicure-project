/**
 * 下拉选项补全的回归测试。
 *
 * 守的是「已停用项目」这条口径：它必须**留在选项里且可见**。
 * 之前是就地往 `itemOptions.value` 上 `push`（依赖调用方那个数组的身份），
 * 现在改成返回新数组，测试把「不改入参」这条也钉住 —— 调用方的数组常常是
 * 从上一次渲染里带过来的，就地改会串页。
 */
import { describe, expect, it } from 'vitest';
import { withDisabledSelected } from './select-options';

const OPTIONS = [
  { label: '纯色美甲（60 分钟）', value: '1' },
  { label: '法式美甲（75 分钟）', value: '2' },
];

describe('已停用项目的补全', () => {
  it('启用中的项目保持原样，不重复也不改禁用态', () => {
    const next = withDisabledSelected(OPTIONS, [
      { id: 1, name: '纯色美甲' },
      { id: 2, name: '法式美甲' },
    ]);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual(OPTIONS[0]);
    expect(next.every((option) => !option.disabled)).toBe(true);
  });

  it('不在启用列表里的项目：补进来、标注已停用、禁用', () => {
    const next = withDisabledSelected(OPTIONS, [
      { id: 2, name: '法式美甲' },
      { id: 9, name: '旧款猫眼' },
    ]);
    expect(next).toHaveLength(3);
    expect(next[2]).toEqual({
      label: '旧款猫眼（已停用）',
      value: '9',
      disabled: true,
    });
  });

  it('**不改入参**（返回新数组；调用方的数组可能来自上一次渲染）', () => {
    const input = OPTIONS.map((option) => ({ ...option }));
    const snapshot = JSON.stringify(input);
    const next = withDisabledSelected(input, [{ id: 9, name: '旧款猫眼' }]);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(next).not.toBe(input);
    expect(next[0]).not.toBe(input[0]);
  });

  it('空已选 / 空选项都安全', () => {
    expect(withDisabledSelected(OPTIONS, [])).toEqual(OPTIONS);
    expect(withDisabledSelected([], [{ id: 3, name: '孤项' }])).toEqual([
      { label: '孤项（已停用）', value: '3', disabled: true },
    ]);
  });
});
