import { describe, expect, it } from 'vitest';
import {
  calcDepositAmount,
  centsToPoints,
  commissionOf,
  maxBuffer,
  permilleOf,
  pointsToCents,
  quoteBooking,
  splitBalanceDeduction,
  sumDuration,
} from './money.js';

const item = (
  price: number,
  durationMinutes: number,
  bufferMinutes = 0,
  id = 1,
) => ({
  serviceItemId: id,
  name: `项目${id}`,
  durationMinutes,
  bufferMinutes,
  price,
});

const base = {
  pointsDiscountPerYuan: 100,
  maxPointsPermille: 300,
};

describe('money 算价（§5.7）', () => {
  it('无等级无积分：应付 = 原价', () => {
    const quote = quoteBooking({
      items: [item(10000, 60)],
      levelDiscountPermille: 1000,
      ...base,
    });
    expect(quote.originalPrice).toBe(10000);
    expect(quote.levelDiscountAmount).toBe(0);
    expect(quote.payableAmount).toBe(10000);
  });

  it('9.5 折 → 优惠 500、应付 9500（向下取整）', () => {
    const quote = quoteBooking({
      items: [item(10000, 60)],
      levelDiscountPermille: 950,
      ...base,
    });
    expect(quote.levelDiscountAmount).toBe(500);
    expect(quote.payableAmount).toBe(9500);
  });

  it('积分抵扣：1000 积分 = 10 元，受折后金额 30% 上限约束', () => {
    const quote = quoteBooking({
      items: [item(10000, 60)],
      levelDiscountPermille: 950,
      pointsUsed: 1000,
      ...base,
    });
    // 折后 9500 的 30% = 2850 分；1000 积分只能抵 1000 分，因此按 1000 计
    expect(quote.maxPointsDiscountAmount).toBe(2850);
    expect(quote.pointsDiscountAmount).toBe(1000);
    expect(quote.pointsUsed).toBe(1000);
    expect(quote.payableAmount).toBe(8500);
  });

  it('积分超过上限时按上限收敛（不会把单子抵成 0）', () => {
    const quote = quoteBooking({
      items: [item(10000, 60)],
      levelDiscountPermille: 1000,
      pointsUsed: 100000,
      ...base,
    });
    // 30% 上限 = 3000 分 = 30 元 = 3000 积分
    expect(quote.maxPoints).toBe(3000);
    expect(quote.pointsDiscountAmount).toBe(3000);
    expect(quote.pointsUsed).toBe(3000);
    expect(quote.payableAmount).toBe(7000);
  });

  it('改价可正可负，且应付不为负', () => {
    expect(
      quoteBooking({
        items: [item(10000, 60)],
        levelDiscountPermille: 1000,
        adjustAmount: -2000,
        ...base,
      }).payableAmount,
    ).toBe(8000);
    expect(
      quoteBooking({
        items: [item(10000, 60)],
        levelDiscountPermille: 1000,
        adjustAmount: -99999,
        ...base,
      }).payableAmount,
    ).toBe(0);
  });

  it('时长求和、缓冲取最大值（多项目）', () => {
    const items = [item(5000, 45, 15, 1), item(6000, 30, 10, 2)];
    const quote = quoteBooking({
      items,
      levelDiscountPermille: 1000,
      ...base,
    });
    expect(sumDuration(items)).toBe(75);
    expect(maxBuffer(items)).toBe(15);
    expect(quote.durationMinutes).toBe(75);
    expect(quote.bufferMinutes).toBe(15);
    expect(quote.originalPrice).toBe(11000);
  });

  it('千分比取整一律向下', () => {
    expect(permilleOf(10000, 950)).toBe(9500);
    expect(permilleOf(9999, 950)).toBe(9499);
    expect(permilleOf(1, 950)).toBe(0);
  });

  it('积分与金额换算', () => {
    expect(pointsToCents(1000, 100)).toBe(1000);
    expect(pointsToCents(150, 100)).toBe(100);
    expect(pointsToCents(99, 100)).toBe(0);
    expect(centsToPoints(1000, 100)).toBe(1000);
    expect(centsToPoints(1050, 100)).toBe(1100);
  });

  it('定金：全款 = 应付；定金按比例且不超过应付', () => {
    expect(calcDepositAmount(10000, 'full', undefined, 300)).toBe(10000);
    expect(calcDepositAmount(10000, 'deposit', undefined, 300)).toBe(3000);
    expect(calcDepositAmount(10000, 'deposit', 5000, 300)).toBe(5000);
    expect(calcDepositAmount(10000, 'deposit', 99999, 300)).toBe(10000);
    expect(calcDepositAmount(10000, 'deposit', 0, 300)).toBe(0);
  });

  it('储值扣减顺序：先赠送后本金 / 按比例', () => {
    expect(splitBalanceDeduction(3000, 5000, 2000, 'bonus_first')).toEqual({
      bonus: 2000,
      principal: 1000,
    });
    expect(splitBalanceDeduction(1000, 5000, 2000, 'bonus_first')).toEqual({
      bonus: 1000,
      principal: 0,
    });
    // 按比例：赠送占 2000/7000，扣 3500 → 送 1000、本 2500
    expect(splitBalanceDeduction(3500, 5000, 2000, 'proportional')).toEqual({
      bonus: 1000,
      principal: 2500,
    });
  });

  it('提成 = 比例（向下取整）+ 固定额', () => {
    expect(commissionOf(10000, 100, 0)).toBe(1000);
    expect(commissionOf(10000, 100, 500)).toBe(1500);
    expect(commissionOf(9999, 100, 0)).toBe(999);
  });
});

/**
 * 优惠券抵扣（本目标新增）。
 *
 * 口径：券在**等级折扣之后、积分抵扣之前**，且**与积分同一单二选一**。
 *
 * 数字都按「100 分抵 1 元」（`pointsDiscountPerYuan = 100`，即 1 分 = 1 分钱）算好：
 * 原价 10000、9.5 折 → 等级优惠 500、折后 9500。
 */
describe('quoteBooking 的券抵扣', () => {
  const items = [item(10000, 60)];
  const base = {
    items,
    levelDiscountPermille: 950,
    pointsDiscountPerYuan: 100,
    maxPointsPermille: 300,
  };

  it('不传券时行为与既有公式完全一致（回归）', () => {
    const quote = quoteBooking({ ...base, pointsUsed: 3000 });
    expect(quote.levelDiscountAmount).toBe(500);
    expect(quote.couponDiscountAmount).toBe(0);
    // 折后 9500 的 30% = 2850 分 → centsToPoints **向上取整到整元** = 2900 分
    expect(quote.pointsUsed).toBe(2900);
    expect(quote.payableAmount).toBe(6600);
  });

  it('券在等级折扣之后扣：9500 再减 2000 → 应付 7500', () => {
    const quote = quoteBooking({ ...base, couponDiscountAmount: 2000 });
    expect(quote.levelDiscountAmount).toBe(500);
    expect(quote.couponDiscountAmount).toBe(2000);
    expect(quote.payableAmount).toBe(7500);
  });

  it('券不能把单抵成负数：券大于折后金额时夹到折后金额', () => {
    const quote = quoteBooking({ ...base, couponDiscountAmount: 99999 });
    expect(quote.couponDiscountAmount).toBe(9500);
    expect(quote.payableAmount).toBe(0);
  });

  it('券与积分二选一：同时传时积分不参与抵扣（有券就不再抵积分）', () => {
    const quote = quoteBooking({
      ...base,
      couponDiscountAmount: 2000,
      pointsUsed: 3000,
    });
    expect(quote.pointsUsed).toBe(0);
    expect(quote.pointsDiscountAmount).toBe(0);
    expect(quote.payableAmount).toBe(7500);
  });

  it('积分上限按「券后金额」计算（券先于积分）', () => {
    const quote = quoteBooking({ ...base, couponDiscountAmount: 2000 });
    // 券后 7500 的 30% = 2250 分 → 向上取整到整元 = 2300 分
    expect(quote.maxPoints).toBe(2300);
  });

  it('负券额按 0 处理（不放大应付）', () => {
    const quote = quoteBooking({ ...base, couponDiscountAmount: -500 });
    expect(quote.couponDiscountAmount).toBe(0);
    expect(quote.payableAmount).toBe(9500);
  });
});