import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { PointsController } from './points.controller';

function createHarness() {
  const goods = {
    preview: vi.fn().mockResolvedValue({ payableAmount: 8500 }),
    redeem: vi
      .fn()
      .mockResolvedValue({ redeemId: 42, cardNo: 'C20260911000005' }),
    listRedeems: vi
      .fn()
      .mockResolvedValue({ items: [], page: 1, pageSize: 20 }),
    revertRedeem: vi.fn().mockResolvedValue({ redeemId: 42, points: 500 }),
  };
  const controller = new PointsController(goods as never);
  return { controller, goods };
}

const actor = { user: { id: 7 } };

describe('PointsController（§9.10 积分入口）', () => {
  describe('preview（抵扣试算）', () => {
    it('透传 customerId 与项目列表给服务', async () => {
      const h = createHarness();
      await h.controller.preview({ customerId: 9, serviceItemIds: [11, 12] });
      expect(h.goods.preview).toHaveBeenCalledWith(9, [11, 12]);
    });

    it('项目列表为空 → 校验失败', () => {
      const h = createHarness();
      expect(() =>
        h.controller.preview({ customerId: 9, serviceItemIds: [] }),
      ).toThrow();
      expect(h.goods.preview).not.toHaveBeenCalled();
    });

    it('项目超过 3 个 → 校验失败（一单最多 3 项）', () => {
      const h = createHarness();
      expect(() =>
        h.controller.preview({ customerId: 9, serviceItemIds: [1, 2, 3, 4] }),
      ).toThrow();
      expect(h.goods.preview).not.toHaveBeenCalled();
    });

    it('customerId 非正整数 → 校验失败', () => {
      const h = createHarness();
      expect(() =>
        h.controller.preview({ customerId: 0, serviceItemIds: [11] }),
      ).toThrow();
    });

    it('缺字段 → 校验失败', () => {
      const h = createHarness();
      expect(() => h.controller.preview({ customerId: 9 })).toThrow();
    });
  });

  describe('redeem（兑换入口：body 优先，query 兜底）', () => {
    it('body 里的 goodsId 优先于 query', () => {
      const h = createHarness();
      h.controller.redeem(9, { goodsId: 3 }, actor, '5');
      expect(h.goods.redeem).toHaveBeenCalledWith(9, 3, 7);
    });

    it('body 不合法时回落到 query 传参', () => {
      const h = createHarness();
      h.controller.redeem(9, {}, actor, '5');
      expect(h.goods.redeem).toHaveBeenCalledWith(9, 5, 7);
    });

    it('body 与 query 都缺 → 400', () => {
      const h = createHarness();
      expect(() => h.controller.redeem(9, {}, actor)).toThrow(
        new BadRequestException('请提供兑换品 goodsId'),
      );
      expect(h.goods.redeem).not.toHaveBeenCalled();
    });

    it.each([['0'], ['-1'], ['abc'], ['1.5'], ['']])(
      'query 的 goodsId=%s 不是正整数 → 400',
      (raw) => {
        const h = createHarness();
        expect(() => h.controller.redeem(9, {}, actor, raw)).toThrow(
          new BadRequestException('请提供兑换品 goodsId'),
        );
        expect(h.goods.redeem).not.toHaveBeenCalled();
      },
    );

    it('body 里 goodsId 非法（0）且无 query → 400', () => {
      const h = createHarness();
      expect(() => h.controller.redeem(9, { goodsId: 0 }, actor)).toThrow(
        new BadRequestException('请提供兑换品 goodsId'),
      );
    });

    it('操作人取当前登录用户 id', () => {
      const h = createHarness();
      h.controller.redeem(9, { goodsId: 3 }, actor, undefined);
      expect(h.goods.redeem).toHaveBeenCalledWith(9, 3, 7);
    });

    it('原样返回服务结果', async () => {
      const h = createHarness();
      await expect(
        h.controller.redeem(9, { goodsId: 3 }, actor),
      ).resolves.toMatchObject({ redeemId: 42 });
    });
  });

  describe('listRedeems（兑换记录）', () => {
    it('status 只放行 success / reverted，其余当未传', () => {
      const h = createHarness();
      h.controller.listRedeems('1', '20', undefined, undefined, 'hacked');
      expect(h.goods.listRedeems).toHaveBeenCalledWith(1, 20, {
        customerId: undefined,
        goodsId: undefined,
        status: undefined,
      });
    });

    it.each([['success'], ['reverted']])('status=%s 原样透传', (status) => {
      const h = createHarness();
      h.controller.listRedeems('1', '20', undefined, undefined, status);
      expect(h.goods.listRedeems).toHaveBeenCalledWith(
        1,
        20,
        expect.objectContaining({ status }),
      );
    });

    it('customerId / goodsId 走正整数解析', () => {
      const h = createHarness();
      h.controller.listRedeems('2', '10', '9', '3', 'success');
      expect(h.goods.listRedeems).toHaveBeenCalledWith(2, 10, {
        customerId: 9,
        goodsId: 3,
        status: 'success',
      });
    });

    it.each([['0'], ['-3'], ['abc'], ['']])(
      'customerId=%s 非法时当未传，不误过滤',
      (raw) => {
        const h = createHarness();
        h.controller.listRedeems('1', '20', raw, raw);
        expect(h.goods.listRedeems).toHaveBeenCalledWith(1, 20, {
          customerId: undefined,
          goodsId: undefined,
          status: undefined,
        });
      },
    );

    it('分页参数缺省时由 parsePagination 兜底', () => {
      const h = createHarness();
      h.controller.listRedeems(undefined, undefined);
      const [page, pageSize] = h.goods.listRedeems.mock.calls[0] as [
        number,
        number,
      ];
      expect(page).toBe(1);
      expect(pageSize).toBeGreaterThan(0);
    });
  });

  describe('revertRedeem（撤销兑换）', () => {
    it('透传兑换记录 id、原因与操作人', () => {
      const h = createHarness();
      h.controller.revertRedeem(42, { reason: '顾客反悔' }, actor);
      expect(h.goods.revertRedeem).toHaveBeenCalledWith(42, '顾客反悔', 7);
    });

    it('原因为空串 → 校验失败，不调服务', () => {
      const h = createHarness();
      expect(() =>
        h.controller.revertRedeem(42, { reason: '' }, actor),
      ).toThrow();
      expect(h.goods.revertRedeem).not.toHaveBeenCalled();
    });

    it('原因超 200 字 → 校验失败', () => {
      const h = createHarness();
      expect(() =>
        h.controller.revertRedeem(42, { reason: 'x'.repeat(201) }, actor),
      ).toThrow();
    });

    it('缺 reason 字段 → 校验失败', () => {
      const h = createHarness();
      expect(() => h.controller.revertRedeem(42, {}, actor)).toThrow();
    });
  });
});
