import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  AppStaffScopeGuard,
  type AppStaffRequest,
} from './app-staff-scope.guard';

function chainFor(result: unknown) {
  const node = Promise.resolve(result) as unknown as Record<string, unknown>;
  node.from = () => node;
  node.innerJoin = () => node;
  node.where = () => node;
  node.limit = () => node;
  return node;
}

function context(request: AppStaffRequest) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
}

describe('AppStaffScopeGuard（每请求查库的本人作用域）', () => {
  it('active 身份 + active 未删除档案 → 通过并挂载 staffId', async () => {
    const guard = new AppStaffScopeGuard({
      db: {
        select: vi.fn(() => chainFor([{ staffId: 12, staffStatus: 'active' }])),
      },
    } as never);
    const request: AppStaffRequest = {
      headers: {},
      appUser: { id: 7, openid: 'openid-7' },
    };
    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(request.appStaff).toEqual({
      id: 7,
      openid: 'openid-7',
      staffId: 12,
    });
  });

  it('无匹配行（pending / rejected / 停用 / 软删任一条件不满足）→ 403', async () => {
    const guard = new AppStaffScopeGuard({
      db: { select: vi.fn(() => chainFor([])) },
    } as never);
    const request: AppStaffRequest = {
      headers: {},
      appUser: { id: 7, openid: 'openid-7' },
    };
    await expect(guard.canActivate(context(request))).rejects.toThrow(
      ForbiddenException,
    );
    expect(request.appStaff).toBeUndefined();
  });

  it('缺少上游 app token 身份 → 401', async () => {
    const select = vi.fn();
    const guard = new AppStaffScopeGuard({ db: { select } } as never);
    const request: AppStaffRequest = { headers: {} };
    await expect(guard.canActivate(context(request))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(select).not.toHaveBeenCalled();
  });
});
