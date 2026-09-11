import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { maskPhone } from '../dto/app-staff-workbench.vo.js';
import { AppStaffWorkbenchService } from './app-staff-workbench.service.js';

type Row = Record<string, unknown>;

/**
 * §12.6 字段集合铁律：**不含成本、不含内部字段**。
 * 这里逐个点名，谁将来把 `originalPrice` / `adjustAmount` 漏出去，用例立刻红。
 */
const FORBIDDEN_BOOKING_KEYS = [
  'customerId',
  'staffId',
  'originalPrice',
  'levelDiscountAmount',
  'levelDiscountPermille',
  'pointsDiscountAmount',
  'adjustAmount',
  'adjustReason',
  'depositAmount',
  'payChannelSummary',
  'settledAt',
  'createdBy',
  'updatedBy',
  'deletedAt',
];

const staffRow = (overrides: Row = {}): Row => ({
  id: 7,
  nickname: 'Amy',
  avatar: 'https://cdn/a.png',
  phone: '13800000000',
  bio: '八年美甲师',
  status: 'active',
  ...overrides,
});

const bookingRow = (overrides: Row = {}): Row => ({
  id: 11,
  bookingNo: 'B20260911001',
  customerName: '张三',
  customerPhone: '13911112222',
  startAt: new Date('2026-09-11T02:00:00.000Z'),
  endAt: new Date('2026-09-11T03:00:00.000Z'),
  status: 'confirmed',
  payStatus: 'unpaid',
  payableAmount: 19900,
  paidAmount: 0,
  dueAmount: 19900,
  remark: '指甲薄，轻一点',
  // 故意塞进内部字段：断言会证明它们**一个都没漏出去**
  customerId: 88,
  staffId: 7,
  originalPrice: 25800,
  adjustAmount: -1000,
  adjustReason: '老客',
  items: [
    {
      id: 501,
      bookingId: 11,
      serviceItemId: 5,
      name: '法式美甲',
      price: 19900,
      durationMinutes: 60,
      cost: 3000,
    },
  ],
  ...overrides,
});

const commissionRow = (overrides: Row = {}): Row => ({
  id: 900,
  bookingId: 11,
  bookingNo: 'B20260911001',
  serviceItemName: '法式美甲',
  baseAmount: 19900,
  amount: 1990,
  period: '202609',
  status: 'accrued',
  settledAt: null,
  ...overrides,
});

/** 每个端口方法的入参都录一份：用来断言「staffId 一定是本人」 */
type PortCalls = {
  staffFindOne: number[];
  allowedServiceItemIds: number[];
  listByStaff: Row[];
  performanceByStaff: Row[];
  resolveShifts: Row[];
  listOverrides: Row[];
  commissionListByStaff: Row[];
  summarizeByStaff: Row[];
  reviewListByStaff: Row[];
  averageScore: number[];
};

function createHarness() {
  const calls: PortCalls = {
    staffFindOne: [],
    allowedServiceItemIds: [],
    listByStaff: [],
    performanceByStaff: [],
    resolveShifts: [],
    listOverrides: [],
    commissionListByStaff: [],
    summarizeByStaff: [],
    reviewListByStaff: [],
    averageScore: [],
  };

  const staffPort = {
    findOne: vi.fn(async (id: number) => {
      calls.staffFindOne.push(id);
      return staffRow({ id });
    }),
    allowedServiceItemIds: vi.fn(async (staffId: number) => {
      calls.allowedServiceItemIds.push(staffId);
      return [5, 6];
    }),
  };
  const bookingPort = {
    listByStaff: vi.fn(
      async (staffId: number, page: number, pageSize: number, filter: Row) => {
        calls.listByStaff.push({ staffId, page, pageSize, filter });
        return {
          page,
          pageSize,
          items: [bookingRow(), bookingRow({ id: 12, customerPhone: null })],
        };
      },
    ),
    performanceByStaff: vi.fn(async (staffId: number, period?: string) => {
      calls.performanceByStaff.push({ staffId, period });
      return {
        period: period ?? '202609',
        completedCount: 12,
        paidAmount: 238800,
      };
    }),
  };
  const schedulePort = {
    resolveShifts: vi.fn(async (staffId: number, date: string) => {
      calls.resolveShifts.push({ staffId, date });
      return {
        off: false,
        segments: [{ startTime: '10:00', endTime: '19:00' }],
      };
    }),
    listOverrides: vi.fn(async (staffId: number, filter: Row) => {
      calls.listOverrides.push({ staffId, filter });
      return [
        {
          id: 31,
          date: '2026-09-11',
          type: 'custom',
          startTime: '11:00',
          endTime: '18:00',
          reason: '培训',
        },
      ];
    }),
  };
  const commissionPort = {
    listByStaff: vi.fn(async (staffId: number, period?: string) => {
      calls.commissionListByStaff.push({ staffId, period });
      return [
        commissionRow(),
        commissionRow({
          id: 901,
          status: 'settled',
          settledAt: new Date('2026-09-12T02:00:00.000Z'),
        }),
      ];
    }),
    summarizeByStaff: vi.fn(async (staffId: number, period?: string) => {
      calls.summarizeByStaff.push({ staffId, period });
      return { accrued: 1990, settled: 3980, reversed: 500 };
    }),
  };
  const reviewPort = {
    listByStaff: vi.fn(
      async (staffId: number, page: number, pageSize: number) => {
        calls.reviewListByStaff.push({ staffId, page, pageSize });
        return {
          page,
          pageSize,
          items: [
            {
              id: 71,
              bookingId: 11,
              bookingNo: 'B20260911001',
              score: 5,
              content: '很细心',
              reply: '谢谢～',
              createdAt: new Date('2026-09-11T10:00:00.000Z'),
            },
          ],
        };
      },
    ),
    averageScore: vi.fn(async (staffId: number) => {
      calls.averageScore.push(staffId);
      return { count: 1, average: 4.8 };
    }),
  };

  const service = new AppStaffWorkbenchService(
    staffPort as never,
    bookingPort as never,
    schedulePort as never,
    commissionPort as never,
    reviewPort as never,
  );
  return {
    service,
    calls,
    staffPort,
    bookingPort,
    schedulePort,
    commissionPort,
    reviewPort,
  };
}

describe('AppStaffWorkbenchService（施工单 §12.5 S3 只读面）', () => {
  describe('maskPhone（D11）', () => {
    it('11 位手机号 → 138****0000', () => {
      expect(maskPhone('13800000000')).toBe('138****0000');
    });

    it('空值 / null → null（前端显示「未留电话」而不是 ****）', () => {
      expect(maskPhone(null)).toBeNull();
      expect(maskPhone(undefined)).toBeNull();
      expect(maskPhone('')).toBeNull();
    });

    it('不超过 7 位的号码原样返回（掩盖之后反而全是星号，没意义）', () => {
      expect(maskPhone('12345')).toBe('12345');
      expect(maskPhone('1234567')).toBe('1234567');
    });
  });

  describe('me', () => {
    it('只查 guard 给到的本人 staffId，不查别的美甲师', async () => {
      const h = createHarness();
      await h.service.me(7);
      expect(h.calls.staffFindOne).toEqual([7]);
      expect(h.calls.allowedServiceItemIds).toEqual([7]);
    });

    it('自己的手机号也脱敏，字段集合恰好 7 项', async () => {
      const h = createHarness();
      const me = await h.service.me(7);
      expect(me).toEqual({
        staffId: 7,
        nickname: 'Amy',
        avatar: 'https://cdn/a.png',
        phone: '138****0000',
        bio: '八年美甲师',
        staffStatus: 'active',
        allowedServiceItemIds: [5, 6],
      });
      expect(Object.keys(me).sort()).toEqual(
        [
          'allowedServiceItemIds',
          'avatar',
          'bio',
          'nickname',
          'phone',
          'staffId',
          'staffStatus',
        ].sort(),
      );
    });
  });

  describe('bookings', () => {
    it('staffId 硬限定 + 分页与过滤条件原样转发', async () => {
      const h = createHarness();
      await h.service.bookings(7, 2, 10, {
        date: '2026-09-11',
        status: 'arrived',
      });
      expect(h.calls.listByStaff).toEqual([
        {
          staffId: 7,
          page: 2,
          pageSize: 10,
          filter: { date: '2026-09-11', status: 'arrived' },
        },
      ]);
    });

    it('顾客手机号脱敏；无号码的保留 null', async () => {
      const h = createHarness();
      const result = await h.service.bookings(7, 1, 20, {});
      expect(result.items[0]?.customerPhoneMasked).toBe('139****2222');
      expect(result.items[1]?.customerPhoneMasked).toBeNull();
    });

    it('字段集合不含成本 / 内部字段（§12.6）', async () => {
      const h = createHarness();
      const result = await h.service.bookings(7, 1, 20, {});
      const booking = result.items[0] as Row;
      expect(Object.keys(booking)).toEqual([
        'id',
        'bookingNo',
        'customerName',
        'customerPhoneMasked',
        'startAt',
        'endAt',
        'status',
        'payStatus',
        'payableAmount',
        'paidAmount',
        'dueAmount',
        'remark',
        'items',
      ]);
      for (const key of FORBIDDEN_BOOKING_KEYS)
        expect(booking[key]).toBeUndefined();
      // 明细只出「价 + 时长」，成本不出去
      expect(Object.keys((booking.items as Row[])[0] as Row)).toEqual([
        'serviceItemId',
        'name',
        'price',
        'durationMinutes',
      ]);
      expect((booking.items as Row[])[0]).not.toHaveProperty('cost');
    });

    it('时间统一转 ISO 字符串，前端不再自己解析', async () => {
      const h = createHarness();
      const result = await h.service.bookings(7, 1, 20, {});
      expect(result.items[0]?.startAt).toBe('2026-09-11T02:00:00.000Z');
      expect(result.items[0]?.endAt).toBe('2026-09-11T03:00:00.000Z');
    });
  });

  describe('schedule', () => {
    it('日期转发到班次与例外两条查询，且都带本人 staffId', async () => {
      const h = createHarness();
      const result = await h.service.schedule(7, '2026-09-11');
      expect(h.calls.resolveShifts).toEqual([
        { staffId: 7, date: '2026-09-11' },
      ]);
      expect(h.calls.listOverrides).toEqual([
        { staffId: 7, filter: { from: '2026-09-11', to: '2026-09-11' } },
      ]);
      expect(result).toEqual({
        date: '2026-09-11',
        off: false,
        segments: [{ startTime: '10:00', endTime: '19:00' }],
        overrides: [
          {
            id: 31,
            date: '2026-09-11',
            type: 'custom',
            startTime: '11:00',
            endTime: '18:00',
            reason: '培训',
          },
        ],
      });
    });
  });

  describe('performance', () => {
    it('period 必须是 yyyyMM，其它写法直接 400（不让端上拼出怪月份）', async () => {
      const h = createHarness();
      await expect(h.service.performance(7, '2026-09')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(h.service.performance(7, '20269')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(h.service.performance(7, 'abcdef')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('不传 period → 三个端口都收到 undefined，由服务端按店内时区算当月', async () => {
      const h = createHarness();
      await h.service.performance(7);
      expect(h.calls.performanceByStaff).toEqual([
        { staffId: 7, period: undefined },
      ]);
      expect(h.calls.commissionListByStaff).toEqual([
        { staffId: 7, period: undefined },
      ]);
      expect(h.calls.summarizeByStaff).toEqual([
        { staffId: 7, period: undefined },
      ]);
    });

    it('传了 period 就一路透传，明细逐单全见（D9）', async () => {
      const h = createHarness();
      const result = await h.service.performance(7, '202608');
      expect(h.calls.performanceByStaff).toEqual([
        { staffId: 7, period: '202608' },
      ]);
      expect(result.period).toBe('202608');
      expect(result.completedCount).toBe(12);
      expect(result.commission).toEqual({
        accrued: 1990,
        settled: 3980,
        reversed: 500,
      });
      expect(result.rating).toEqual({ count: 1, average: 4.8 });
      expect(result.items).toHaveLength(2);
      // 未结算 → null；已结算 → ISO
      expect(result.items[0]?.settledAt).toBeNull();
      expect(result.items[1]?.settledAt).toBe('2026-09-12T02:00:00.000Z');
      expect(Object.keys(result)).toEqual([
        'period',
        'completedCount',
        'paidAmount',
        'commission',
        'rating',
        'items',
      ]);
    });

    it('没有评价时 average=null（前端显示「暂无评分」而不是 0 分）', async () => {
      const h = createHarness();
      h.reviewPort.averageScore.mockResolvedValue({ count: 0, average: null });
      const result = await h.service.performance(7, '202609');
      expect(result.rating).toEqual({ count: 0, average: null });
    });
  });

  describe('reviews', () => {
    it('只拿本人评价，分页透传，时间转 ISO', async () => {
      const h = createHarness();
      const result = await h.service.reviews(7, 1, 20);
      expect(h.calls.reviewListByStaff).toEqual([
        { staffId: 7, page: 1, pageSize: 20 },
      ]);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
      expect(result.items[0]).toEqual({
        id: 71,
        bookingId: 11,
        bookingNo: 'B20260911001',
        score: 5,
        content: '很细心',
        reply: '谢谢～',
        createdAt: '2026-09-11T10:00:00.000Z',
      });
    });
  });
});
