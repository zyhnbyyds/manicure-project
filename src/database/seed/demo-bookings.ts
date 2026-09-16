import { and, asc, eq, gte, isNull, like, lt, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { NestFactory } from '@nestjs/core';
import type { RequestActor } from '../../common/data-scope/data-scope.js';
import {
  formatShopDateTime,
  minutesToTime,
  shopDayRange,
  shopLocalToUtc,
  shopToday,
  shopWeekday,
  timeToMinutes,
} from '../../modules/biz/common/shop-time.js';
import {
  bizBookings,
  bizCustomers,
  bizServiceItems,
  bizStaffServiceItems,
  bizStaffs,
  bizStaffWeeklyShifts,
  sysStores,
  users,
} from '../schema/index.js';
import { shopTimeZone } from './demo.js';

/**
 * 演示用「当天预约」seed（**可选**，仅供开发与演示环境）。
 *
 * 由 `bun run db:seed:demo` 在顾客档案之后自动调用，也可以单独跑：
 * `bun src/database/seed/demo-bookings.ts`。
 *
 * ## 为什么不拼 SQL
 *
 * 预约上有四个派生字段：`paid_amount` / `refund_amount` / `due_amount` / `pay_status`。
 * `money-invariants` §1 规定它们的**唯一写入方**是 `BookingSettlementService.recalc()`，
 * 并且明确写着「任何接口、任务、**脚本**都不准直接 UPDATE 这些字段」。
 *
 * 所以这里不算价、不写金额、不碰流水，而是把 `AppModule` 拉起来调
 * `BookingsService.create()` 走完整九步 —— 算价、`FOR UPDATE` 锁、冲突检测、
 * 收款流水、会员积分与等级全部由业务代码负责。于是演示数据从第一天起就是
 * **账实相符**的：首页的净营收和收款流水对得上，对账等式也成立。
 *
 * 为什么不干脆手写 INSERT 省掉启动开销：那等于把「九步」和收款规则又实现一遍，
 * 而且必然会在某次业务改动后悄悄走偏 —— 首页展示的是假数据不可怕，
 * 可怕的是它看起来对、其实和真实链路算出来的不是一个数。
 *
 * ## 它造什么
 *
 * 按**当天真实班次**（`biz_staff_weekly_shifts`）给每位上班的美甲师铺预约，
 * 状态按「当前时刻」定，所以无论上午还是晚上跑，屏上都是合理的现场：
 *
 * | 时段 | 落到什么状态 | 收款 |
 * | --- | --- | --- |
 * | 已结束 | `completed`（到店 + 完成两步） | ✅ 现金全额 |
 * | 进行中 | `arrived` | ❌（还早） |
 * | 还没到 | `confirmed` | ❌ |
 *
 * 最后再撤掉 1 单未来的，留一个 `cancelled` 让首页的成单率 / 取消率有分母 ——
 * 否则那两个率恒为 100%，比空着还假。
 *
 * ## 幂等
 *
 * **当天已有预约就整段跳过**。刻意不做「先删后建」：删预约要连带动收款流水与
 * 会员账务，而那正是本文件极力避免去做的事。想重造就把当天预约清掉再跑。
 *
 * 清空演示数据：`DELETE FROM biz_booking WHERE remark LIKE '[demo]%';`
 */
const DEMO_REMARK_PREFIX = '[demo]';

/** 演示顾客的手机号前缀，与 `demo.ts` 的 `CUSTOMER_SEEDS` 一致 */
const DEMO_PHONE_PREFIX = '137000000%';

/** 与 `biz.booking.stepMinutes`（15 分钟）对齐，决定同一美甲师两单之间的最小间隔 */
const STEP_MINUTES = 15;

export async function seedDemoBookings(pool?: mysql.Pool): Promise<void> {
  const url = Bun.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const owned = !pool;
  const target = pool ?? mysql.createPool(url);
  const db = drizzle({ client: target });

  try {
    const tz = await shopTimeZone(db);
    const today = shopToday(tz);
    const weekday = shopWeekday(today);
    const { start: dayStart, end: dayEnd } = shopDayRange(today, tz);

    // ---- 幂等闸门：当天已经有单就整段跳过 ----
    const [existing] = await db
      .select({ id: bizBookings.id })
      .from(bizBookings)
      .where(
        and(
          gte(bizBookings.startAt, dayStart),
          lt(bizBookings.startAt, dayEnd),
          isNull(bizBookings.deletedAt),
        ),
      )
      .limit(1);
    if (existing) {
      console.log(
        `[seed:demo:bookings] ${today} 已有预约，跳过（避免重复堆积；想重造请先清空当天预约）`,
      );
      return;
    }

    // ---- 前置数据 ----
    const customers = await db
      .select({ id: bizCustomers.id, name: bizCustomers.name })
      .from(bizCustomers)
      .where(like(bizCustomers.phone, DEMO_PHONE_PREFIX))
      .orderBy(asc(bizCustomers.id));
    if (customers.length === 0) {
      console.log(
        '[seed:demo:bookings] 没有演示顾客，请先跑 `bun run db:seed:demo` 建档案',
      );
      return;
    }

    const staffs = await db
      .select({ id: bizStaffs.id, nickname: bizStaffs.nickname })
      .from(bizStaffs)
      .orderBy(asc(bizStaffs.sort));
    const items = await db
      .select({
        id: bizServiceItems.id,
        name: bizServiceItems.name,
        durationMinutes: bizServiceItems.durationMinutes,
        bufferMinutes: bizServiceItems.bufferMinutes,
      })
      .from(bizServiceItems)
      .orderBy(asc(bizServiceItems.sort));
    const skillRows = await db
      .select({
        staffId: bizStaffServiceItems.staffId,
        serviceItemId: bizStaffServiceItems.serviceItemId,
      })
      .from(bizStaffServiceItems);

    const [store] = await db
      .select({ id: sysStores.id })
      .from(sysStores)
      .orderBy(asc(sysStores.id))
      .limit(1);

    /**
     * 当天班次。
     *
     * `store_id` 可空表示「通用班次」，与 `SchedulingService.resolveShifts` 同一套层叠：
     * 同一天**门店专属优先**，没有专属的才用通用。演示环境只有一家店，
     * 但这里照抄规则，免得将来多店时 seed 造出一批和排班页对不上的单。
     */
    const shiftRows = await db
      .select({
        staffId: bizStaffWeeklyShifts.staffId,
        storeId: bizStaffWeeklyShifts.storeId,
        startTime: bizStaffWeeklyShifts.startTime,
        endTime: bizStaffWeeklyShifts.endTime,
      })
      .from(bizStaffWeeklyShifts)
      .where(
        and(
          eq(bizStaffWeeklyShifts.weekday, weekday),
          or(
            isNull(bizStaffWeeklyShifts.storeId),
            eq(bizStaffWeeklyShifts.storeId, store?.id ?? 0),
          ),
        ),
      );
    const shiftByStaff = new Map<
      number,
      { startTime: string; endTime: string }
    >();
    for (const row of shiftRows) {
      const current = shiftByStaff.get(row.staffId);
      if (!current || row.storeId !== null) {
        shiftByStaff.set(row.staffId, {
          startTime: row.startTime,
          endTime: row.endTime,
        });
      }
    }

    if (shiftByStaff.size === 0) {
      console.log(
        `[seed:demo:bookings] ${today}（本周第 ${weekday} 天）没有任何美甲师排班 —— ` +
          '演示班次里**周一全店休息**，换一个营业日再跑，或先去「排班管理」补班次',
      );
      return;
    }

    const [admin] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, 'admin'))
      .limit(1);
    /** 超管身份：`*:*:*` 让门店可见性校验直接放行，不必为 seed 单独造账号 */
    const actor: RequestActor = {
      id: admin?.id ?? 1,
      roles: ['admin'],
      permissions: ['*:*:*'],
      storeId: store?.id,
    };

    // ---- 起 Nest 上下文：建单 / 到店 / 完成 / 收款全部走业务服务 ----
    const [{ AppModule }, { BookingsService }] = await Promise.all([
      import('../../app.module.js'),
      import('../../modules/biz/booking/bookings.service.js'),
    ]);
    const app = await NestFactory.createApplicationContext(AppModule, {
      // 启动期的 Nest 日志（RoutesResolver 那一屏）会把结果淹掉
      logger: false,
    });

    let created = 0;
    let settled = 0;
    let cancelled = 0;
    let failed = 0;
    const futureIds: number[] = [];
    const failures: string[] = [];

    try {
      const bookings = app.get(BookingsService);
      const now = Date.now();
      // 跨美甲师连续递增，让项目轮换得更均匀，而不是每个人第一单都是纯色
      let seq = 0;

      for (const staff of staffs) {
        const shift = shiftByStaff.get(staff.id);
        if (!shift) continue;
        const skillSet = new Set(
          skillRows
            .filter((row) => row.staffId === staff.id)
            .map((row) => row.serviceItemId),
        );
        const allowed = items.filter((item) => skillSet.has(item.id));
        if (allowed.length === 0) continue;

        const shiftEnd = timeToMinutes(shift.endTime);
        let cursor = timeToMinutes(shift.startTime);

        while (true) {
          const item = allowed[seq % allowed.length];
          if (!item) break;
          seq += 1;

          // `end_at` 不含缓冲，但下一位必须等缓冲结束（§5.5）
          const serviceEnd = cursor + item.durationMinutes;
          if (serviceEnd > shiftEnd) break;
          const customer = customers[seq % customers.length] ?? customers[0];
          if (!customer) break;

          const startAt = shopLocalToUtc(today, minutesToTime(cursor), tz);
          cursor = serviceEnd + Math.max(item.bufferMinutes, STEP_MINUTES);

          try {
            const booking = await bookings.create(
              {
                customerId: customer.id,
                staffId: staff.id,
                startAt: formatShopDateTime(startAt, tz),
                serviceItemIds: [item.id],
                /**
                 * `deposit` 而不是 `full`：`full` 要求**下单当场收清**，
                 * 而应付金额是服务端算价算出来的、下单之前拿不到 —— 硬写全款
                 * 只会在「收款金额 != 应收」上撞回来（实测报「全款模式必须收清」）。
                 * 用 `deposit` 且不传 `payments` 就能先落一张未收款单据，
                 * 拿到返回值里的 `dueAmount` 再去 `settle` 收尾款。
                 */
                payMode: 'deposit',
                remark: `${DEMO_REMARK_PREFIX} 演示数据`,
              },
              actor,
            );
            created += 1;

            if (startAt.getTime() + item.durationMinutes * 60_000 <= now) {
              // 已经做完了：到店 → 完成 → 全额现金收款
              await bookings.arrive(booking.id, actor);
              await bookings.complete(booking.id, actor);
              if (booking.dueAmount > 0) {
                await bookings.settle(
                  booking.id,
                  {
                    payments: [{ channel: 'cash', amount: booking.dueAmount }],
                  },
                  actor,
                );
                settled += 1;
              }
            } else if (startAt.getTime() <= now) {
              // 正在做：只到店，钱等做完再收
              await bookings.arrive(booking.id, actor);
            } else {
              futureIds.push(booking.id);
            }
          } catch (error) {
            failed += 1;
            // 只留前几条，避免一个系统性错误刷满整屏
            if (failures.length < 5) {
              const message =
                error instanceof Error ? error.message : String(error);
              failures.push(
                `${staff.nickname} ${minutesToTime(serviceEnd - item.durationMinutes)} ${item.name}：${message}`,
              );
            }
            continue;
          }
        }
      }

      // 撤掉 1 单未来的：让首页的成单率 / 取消率有分母
      const victim = futureIds.at(-1);
      if (victim !== undefined) {
        try {
          await bookings.cancel(victim, '顾客临时有事（演示数据）', actor);
          cancelled += 1;
        } catch {
          // 取消失败不影响整体结果
        }
      }
    } finally {
      await app.close();
    }

    console.log(
      `[seed:demo:bookings] ${today} 建立 ${created} 单：已完成并收款 ${settled} 单、取消 ${cancelled} 单` +
        (failed > 0 ? `，失败 ${failed} 单` : ''),
    );
    for (const line of failures) console.log(`  ⚠️ ${line}`);
  } finally {
    if (owned) await target.end();
  }
}

if (import.meta.main) {
  await seedDemoBookings();
}
