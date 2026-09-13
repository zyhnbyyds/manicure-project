import { describe, expect, it, vi } from 'vitest';
import { BookingSettlementService } from './booking-settlement.service.js';

type Row = Record<string, unknown>;

/**
 * `recalc` 内部固定发三条查询（预约 → 支付单 → 退款单），
 * 因此按调用顺序依次喂结果；`update().set()` 的参数用来断言落库内容。
 */
function mockTx(options: {
  booking?: Row | null;
  payments?: Row[];
  refunds?: Row[];
}) {
  const bookingRows = options.booking === null ? [] : [options.booking ?? {}];
  const select = vi
    .fn()
    .mockReturnValueOnce({
      from: () => ({
        where: () => ({ limit: vi.fn().mockResolvedValue(bookingRows) }),
      }),
    })
    .mockReturnValueOnce({
      from: () => ({
        where: () => Promise.resolve(options.payments ?? []),
      }),
    })
    .mockReturnValueOnce({
      from: () => ({
        where: () => Promise.resolve(options.refunds ?? []),
      }),
    });
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });
  return { tx: { select, update } as never, set };
}

const service = new BookingSettlementService();

const booking = (overrides: Row = {}): Row => ({
  id: 1,
  payableAmount: 10000,
  creditAccountId: null,
  settledAt: null,
  ...overrides,
});

describe('BookingSettlementService.recalc（§15.7 不变量 4：资金字段唯一重算入口）', () => {
  it('未收未退：due = 应付、状态 unpaid、结算时间为空', async () => {
    const { tx, set } = mockTx({ booking: booking() });
    const result = await service.recalc(tx, 1);
    expect(result).toMatchObject({
      paidAmount: 0,
      refundAmount: 0,
      dueAmount: 10000,
      payStatus: 'unpaid',
      channelSummary: null,
      settledAt: null,
    });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ payStatus: 'unpaid', dueAmount: 10000 }),
    );
  });

  it('全额收款：due = 0、状态 paid、写入结算时间', async () => {
    const { tx } = mockTx({
      booking: booking(),
      payments: [{ channel: 'cash', receivedAmount: 10000 }],
    });
    const result = await service.recalc(tx, 1);
    expect(result.paidAmount).toBe(10000);
    expect(result.dueAmount).toBe(0);
    expect(result.payStatus).toBe('paid');
    expect(result.settledAt).toBeInstanceOf(Date);
  });

  it('部分收款：状态 partial，due 为差额', async () => {
    const { tx } = mockTx({
      booking: booking(),
      payments: [{ channel: 'cash', receivedAmount: 3000 }],
    });
    expect(await service.recalc(tx, 1)).toMatchObject({
      paidAmount: 3000,
      dueAmount: 7000,
      payStatus: 'partial',
    });
  });

  it('挂在挂账主体上时 credit 优先于 partial（收银台挂账队列按此状态筛选）', async () => {
    const { tx } = mockTx({
      booking: booking({ creditAccountId: 9 }),
      payments: [{ channel: 'cash', receivedAmount: 3000 }],
    });
    expect((await service.recalc(tx, 1)).payStatus).toBe('credit');
  });

  it('退款只体现在 refund_amount，不回冲毛收入 paid_amount', async () => {
    const { tx } = mockTx({
      booking: booking(),
      payments: [
        { channel: 'balance', receivedAmount: 6000 },
        { channel: 'cash', receivedAmount: 4000 },
      ],
      refunds: [{ actualAmount: 2000 }],
    });
    const result = await service.recalc(tx, 1);
    expect(result.paidAmount).toBe(10000);
    expect(result.refundAmount).toBe(2000);
    expect(result.dueAmount).toBe(0);
    expect(result.payStatus).toBe('paid');
  });

  it('退款收口（退款 ≥ 已收）：状态 refunded 且清空结算时间', async () => {
    const { tx } = mockTx({
      booking: booking({ settledAt: new Date('2026-09-01T00:00:00.000Z') }),
      payments: [{ channel: 'cash', receivedAmount: 10000 }],
      refunds: [{ actualAmount: 10000 }],
    });
    const result = await service.recalc(tx, 1);
    expect(result.payStatus).toBe('refunded');
    expect(result.refundAmount).toBe(10000);
    expect(result.settledAt).toBeNull();
  });

  it('多笔退款累加', async () => {
    const { tx } = mockTx({
      booking: booking(),
      payments: [{ channel: 'cash', receivedAmount: 10000 }],
      refunds: [{ actualAmount: 1500 }, { actualAmount: 2500 }],
    });
    expect((await service.recalc(tx, 1)).refundAmount).toBe(4000);
  });

  it('应付为 0（次卡核销）：无收款也算 paid', async () => {
    const { tx } = mockTx({ booking: booking({ payableAmount: 0 }) });
    const result = await service.recalc(tx, 1);
    expect(result.payStatus).toBe('paid');
    expect(result.dueAmount).toBe(0);
  });

  it('已结算的单据保留原结算时间（重算幂等）', async () => {
    const settledAt = new Date('2026-09-01T00:00:00.000Z');
    const { tx } = mockTx({
      booking: booking({ settledAt }),
      payments: [{ channel: 'cash', receivedAmount: 10000 }],
    });
    expect((await service.recalc(tx, 1)).settledAt).toBe(settledAt);
  });

  it('渠道汇总去重后按字母序拼接（如 balance,cash）', async () => {
    const { tx } = mockTx({
      booking: booking(),
      payments: [
        { channel: 'cash', receivedAmount: 1000 },
        { channel: 'balance', receivedAmount: 1000 },
        { channel: 'cash', receivedAmount: 1000 },
      ],
    });
    expect((await service.recalc(tx, 1)).channelSummary).toBe('balance,cash');
  });

  it('预约不存在时抛错，不静默写脏数据', async () => {
    const { tx } = mockTx({ booking: null });
    await expect(service.recalc(tx, 404)).rejects.toThrow('预约不存在：404');
  });

  it('落库字段与返回结果完全一致（避免列表/收银台/报表口径分叉）', async () => {
    const { tx, set } = mockTx({
      booking: booking(),
      payments: [{ channel: 'wechat', receivedAmount: 10000 }],
    });
    const result = await service.recalc(tx, 1);
    expect(set).toHaveBeenCalledWith({
      paidAmount: result.paidAmount,
      refundAmount: result.refundAmount,
      dueAmount: result.dueAmount,
      payStatus: result.payStatus,
      payChannelSummary: result.channelSummary,
      settledAt: result.settledAt,
    });
  });
});
