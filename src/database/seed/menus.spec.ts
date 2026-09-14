import { describe, expect, it } from 'vitest';
import {
  FRONTDESK_PERMISSIONS,
  MENU_SEEDS,
  MONEY_PERMISSIONS,
  ROLE_SEEDS,
} from './menus.js';

/**
 * §15.9「角色建议」的授权口径回归。
 *
 * ## 为什么值得单独测
 *
 * 这套映射是**纯数据规则**，但它的错误方式非常隐蔽：菜单名写错 / 权限点写错，
 * 不会报错，只会「某个角色少看到一个页面」，或者更糟 ——
 * **把钱的权限不小心授予了前台**。seed 跑完只打印一行计数，没人会去核对。
 * 所以把「谁应该有什么、谁绝对不能有什么」钉成断言。
 *
 * 另一条历史教训：收银台要靠 `biz:member:list` 读会员余额，而在此之前
 * 除 admin 外**任何角色都是零权限** —— 前台一开收银台就报「储值余额不足」，
 * 真实原因却是没权限。下面 `前台必须有 member:list` 这条就是防它回归。
 */

function menusOf(roleKey: string) {
  const role = ROLE_SEEDS.find((item) => item.key === roleKey);
  if (!role) throw new Error(`没有这个角色：${roleKey}`);
  return MENU_SEEDS.filter(role.pick);
}

/** 角色实际会拿到的权限点集合（= 被授权菜单上的 permission） */
function permissionsOf(roleKey: string): string[] {
  return menusOf(roleKey)
    .map((seed) => seed.permission)
    .filter((item): item is string => typeof item === 'string');
}

describe('§15.9 角色建议：默认角色的菜单与权限口径', () => {
  it('三个默认角色都建了，key 不与 admin/user 冲突', () => {
    expect(ROLE_SEEDS.map((role) => role.key)).toEqual([
      'manager',
      'frontdesk',
      'stylist',
    ]);
    // key === 'admin' 或 isSystem 会被 auth.service 当成超级管理员（*:*:*）
    expect(ROLE_SEEDS.some((role) => role.key === 'admin')).toBe(false);
  });

  it('店长：业务域全量，且**拿满** §8.1 那批钱的权限', () => {
    const permissions = permissionsOf('manager');
    for (const money of MONEY_PERMISSIONS) {
      expect(permissions, `店长应拥有 ${money}`).toContain(money);
    }
    // 业务域页面一个不漏
    const pageCount = menusOf('manager').filter(
      (seed) => seed.type === 'C' && seed.name.startsWith('biz_'),
    ).length;
    expect(pageCount).toBe(26);
    // 但系统管理/监控这些后台配置不属于店长
    expect(permissions.some((item) => item.startsWith('system:'))).toBe(false);
    expect(permissions.some((item) => item.startsWith('monitor:'))).toBe(false);
  });

  it('前台：必须有 biz:member:list（否则收银台读不到余额，误报「余额不足」）', () => {
    const permissions = permissionsOf('frontdesk');
    expect(permissions).toContain('biz:member:list');
    // §15.9 明确给前台的另外两个
    expect(permissions).toContain('biz:card:list');
    expect(permissions).toContain('biz:card:use');
    // §8.1 注释里点名「店长/前台应有」与「可以给前台」的
    expect(permissions).toContain('biz:booking:manageall');
    expect(permissions).toContain('biz:refund:apply');
  });

  it('前台：**一个钱权限都不能有**（§8.1 收窄）', () => {
    const permissions = permissionsOf('frontdesk');
    for (const money of MONEY_PERMISSIONS) {
      expect(permissions, `前台不该有 ${money}`).not.toContain(money);
    }
    // 收银台页面本身 permission 为空，只能按菜单名收回
    expect(menusOf('frontdesk').map((seed) => seed.name)).not.toContain(
      'biz_cashier',
    );
  });

  it('美甲师：只读，一个按钮（F）都不给', () => {
    const seeds = menusOf('stylist');
    expect(seeds.filter((seed) => seed.type === 'F')).toEqual([]);
    const permissions = permissionsOf('stylist');
    for (const money of MONEY_PERMISSIONS) {
      expect(permissions).not.toContain(money);
    }
    // 只读页面在；收银台不在
    const names = seeds.map((seed) => seed.name);
    expect(names).toContain('biz_bookings');
    expect(names).toContain('biz_schedules');
    expect(names).not.toContain('biz_cashier');
  });

  it('三个角色都能看到首页，且父目录 biz 一并授予（否则子页面在路由树里成孤儿）', () => {
    for (const role of ROLE_SEEDS) {
      const names = menusOf(role.key).map((seed) => seed.name);
      expect(names, `${role.key} 应有首页`).toContain('dashboard');
      expect(names, `${role.key} 应有 biz 父目录`).toContain('biz');
    }
  });

  it('前台：白名单里每一条都真的命中了一个菜单（拼错权限点不会报错，只会静默少授权）', () => {
    const matched = new Set(
      menusOf('frontdesk')
        .map((seed) => seed.permission)
        .filter((item): item is string => typeof item === 'string'),
    );
    for (const wanted of FRONTDESK_PERMISSIONS) {
      expect(matched, `白名单里的 ${wanted} 没有任何菜单与之对应`).toContain(
        wanted,
      );
    }
    // 反向：前台拿到的权限点必须全部来自白名单，不能有漏网的
    for (const permission of matched) {
      expect(FRONTDESK_PERMISSIONS).toContain(permission);
    }
  });

  it('前台：钱相关的**读页面**也不能有（只拦 settle/approve 会漏掉 payment:list 这类）', () => {
    const permissions = permissionsOf('frontdesk');
    const moneyPages = [
      'biz:payment:list', // 支付流水
      'biz:payment:reconcile', // 支付对账
      'biz:receivable:list', // 应收台账
      'biz:receivable:cancel',
      'biz:credit:list', // 挂账主体
      'biz:commission:list', // 提成结算
      'biz:notice:send', // 手工发通知
    ];
    for (const permission of moneyPages) {
      expect(permissions, `前台不该有 ${permission}`).not.toContain(permission);
    }
  });

  it('前台：拿得到首页经营概览**轻量版**，但拿不到含金额的全量版', () => {
    const permissions = permissionsOf('frontdesk');
    expect(permissions).toContain('biz:report:home');
    // 含金额的全量版只给店长及以上（前台拿到就等于把营收发给了前台）
    expect(permissions).not.toContain('biz:report:view');
    expect(permissions).not.toContain('biz:report:export');
  });

  it('美甲师：不会拿到首页经营概览权限（没绑门店 → 一进首页就 403）', () => {
    const permissions = permissionsOf('stylist');
    expect(permissions).not.toContain('biz:report:home');
    expect(permissions).not.toContain('biz:report:view');
  });

  it('映射里的菜单名都真实存在（写错名字会静默少授权）', () => {
    const allNames = new Set(MENU_SEEDS.map((seed) => seed.name));
    for (const role of ROLE_SEEDS) {
      expect(
        menusOf(role.key).length,
        `${role.key} 不该是空授权`,
      ).toBeGreaterThan(0);
    }
    for (const name of ['biz_cashier', 'biz_member_cards', 'biz_members']) {
      expect(allNames, `${name} 不存在，授权/白名单规则失效`).toContain(name);
    }
  });
});
