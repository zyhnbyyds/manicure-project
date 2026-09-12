import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { BookingsService } from './bookings.service.js';

type Row = Record<string, unknown>;

/** drizzle 链式调用桩：任何中间方法都返回同一个 thenable，最后 await 出结果 */
function chainFor(result: unknown) {
  const node = Promise.resolve(result) as unknown as Record<string, unknown>;
  for (const key of ['from', 'where', 'orderBy', 'limit', 'offset', 'for'])
    node[key] = () => node;
  return node;
}

function createHarness(
  options: {
    selectResults?: unknown[][];
    affectedRows?: number;
  } = {},
) {
  const queue = [...(options.selectResults ?? [])];
  const select = vi.fn(() => chainFor(queue.shift() ?? []));
  const updateWhere = vi
    .fn()
    .mockResolvedValue([{ affectedRows: options.affectedRows ?? 1 }]);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  const transaction = vi.fn((fn: (tx: unknown) => Promise<unknown>) =>
    fn({ select, update }),
  );
  const db = { select, update, transaction };

  const onBookingCompleted = vi.fn().mockResolvedValue(undefined);
  const accrueForBooking = vi.fn().mockResolvedValue({ records: 1, amount: 0 });
  const reverseForBooking = vi.fn().mockResolvedValue({ reversed: 0 });
  const send = vi.fn().mockResolvedValue({ sent: 0, failed: 0, logIds: [] });

  const service = new BookingsService(
    { db } as never,
    {
      booking: vi.fn().mockResolvedValue({ timezone: 'Asia/Shanghai' }),
    } as never,
    {} as never, // slots
    { onBookingCompleted } as never, // customers
    {} as never, // staffs
    {} as never, // serviceItems
    {} as never, // members
    {} as never, // payments
    {} as never, // credit
    {} as never, // settlement
    {} as never, // refunds
    { send } as never, // notices
    { accrueForBooking, reverseForBooking } as never, // commissions
    {} as never, // coupons
  );
  return {
    service,
    select,
    update,
    updateSet,
    transaction,
    onBookingCompleted,
    accrueForBooking,
    reverseForBooking,
  };
}

const booking = (overrides: Row = {}): Row => ({
  id: 5,
  staffId: 7,
  customerId: 9,
  customerName: '小美',
  status: 'confirmed',
  startAt: new Date('2026-09-10T02:00:00.000Z'),
  ...overrides,
});

const item = (overrides: Row = {}): Row => ({
  id: 11,
  bookingId: 5,
  serviceItemId: 3,
  name: '法式美甲',
  durationMinutes: 60,
  price: 12800,
  sort: 0,
  ...overrides,
});

describe('BookingsService —— app 域端口（S3 读 / S4 写）', () => {
  describe('listByStaff / listByCustomer', () => {
    it('美甲师列表挂上项目明细快照，一次查询补齐（不 N+1）', async () => {
      const h = createHarness({
        selectResults: [[booking({ id: 5 }), booking({ id: 6 })], [item()]],
      });
      const result = await h.service.listByStaff(7, 1, 20, {});
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
      expect(result.items).toHaveLength(2);
      expect(h.select).toHaveBeenCalledTimes(2);
      expect(result.items[0]!.items).toEqual([item()]);
      expect(result.items[1]!.items).toEqual([]);
    });

    it('顾客「我的预约」同样带明细', async () => {
      const h = createHarness({ selectResults: [[booking()], [item()]] });
      const result = await h.service.listByCustomer(9, 1, 20);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.items).toHaveLength(1);
    });

    it('空结果不查明细（避免 IN () 的无效查询）', async () => {
      const h = createHarness({ selectResults: [[]] });
      await expect(h.service.listByStaff(7, 1, 20, {})).resolves.toEqual({
        items: [],
        page: 1,
        pageSize: 20,
      });
      expect(h.select).toHaveBeenCalledTimes(1);
    });
  });

  describe('arriveForStaff（S4）', () => {
    it('预约不存在 → 404', async () => {
      const h = createHarness({ selectResults: [[]] });
      await expect(h.service.arriveForStaff(404, 7)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('别人的单 → 403，且不发任何 update', async () => {
      const h = createHarness({ selectResults: [[booking({ staffId: 8 })]] });
      await expect(h.service.arriveForStaff(5, 7)).rejects.toThrow(
        ForbiddenException,
      );
      expect(h.update).not.toHaveBeenCalled();
    });

    it('本人的单 → 置 arrived，updatedBy 记 null（小程序端没有 sys_user）', async () => {
      const h = createHarness({ selectResults: [[booking()]] });
      await expect(h.service.arriveForStaff(5, 7, null)).resolves.toEqual({
        changed: true,
      });
      expect(h.updateSet).toHaveBeenCalledWith({
        status: 'arrived',
        updatedBy: null,
        arrivedAt: expect.any(Date),
      });
    });

    it('重复点击 → changed:false，不再发 update（幂等）', async () => {
      const h = createHarness({
        selectResults: [[booking({ status: 'arrived' })]],
      });
      await expect(h.service.arriveForStaff(5, 7)).resolves.toEqual({
        changed: false,
      });
      expect(h.update).not.toHaveBeenCalled();
    });
  });

  describe('completeForStaff（S4）', () => {
    it('早于 start_at → 400，且不进事务（防提前刷提成，§12.4-3）', async () => {
      const h = createHarness({
        selectResults: [
          [booking({ startAt: new Date('2099-01-01T00:00:00.000Z') })],
        ],
      });
      await expect(h.service.completeForStaff(5, 7)).rejects.toThrow(
        BadRequestException,
      );
      expect(h.transaction).not.toHaveBeenCalled();
      expect(h.accrueForBooking).not.toHaveBeenCalled();
    });

    it('别人的单 → 403，且不进事务', async () => {
      const h = createHarness({ selectResults: [[booking({ staffId: 8 })]] });
      await expect(h.service.completeForStaff(5, 7)).rejects.toThrow(
        ForbiddenException,
      );
      expect(h.transaction).not.toHaveBeenCalled();
    });

    it('本人的单 → 走既有完成动作：累加到店次数 + 计提提成', async () => {
      // 第 1 次 select = 归属校验，第 2 次 = 事务内 lockBooking
      const h = createHarness({
        selectResults: [
          [booking({ status: 'arrived' })],
          [booking({ status: 'arrived' })],
        ],
      });
      await expect(h.service.completeForStaff(5, 7, null)).resolves.toEqual({
        changed: true,
        warning: '尾款未结清，请到收银台催收',
      });
      expect(h.onBookingCompleted).toHaveBeenCalledWith(expect.anything(), 9);
      expect(h.accrueForBooking).toHaveBeenCalledWith(
        expect.anything(),
        5,
        null,
      );
    });

    it('重复点击 → changed:false，计提不会二次发生（幂等）', async () => {
      const h = createHarness({
        selectResults: [[booking({ status: 'completed' })]],
      });
      await expect(h.service.completeForStaff(5, 7)).resolves.toEqual({
        changed: false,
      });
      expect(h.transaction).not.toHaveBeenCalled();
      expect(h.accrueForBooking).not.toHaveBeenCalled();
    });

    it('并发下别人已改状态 → affectedRows=0 闸门生效，changed:false', async () => {
      const h = createHarness({
        selectResults: [
          [booking({ status: 'arrived' })],
          [booking({ status: 'arrived' })],
        ],
        affectedRows: 0,
      });
      await expect(h.service.completeForStaff(5, 7)).resolves.toEqual({
        changed: false,
      });
      expect(h.accrueForBooking).not.toHaveBeenCalled();
      expect(h.onBookingCompleted).not.toHaveBeenCalled();
    });

    describe('phoneForStaff（D11 按需取真号）', () => {
      it('本人的单 → 返回明文手机号（拨号要真号，脱敏的拨不出去）', async () => {
        const h = createHarness({
          selectResults: [[booking()], [{ customerPhone: '13911112222' }]],
        });
        await expect(h.service.phoneForStaff(5, 7)).resolves.toEqual({
          phone: '13911112222',
        });
        expect(h.update).not.toHaveBeenCalled();
      });

      it('顾客没留电话 → null，不臆造', async () => {
        const h = createHarness({
          selectResults: [[booking()], [{ customerPhone: null }]],
        });
        await expect(h.service.phoneForStaff(5, 7)).resolves.toEqual({
          phone: null,
        });
      });

      it('别人的单 → 403，一条号码都不给', async () => {
        const h = createHarness({ selectResults: [[booking({ staffId: 8 })]] });
        await expect(h.service.phoneForStaff(5, 7)).rejects.toThrow(
          ForbiddenException,
        );
        // 归属校验那次之后不该再有第二次查询
        expect(h.select).toHaveBeenCalledTimes(1);
      });

      it('预约不存在 → 404', async () => {
        const h = createHarness({ selectResults: [[]] });
        await expect(h.service.phoneForStaff(404, 7)).rejects.toThrow(
          NotFoundException,
        );
      });
    });

    describe('cancelForCustomer（A10 自助取消）', () => {
      it('缺 reason → 400，且不发任何 update', async () => {
        const h = createHarness();
        await expect(h.service.cancelForCustomer(5, 9, '')).rejects.toThrow(
          BadRequestException,
        );
        expect(h.update).not.toHaveBeenCalled();
      });

      it('别人的单 → 403，且不发 update', async () => {
        const h = createHarness({
          selectResults: [[booking({ customerId: 8 })]],
        });
        await expect(
          h.service.cancelForCustomer(5, 9, '临时有事'),
        ).rejects.toThrow(ForbiddenException);
        expect(h.update).not.toHaveBeenCalled();
      });

      it('预约不存在 → 404', async () => {
        const h = createHarness({ selectResults: [[]] });
        await expect(
          h.service.cancelForCustomer(404, 9, '临时有事'),
        ).rejects.toThrow(NotFoundException);
      });

      it('本人的单 → 走既有取消动作（transition），有实收时给退款提示', async () => {
        const h = createHarness({
          selectResults: [[booking({ customerId: 9, paidAmount: 5000 })]],
        });
        await expect(
          h.service.cancelForCustomer(5, 9, '临时有事'),
        ).resolves.toEqual({
          changed: true,
          warning: '该预约有实收，请到「退款审批」发起退款（系统不会自动退）',
        });
        expect(h.updateSet).toHaveBeenCalledWith({
          status: 'cancelled',
          updatedBy: null,
          cancelReason: '临时有事',
          cancelledAt: expect.any(Date),
        });
      });
    });
  });
});
