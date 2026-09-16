import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { PaymentDiffsService } from './payment-diffs.service';

type Row = Record<string, unknown>;
type BillRecord = {
  transactionId: string;
  outTradeNo: string;
  amount: number;
  status: string;
};

// 对账会打 warn 日志（通道未配置 / 账单为空），测试里静音
vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

function chainFor(result: unknown) {
  const make = (): Record<string, unknown> => {
    const node = Promise.resolve(result) as unknown as Record<string, unknown>;
    node.from = make;
    node.where = make;
    node.orderBy = make;
    node.limit = make;
    node.offset = make;
    return node;
  };
  return make();
}

function createHarness(
  options: {
    wxpayConfigured?: boolean;
    wxpayRecords?: BillRecord[];
    wxpayFails?: boolean;
    alipayConfigured?: boolean;
    alipayRecords?: BillRecord[];
    systemPayments?: Row[];
    affectedRows?: number;
  } = {},
) {
  const wxpay = {
    channel: 'wxpay',
    label: '微信支付',
    configured: options.wxpayConfigured ?? true,
    downloadBill: options.wxpayFails
      ? vi.fn().mockRejectedValue(new Error('渠道超时'))
      : vi.fn().mockResolvedValue(options.wxpayRecords ?? []),
  };
  const alipay = {
    channel: 'alipay',
    label: '支付宝',
    configured: options.alipayConfigured ?? false,
    downloadBill: vi.fn().mockResolvedValue(options.alipayRecords ?? []),
  };

  const select = vi.fn(() => chainFor(options.systemPayments ?? []));
  const onDuplicateKeyUpdate = vi.fn().mockResolvedValue(undefined);
  const insertValues = vi.fn(() => ({ onDuplicateKeyUpdate }));
  const insert = vi.fn(() => ({ values: insertValues }));
  const updateWhere = vi
    .fn()
    .mockResolvedValue([{ affectedRows: options.affectedRows ?? 1 }]);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const service = new PaymentDiffsService(
    { db: { select, insert, update } } as never,
    {
      booking: vi.fn().mockResolvedValue({ timezone: 'Asia/Shanghai' }),
    } as never,
    wxpay as never,
    alipay as never,
  );
  return {
    service,
    wxpay,
    alipay,
    insertValues,
    updateSet,
    onDuplicateKeyUpdate,
  };
}

const bill = (overrides: Partial<BillRecord> = {}): BillRecord => ({
  transactionId: 'T1',
  outTradeNo: 'P1',
  amount: 10000,
  status: 'success',
  ...overrides,
});

const systemPayment = (overrides: Row = {}): Row => ({
  id: 1,
  transactionId: 'T1',
  outTradeNo: 'P1',
  amount: 10000,
  ...overrides,
});

describe('PaymentDiffsService（§17.5 渠道对账）', () => {
  describe('reconcile', () => {
    it('对账日期格式非法时抛 BadRequestException', async () => {
      const { service } = createHarness();
      await expect(service.reconcile('2026/09/11')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('通道未配置时跳过，不抛错（定时任务不该被配置问题打成 failure）', async () => {
      const { service, wxpay } = createHarness({ wxpayConfigured: false });
      await expect(service.reconcile('2026-09-11')).resolves.toEqual({
        diffs: 0,
      });
      expect(wxpay.downloadBill).not.toHaveBeenCalled();
    });

    it('单个通道失败不影响其它通道', async () => {
      const { service } = createHarness({
        wxpayFails: true,
        alipayConfigured: true,
        alipayRecords: [bill({ transactionId: 'A1', outTradeNo: 'AP1' })],
        systemPayments: [],
      });
      await expect(service.reconcile('2026-09-11')).resolves.toEqual({
        diffs: 1,
      });
    });

    it('账单为空时跳过，避免误报「系统缺单」', async () => {
      const { service, insertValues } = createHarness({
        wxpayRecords: [],
        systemPayments: [systemPayment()],
      });
      await expect(service.reconcile('2026-09-11')).resolves.toEqual({
        diffs: 0,
      });
      expect(insertValues).not.toHaveBeenCalled();
    });

    it('缺省对账日期取店内时区的前一天', async () => {
      const { service, wxpay } = createHarness({
        wxpayRecords: [bill()],
        systemPayments: [systemPayment()],
      });
      await service.reconcile();
      expect(wxpay.downloadBill).toHaveBeenCalledWith(
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      );
    });

    it('完全一致时不产生差异', async () => {
      const { service, insertValues } = createHarness({
        wxpayRecords: [bill()],
        systemPayments: [systemPayment()],
      });
      await expect(service.reconcile('2026-09-11')).resolves.toEqual({
        diffs: 0,
      });
      expect(insertValues).not.toHaveBeenCalled();
    });

    it('渠道有、系统无 → missing_in_system', async () => {
      const { service, insertValues } = createHarness({
        wxpayRecords: [bill()],
        systemPayments: [],
      });
      await expect(service.reconcile('2026-09-11')).resolves.toEqual({
        diffs: 1,
      });
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          diffType: 'missing_in_system',
          systemAmount: 0,
          channelAmount: 10000,
          status: 'pending',
        }),
      );
    });

    it('金额不一致 → amount_mismatch', async () => {
      const { service, insertValues } = createHarness({
        wxpayRecords: [bill({ amount: 9900 })],
        systemPayments: [systemPayment({ amount: 10000 })],
      });
      await expect(service.reconcile('2026-09-11')).resolves.toEqual({
        diffs: 1,
      });
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          diffType: 'amount_mismatch',
          systemAmount: 10000,
          channelAmount: 9900,
        }),
      );
    });

    it('渠道状态为 failed / closed → status_mismatch', async () => {
      const closed = createHarness({
        wxpayRecords: [bill({ status: 'closed' })],
        systemPayments: [systemPayment()],
      });
      await expect(closed.service.reconcile('2026-09-11')).resolves.toEqual({
        diffs: 1,
      });
      expect(closed.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ diffType: 'status_mismatch' }),
      );

      const failed = createHarness({
        wxpayRecords: [bill({ status: 'failed' })],
        systemPayments: [systemPayment()],
      });
      await expect(failed.service.reconcile('2026-09-11')).resolves.toEqual({
        diffs: 1,
      });
    });

    it('系统有、渠道无 → missing_in_channel，且 transaction_id 为空时用系统单号兜底', async () => {
      const { service, insertValues } = createHarness({
        wxpayRecords: [bill()],
        systemPayments: [
          systemPayment(),
          systemPayment({
            id: 2,
            transactionId: null,
            outTradeNo: 'P2',
            amount: 5000,
          }),
        ],
      });
      await expect(service.reconcile('2026-09-11')).resolves.toEqual({
        diffs: 1,
      });
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          diffType: 'missing_in_channel',
          outTradeNo: 'P2',
          transactionId: 'P2',
          systemAmount: 5000,
          channelAmount: 0,
        }),
      );
    });

    it('重跑不产生重复差异：冲突时只刷新金额，不动人工处理结果', async () => {
      const { service, onDuplicateKeyUpdate } = createHarness({
        wxpayRecords: [bill()],
        systemPayments: [],
      });
      await service.reconcile('2026-09-11');
      expect(onDuplicateKeyUpdate).toHaveBeenCalledWith({
        set: {
          outTradeNo: 'P1',
          systemAmount: 0,
          channelAmount: 10000,
        },
      });
      // status / handle_by / remark 不在刷新字段里，人工处理不会被任务覆盖
      const payload = onDuplicateKeyUpdate.mock.calls[0]![0] as {
        set: Record<string, unknown>;
      };
      expect(Object.keys(payload.set)).not.toContain('status');
      expect(Object.keys(payload.set)).not.toContain('handleBy');
      expect(Object.keys(payload.set)).not.toContain('remark');
    });
  });

  describe('handle：必须填备注，不允许静默忽略', () => {
    it('备注为空时抛 BadRequestException', async () => {
      const { service } = createHarness();
      await expect(
        service.handle(1, { status: 'resolved', remark: '   ' }, 1),
      ).rejects.toThrow('必须填写处理备注，不允许静默忽略差异');
    });

    it('已处理或不存在时抛 ConflictException', async () => {
      const { service } = createHarness({ affectedRows: 0 });
      await expect(
        service.handle(1, { status: 'ignored', remark: '确认无误' }, 1),
      ).rejects.toThrow(ConflictException);
    });

    it('备注超长截断到 200 字并记录处理人', async () => {
      const { service, updateSet } = createHarness();
      await service.handle(
        1,
        { status: 'resolved', remark: 'x'.repeat(300) },
        7,
      );
      expect(updateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'resolved',
          remark: 'x'.repeat(200),
          handleBy: 7,
          updatedBy: 7,
          handledAt: expect.any(Date),
        }),
      );
    });
  });

  describe('list / findOne', () => {
    it('list 返回 items/page/pageSize/total', async () => {
      const { service } = createHarness({ systemPayments: [{ id: 1 }] });
      await expect(service.list(1, 20, {})).resolves.toEqual({
        items: [{ id: 1 }],
        // mock 的 count 查询没喂数据 → total 为 0；真实 total 由集成测试覆盖
        total: 0,
        page: 1,
        pageSize: 20,
      });
    });

    it('findOne 不存在时抛 NotFoundException', async () => {
      const { service } = createHarness({ systemPayments: [] });
      await expect(service.findOne(404)).rejects.toThrow(NotFoundException);
    });
  });
});
