import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AppStaffGrantsService } from './app-staff-grants.service.js';

type Row = Record<string, unknown>;

function chainFor(result: unknown) {
  const node = Promise.resolve(result) as unknown as Record<string, unknown>;
  for (const key of ['from', 'leftJoin', 'where', 'orderBy', 'limit', 'offset'])
    node[key] = () => node;
  return node;
}

function createHarness(selectResults: unknown[][] = []) {
  const queue = [...selectResults];
  const select = vi.fn(() => chainFor(queue.shift() ?? []));
  const updateWhere = vi.fn().mockResolvedValue([{ affectedRows: 1 }]);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  const service = new AppStaffGrantsService({
    db: { select, update },
  } as never);
  return { service, select, update, updateSet };
}

const grant = (overrides: Row = {}): Row => ({
  id: 3,
  staffId: 7,
  staffStatus: 'pending',
  staffDecidedAt: null,
  ...overrides,
});

const archive = (overrides: Row = {}): Row => ({
  id: 7,
  status: 'active',
  ...overrides,
});

describe('AppStaffGrantsService（施工单 §12.5 店长确认）', () => {
  describe('list', () => {
    it('时间字段转 ISO 字符串，供后台直出', async () => {
      const h = createHarness([
        [
          {
            id: 3,
            openid: 'o-1',
            nickname: '小美',
            phone: '13800000000',
            staffId: 7,
            staffStatus: 'pending',
            staffRequestedAt: new Date('2026-09-11T02:00:00.000Z'),
            staffDecidedAt: null,
            staffRejectReason: null,
            staffName: 'Amy',
            staffArchivedStatus: 'active',
          },
        ],
      ]);
      const result = await h.service.list(1, 20, { status: 'pending' });
      expect(result.page).toBe(1);
      expect(result.items[0]).toMatchObject({
        staffRequestedAt: '2026-09-11T02:00:00.000Z',
        staffDecidedAt: null,
        staffName: 'Amy',
      });
    });
  });

  describe('approve', () => {
    it('申请不存在 → 404', async () => {
      const h = createHarness([[]]);
      await expect(h.service.approve(404, 1)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('已通过 → 幂等返回，不再写库', async () => {
      const h = createHarness([[grant({ staffStatus: 'active' })]]);
      await expect(h.service.approve(3, 1)).resolves.toMatchObject({
        id: 3,
        staffStatus: 'active',
      });
      expect(h.update).not.toHaveBeenCalled();
    });

    it('已驳回 → 409（必须让对方重新申请，避免店长绕过重申）', async () => {
      const h = createHarness([[grant({ staffStatus: 'rejected' })]]);
      await expect(h.service.approve(3, 1)).rejects.toThrow(ConflictException);
      expect(h.update).not.toHaveBeenCalled();
    });

    it('未关联档案 → 409', async () => {
      const h = createHarness([[grant({ staffId: null })]]);
      await expect(h.service.approve(3, 1)).rejects.toThrow(ConflictException);
    });

    it('档案已停用 → 409（批了也进不去工作台）', async () => {
      const h = createHarness([[grant()], [archive({ status: 'disabled' })]]);
      await expect(h.service.approve(3, 1)).rejects.toThrow(ConflictException);
      expect(h.updateSet).not.toHaveBeenCalled();
    });

    it('档案已删除 → 409', async () => {
      const h = createHarness([[grant()], []]);
      await expect(h.service.approve(3, 1)).rejects.toThrow(ConflictException);
    });

    it('待确认 → 置 active 并记录决策人 / 时间', async () => {
      const h = createHarness([[grant()], [archive()]]);
      await expect(h.service.approve(3, 1)).resolves.toMatchObject({
        id: 3,
        staffId: 7,
        staffStatus: 'active',
      });
      expect(h.updateSet).toHaveBeenCalledWith({
        staffStatus: 'active',
        staffDecidedAt: expect.any(Date),
        staffDecidedBy: 1,
        staffRejectReason: null,
      });
    });
  });

  describe('reject', () => {
    it('未填原因 → 400', async () => {
      const h = createHarness([[grant()]]);
      await expect(h.service.reject(3, '   ', 1)).rejects.toThrow(
        BadRequestException,
      );
      expect(h.updateSet).not.toHaveBeenCalled();
    });

    it('已开通 → 409（撤权请走停用档案）', async () => {
      const h = createHarness([[grant({ staffStatus: 'active' })]]);
      await expect(h.service.reject(3, '不想开了', 1)).rejects.toThrow(
        ConflictException,
      );
    });

    it('已驳回 → 幂等返回，不再写库', async () => {
      const h = createHarness([[grant({ staffStatus: 'rejected' })]]);
      await expect(h.service.reject(3, '重复驳回', 1)).resolves.toMatchObject({
        staffStatus: 'rejected',
      });
      expect(h.update).not.toHaveBeenCalled();
    });

    it('待确认 → 置 rejected 并记录原因（申请人可见）', async () => {
      const h = createHarness([[grant()]]);
      await expect(
        h.service.reject(3, ' 手机号不符 ', 1),
      ).resolves.toMatchObject({ staffStatus: 'rejected' });
      expect(h.updateSet).toHaveBeenCalledWith({
        staffStatus: 'rejected',
        staffDecidedAt: expect.any(Date),
        staffDecidedBy: 1,
        staffRejectReason: '手机号不符',
      });
    });
  });
});
