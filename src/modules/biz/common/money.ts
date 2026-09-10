/**
 * 算价与金额口径（§5.7 / §5.8）。
 *
 * 约定：金额一律整数「分」，取整方向**向下**（少收不多少）；
 * 折扣率 / 抵扣上限用千分比整数，避免浮点误差。
 */

export type QuoteItem = {
  serviceItemId: number;
  name: string;
  durationMinutes: number;
  bufferMinutes: number;
  price: number;
};

export type QuoteInput = {
  items: QuoteItem[];
  /** 等级折扣率千分比，1000 = 不打折 */
  levelDiscountPermille: number;
  /** 顾客请求使用的积分数（服务端会复算上限） */
  pointsUsed?: number | undefined;
  /** 抵扣汇率：多少积分抵 1 元 */
  pointsDiscountPerYuan: number;
  /** 单笔积分抵扣上限（‰ 折后金额） */
  maxPointsPermille: number;
  /** 手动改价差额（分，可正可负） */
  adjustAmount?: number | undefined;
};

export type QuoteResult = {
  originalPrice: number;
  levelDiscountPermille: number;
  levelDiscountAmount: number;
  pointsDiscountAmount: number;
  /** 实际扣减的积分数（按汇率取整后回算） */
  pointsUsed: number;
  /** 该单最多可用积分（用于前端试算） */
  maxPoints: number;
  maxPointsDiscountAmount: number;
  adjustAmount: number;
  payableAmount: number;
  durationMinutes: number;
  bufferMinutes: number;
};

/** 千分比取整（向下），`permilleOf(10000, 950) = 9500` */
export function permilleOf(amount: number, permille: number): number {
  return Math.floor((amount * permille) / 1000);
}

/** 项目时长合计 D（不含缓冲） */
export function sumDuration(items: QuoteItem[]): number {
  return items.reduce((total, item) => total + item.durationMinutes, 0);
}

/** 本单缓冲 B = 各项目缓冲的最大值（§5.2 步骤 0） */
export function maxBuffer(items: QuoteItem[]): number {
  return items.reduce((max, item) => Math.max(max, item.bufferMinutes), 0);
}

/** 1 元 = 100 分；积分汇率以「多少积分抵 1 元」表达 */
export const CENTS_PER_YUAN = 100;

/** 积分 → 可抵金额（分），不足 1 元的零头不抵 */
export function pointsToCents(points: number, pointsPerYuan: number): number {
  const rate = normalizeRate(pointsPerYuan);
  return Math.floor(Math.max(points, 0) / rate) * CENTS_PER_YUAN;
}

/** 目标抵扣金额（分）→ 所需积分，向上取整到整元 */
export function centsToPoints(cents: number, pointsPerYuan: number): number {
  const rate = normalizeRate(pointsPerYuan);
  return Math.max(Math.ceil(Math.max(cents, 0) / CENTS_PER_YUAN), 0) * rate;
}

/**
 * 完整算价：原价 → 等级折扣 → 积分抵扣 → 手动改价 → 应付。
 *
 * `pointsUsed` 传入的是「顾客想用的积分」；服务端按
 * `min(积分可抵金额, 折后金额 × maxPointsPermille‰)` 复算（§5.7 / §15.3），
 * 超限不报错、按上限收敛（调用方需要区分时可对比返回值与入参）。
 */
export function quoteBooking(input: QuoteInput): QuoteResult {
  const originalPrice = input.items.reduce(
    (total, item) => total + item.price,
    0,
  );
  const permille = clampPermille(input.levelDiscountPermille);
  const levelDiscountAmount = Math.floor(
    (originalPrice * (1000 - permille)) / 1000,
  );

  const base4Points = Math.max(originalPrice - levelDiscountAmount, 0);
  const rate = normalizeRate(input.pointsDiscountPerYuan);
  const maxPointsDiscountAmount = permilleOf(
    base4Points,
    Math.max(input.maxPointsPermille, 0),
  );
  const maxPoints = centsToPoints(maxPointsDiscountAmount, rate);

  const requested = Math.max(Math.trunc(input.pointsUsed ?? 0), 0);
  const pointsUsed = Math.min(requested - (requested % rate), maxPoints);
  const pointsDiscountAmount = pointsToCents(pointsUsed, rate);

  const adjustAmount = Math.trunc(input.adjustAmount ?? 0);
  const payableAmount = Math.max(
    originalPrice - levelDiscountAmount - pointsDiscountAmount + adjustAmount,
    0,
  );

  return {
    originalPrice,
    levelDiscountPermille: permille,
    levelDiscountAmount,
    pointsDiscountAmount,
    pointsUsed,
    maxPoints,
    maxPointsDiscountAmount,
    adjustAmount,
    payableAmount,
    durationMinutes: sumDuration(input.items),
    bufferMinutes: maxBuffer(input.items),
  };
}

/** 下单应收：全款 = 应付；定金 = min(定金值, 应付)，未传则按比例（§17.2） */
export function calcDepositAmount(
  payableAmount: number,
  payMode: 'full' | 'deposit',
  depositAmount: number | undefined,
  depositPermille: number,
): number {
  if (payMode === 'full') return payableAmount;
  const requested =
    depositAmount === undefined
      ? permilleOf(payableAmount, clampPermille(depositPermille))
      : Math.trunc(depositAmount);
  return Math.min(Math.max(requested, 0), payableAmount);
}

/** 按金额与折扣率拆分储值扣减：先赠送后本金 / 按比例（§15.4） */
export function splitBalanceDeduction(
  amount: number,
  balancePrincipal: number,
  balanceBonus: number,
  mode: 'bonus_first' | 'proportional',
): { bonus: number; principal: number } {
  if (amount <= 0) return { bonus: 0, principal: 0 };
  if (mode === 'bonus_first') {
    const bonus = Math.min(amount, balanceBonus);
    return { bonus, principal: amount - bonus };
  }
  const total = balancePrincipal + balanceBonus;
  if (total <= 0) return { bonus: 0, principal: amount };
  const bonus = Math.min(
    balanceBonus,
    Math.floor((amount * balanceBonus) / total),
  );
  return { bonus, principal: amount - bonus };
}

/** 计算提成金额：比例 + 固定额（可同时存在，§20.3） */
export function commissionOf(
  baseAmount: number,
  permille: number,
  fixedAmount: number,
): number {
  return permilleOf(baseAmount, permille) + fixedAmount;
}

function clampPermille(permille: number): number {
  if (!Number.isFinite(permille)) return 1000;
  return Math.min(Math.max(Math.trunc(permille), 0), 1000);
}

function normalizeRate(pointsPerYuan: number): number {
  const rate = Math.trunc(pointsPerYuan);
  return Number.isFinite(rate) && rate > 0 ? rate : 1;
}
