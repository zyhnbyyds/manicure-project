import { describe, expect, it } from 'vitest';
import {
  buildDocNo,
  buildOutTradeNo,
  buildSettleBatch,
  tempDocNo,
} from './doc-no.js';

describe('biz/common/doc-no（§4.3 主键回填，不用「查当日最大号 +1」）', () => {
  /** 店内本地 2026-09-11 10:00 */
  const at = new Date('2026-09-11T02:00:00.000Z');

  it('单号 = 前缀 + 店内本地日 + 主键补零 6 位', () => {
    expect(buildDocNo('B', 1, 'Asia/Shanghai', at)).toBe('B20260911000001');
    expect(buildDocNo('P', 123456, 'Asia/Shanghai', at)).toBe(
      'P20260911123456',
    );
  });

  it('主键超过 6 位不截断（补零只保证下限）', () => {
    expect(buildDocNo('R', 1234567, 'Asia/Shanghai', at)).toBe(
      'R202609111234567',
    );
  });

  it('日期取店内本地日：UTC 16:00 之后算次日', () => {
    expect(
      buildDocNo('A', 1, 'Asia/Shanghai', new Date('2026-09-11T15:59:59.000Z')),
    ).toBe('A20260911000001');
    expect(
      buildDocNo('A', 1, 'Asia/Shanghai', new Date('2026-09-11T16:00:00.000Z')),
    ).toBe('A20260912000001');
  });

  it('不传时区时使用默认店内时区', () => {
    expect(buildDocNo('C', 7, undefined, at)).toBe('C20260911000007');
  });

  it('单号前缀覆盖全部业务单据类型', () => {
    for (const prefix of ['B', 'P', 'R', 'A', 'C', 'X', 'M'] as const) {
      expect(buildDocNo(prefix, 1, 'Asia/Shanghai', at).startsWith(prefix)).toBe(
        true,
      );
    }
  });

  it('对外交易号 = 前缀 + 主键补零 + 36 进制时间戳（大写、不可猜测）', () => {
    const tradeNo = buildOutTradeNo('P', 123, at);
    expect(tradeNo.startsWith('P000123')).toBe(true);
    expect(tradeNo).toMatch(/^P000123[0-9A-Z]+$/);
  });

  it('时间戳不同 → 对外交易号不同（同一主键也不会重号）', () => {
    expect(buildOutTradeNo('P', 123, at)).not.toBe(
      buildOutTradeNo('P', 123, new Date(at.getTime() + 1)),
    );
  });

  it('结算批次号 = S + yyyyMM + 3 位序号', () => {
    expect(buildSettleBatch('202609', 1)).toBe('S202609001');
    expect(buildSettleBatch('202609', 42)).toBe('S202609042');
  });

  it('临时单号全局唯一（并发插入靠它避开 booking_no 唯一索引冲突）', () => {
    const first = tempDocNo();
    const second = tempDocNo();
    expect(first.startsWith('T')).toBe(true);
    expect(second.startsWith('T')).toBe(true);
    expect(first).not.toBe(second);
  });
});
