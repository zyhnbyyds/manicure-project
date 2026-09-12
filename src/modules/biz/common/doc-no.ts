import { DEFAULT_SHOP_TIMEZONE, shopDateOf } from './shop-time.js';

/** 单号前缀（§4.3：一律「主键回填」，不用「查当日最大号 +1」） */
export type DocPrefix =
  | 'B' // 预约单
  | 'P' // 支付单
  | 'R' // 退款单
  | 'A' // 应收单
  | 'C' // 会员卡
  | 'X' // 积分兑换
  | 'M'; // 会员号

/**
 * 生成单号：`前缀 + yyyyMMdd(店内本地日) + 主键补零 6 位`。
 *
 * 事务内 INSERT 拿到 `insertId` 后回填，天然唯一；配合列上的 UNIQUE 索引防并发重号。
 */
export function buildDocNo(
  prefix: DocPrefix,
  id: number,
  timeZone: string = DEFAULT_SHOP_TIMEZONE,
  now: Date = new Date(),
): string {
  const date = shopDateOf(now, timeZone).replace(/-/g, '');
  return `${prefix}${date}${String(id).padStart(6, '0')}`;
}

/** 对外交易号：`前缀 + 主键 + 时间戳后缀`，保证全局唯一且不可猜测 */
export function buildOutTradeNo(
  prefix: DocPrefix,
  id: number,
  now: Date = new Date(),
): string {
  return `${prefix}${String(id).padStart(6, '0')}${now.getTime().toString(36).toUpperCase()}`;
}

/**
 * 与主键**无关**的对外交易号（在线渠道在**事务外**下单时用）。
 *
 * 为什么不能用 `buildOutTradeNo(prefix, id)`：那个把主键内嵌在单号里，
 * 而主键要 INSERT 之后才知道 —— 在线渠道必须在事务外先下单（渠道下单是网络 IO，
 * 放进事务会持锁等最多 5 秒），那时还没有主键。
 *
 * 长度 ≤32（微信对 `out_trade_no` 的限制），随机后缀保证唯一。
 */
export function buildOutTradeNoByToken(prefix: DocPrefix = 'P'): string {
  return (
    `${prefix}${Date.now().toString(36).toUpperCase()}` +
    `${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`
  );
}

/** 结算批次号：`S{yyyyMM}{seq}`，seq 由调用方按库内最大批次自增 */
export function buildSettleBatch(period: string, sequence: number): string {
  return `S${period}${String(sequence).padStart(3, '0')}`;
}

/**
 * 插入前的临时单号。
 *
 * `booking_no` 是 NOT NULL + UNIQUE，而正式单号要用主键回填（INSERT 之后才知道 id）。
 * 若插入时统一填 `''`，两个并发事务会在唯一索引上互相阻塞并报 1062。
 * 因此先用一个全局唯一的临时值占位，同一事务内立刻回填正式单号
 * （未提交的行在 REPEATABLE READ 下读不到，外部永远看不到这个临时值）。
 */
export function tempDocNo(): string {
  // 用 `globalThis.crypto` 而不是 `node:crypto`：`bun test` 不做文件级 mock 隔离，
  // 任意一个 spec 里的 `vi.mock('node:crypto')` 都会全局替换掉它，
  // 临时单号退化成固定值后，并发插入会在 booking_no 唯一索引上互相阻塞。
  // （`payments.service` / `refunds.service` 出于同样原因也用的是 globalThis.crypto）
  return `T${Date.now().toString(36)}${globalThis.crypto.randomUUID().slice(0, 8)}`;
}
