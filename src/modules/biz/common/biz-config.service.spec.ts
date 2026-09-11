import { describe, expect, it, vi } from 'vitest';
import {
  BIZ_CONFIG_DEFAULTS,
  BIZ_CONFIG_KEYS,
  BIZ_CONFIG_LABELS,
  BizConfigService,
} from './biz-config.service.js';

/**
 * 只 mock `select().from().where()` 这条链——`BizConfigService` 读库的唯一入口。
 * 其余（解析、边界、缓存）都是被测的真实逻辑。
 */
function mockDatabase(rows: { key: string; value: string }[] = []) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { database: { db: { select } } as never, select, where };
}

function serviceWith(rows: { key: string; value: string }[] = []) {
  const { database, select } = mockDatabase(rows);
  return { service: new BizConfigService(database), select };
}

describe('biz/common/biz-config（§5.6 配置读取唯一入口）', () => {
  it('库中无配置时全部回落默认值', async () => {
    const { service } = serviceWith();
    const booking = await service.booking();
    expect(booking.timezone).toBe(BIZ_CONFIG_DEFAULTS['biz.booking.timezone']);
    expect(booking.stepMinutes).toBe(15);
    expect(booking.minLeadMinutes).toBe(60);
    expect(booking.depositPermille).toBe(300);
  });

  it('库中配置覆盖默认值', async () => {
    const { service } = serviceWith([
      { key: 'biz.booking.stepMinutes', value: '30' },
      { key: 'biz.booking.depositPermille', value: '500' },
    ]);
    const booking = await service.booking();
    expect(booking.stepMinutes).toBe(30);
    expect(booking.depositPermille).toBe(500);
  });

  it('非数字值回落默认值，绝不让核心链路不可用', async () => {
    const { service } = serviceWith([
      { key: 'biz.booking.stepMinutes', value: 'abc' },
    ]);
    expect((await service.booking()).stepMinutes).toBe(15);
  });

  it('越界值回落默认值（低于下限 / 高于上限都回落）', async () => {
    const below = serviceWith([{ key: 'biz.booking.stepMinutes', value: '3' }]);
    expect((await below.service.booking()).stepMinutes).toBe(15);
    const above = serviceWith([{ key: 'biz.booking.stepMinutes', value: '999' }]);
    expect((await above.service.booking()).stepMinutes).toBe(15);
  });

  it('空字符串视为未配置', async () => {
    const { service } = serviceWith([
      { key: 'biz.booking.stepMinutes', value: '' },
    ]);
    expect((await service.booking()).stepMinutes).toBe(15);
  });

  it('小数按截断处理', async () => {
    const { service } = serviceWith([
      { key: 'biz.booking.maxAdvanceDays', value: '30.9' },
    ]);
    expect((await service.booking()).maxAdvanceDays).toBe(30);
  });

  it('布尔值兼容 true/1/yes/on 与 false/0/no/off，其余回落默认', async () => {
    const truthy = serviceWith([
      { key: 'biz.member.refundNeedReason', value: 'YES' },
    ]);
    expect((await truthy.service.member()).refundNeedReason).toBe(true);

    const falsy = serviceWith([
      { key: 'biz.member.refundNeedReason', value: '0' },
    ]);
    expect((await falsy.service.member()).refundNeedReason).toBe(false);

    const invalid = serviceWith([
      { key: 'biz.member.refundNeedReason', value: 'maybe' },
    ]);
    expect((await invalid.service.member()).refundNeedReason).toBe(true);
  });

  it('列表配置按逗号切分、去空格、丢弃空项', async () => {
    const { service } = serviceWith([
      {
        key: 'biz.notice.smsTemplates',
        value: ' booking_paid , booking_cancelled ,, ',
      },
    ]);
    expect((await service.notice()).smsTemplates).toEqual([
      'booking_paid',
      'booking_cancelled',
    ]);

    const empty = serviceWith([{ key: 'biz.notice.smsTemplates', value: '' }]);
    expect((await empty.service.notice()).smsTemplates).toEqual([]);
  });

  it('余额扣减顺序只接受白名单值', async () => {
    const ok = serviceWith([
      { key: 'biz.member.bonusDeductMode', value: 'proportional' },
    ]);
    expect((await ok.service.member()).bonusDeductMode).toBe('proportional');

    const bad = serviceWith([
      { key: 'biz.member.bonusDeductMode', value: 'random' },
    ]);
    expect((await bad.service.member()).bonusDeductMode).toBe('bonus_first');
  });

  it('10 秒 TTL 内命中缓存，多次读取只查一次库', async () => {
    const { service, select } = serviceWith([
      { key: 'biz.booking.stepMinutes', value: '30' },
    ]);
    await service.booking();
    await service.booking();
    await service.payment();
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('invalidate 后重新查库（配置页保存后立即生效）', async () => {
    const { service, select } = serviceWith([
      { key: 'biz.booking.stepMinutes', value: '30' },
    ]);
    await service.booking();
    service.invalidate();
    await service.booking();
    expect(select).toHaveBeenCalledTimes(2);
  });

  it('all() 一次性返回六组配置，且共用同一份缓存', async () => {
    const { service, select } = serviceWith();
    const all = await service.all();
    expect(Object.keys(all).sort()).toEqual(
      ['booking', 'commission', 'credit', 'member', 'notice', 'payment'].sort(),
    );
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('默认值键清单与中文名一一对应（seed 写入 sys_config 依赖此约定）', () => {
    expect(BIZ_CONFIG_KEYS.length).toBeGreaterThan(0);
    for (const key of BIZ_CONFIG_KEYS) {
      expect(BIZ_CONFIG_DEFAULTS[key]).toBeDefined();
      expect(BIZ_CONFIG_LABELS[key]).toBeTruthy();
    }
  });
});
