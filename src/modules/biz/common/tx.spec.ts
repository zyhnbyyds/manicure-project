import { describe, expect, it } from 'vitest';
import { withoutUndefined } from './tx.js';

describe('biz/common/tx', () => {
  it('只剔除 undefined，保留 null / 0 / 空串 / false（局部更新不能误删字段）', () => {
    expect(
      withoutUndefined({
        name: '甲油胶',
        remark: undefined,
        price: 0,
        note: null,
        enabled: false,
        tag: '',
      }),
    ).toEqual({
      name: '甲油胶',
      price: 0,
      note: null,
      enabled: false,
      tag: '',
    });
  });

  it('全部为 undefined 时返回空对象', () => {
    expect(withoutUndefined({ a: undefined, b: undefined })).toEqual({});
  });

  it('不修改原对象（纯函数，可安全复用入参）', () => {
    const source = { a: 1, b: undefined };
    withoutUndefined(source);
    expect(source).toEqual({ a: 1, b: undefined });
  });
});
