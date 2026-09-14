---
title: 排班与可约时段算法
---

# 排班与可约时段算法

排班决定「美甲师什么时候可以被约」。它有两条看起来简单、实际最容易出事的规则：

1. **日期例外是「替代」而不是「叠加」**；
2. **任何会让既有预约落在无效区间的主数据变更，都必须显式告知，不允许静默作废。**

实现文件：

| 文件                                                  | 职责                                                     |
| ----------------------------------------------------- | -------------------------------------------------------- |
| `src/modules/biz/scheduling/scheduling.service.ts`    | 周模板替换、日期例外、冲突扫描（680 行）                 |
| `src/modules/biz/scheduling/scheduling.controller.ts` | `@Controller('biz/staffs')` 下的 4 个端点                |
| `src/modules/biz/booking/slots.service.ts`            | **消费方**：把班次变成可约时段                           |
| `src/modules/biz/common/shop-time.ts`                 | `shopDayRange()` / `shopLocalToUtc()` / `shopWeekday()`  |
| `src/database/schema/index.ts`                        | `biz_staff_weekly_shift` / `biz_staff_schedule_override` |

## 一、数据模型

### 周模板 `biz_staff_weekly_shift`

drizzle 变量 `bizStaffWeeklyShifts`：

| 列                        | 说明                                                   |
| ------------------------- | ------------------------------------------------------ |
| `staff_id`                | 美甲师                                                 |
| `weekday`                 | **1 = 周一 … 7 = 周日**（ISO 8601，不是 JS 的 0=周日） |
| `start_time` / `end_time` | `time` 类型，`HH:MM:SS`                                |

一天多段就是**多行**（例如上午一段、下午一段）。该表是**物理删表**（§3 声明豁免软删）。

### 日期例外 `biz_staff_schedule_override`

drizzle 变量 `bizStaffScheduleOverrides`：

| 列                        | 说明                                      |
| ------------------------- | ----------------------------------------- |
| `staff_id` + `date`       | 生效日期（店内本地日 `YYYY-MM-DD`）       |
| `type`                    | `off`（整天休息）/ `custom`（自定义时段） |
| `start_time` / `end_time` | **仅 `custom` 填**；`off` 必须为空        |
| `reason`                  | 原因（如「调休」）                        |

同样是**物理删表**。

### 校验规则（写入前强制）

```ts
// type='off' 不许带时间 —— 防「既请假又上班」的脏数据
if (input.startTime || input.endTime)
  throw new BadRequestException(
    '请假（type=off）不能填写开始/结束时间，否则会出现「既请假又上班」的脏数据',
  );
// 同一天同一美甲师多个 custom 段不许重叠
this.assertNoOverlap(
  [...customs, { startTime, endTime }],
  `日期 ${date} 的自定义时段存在重叠`,
);
// 周模板：start < end；同 weekday 多段不重叠；总段数 <= 70
if (shifts.length > 70) throw new BadRequestException('班次段数过多');
this.assertNoOverlap(list, `星期${weekday} 的班次存在重叠`);
```

## 二、求值优先级

`SchedulingService.resolveSegments()` 是唯一实现：

```
当天有 type='off'      → { off: true, segments: [] }   （忽略周模板）
否则有 type='custom'   → segments = 这些 custom 段     （替代周模板，不叠加）
否则                   → segments = 周模板中该 weekday 的所有段
```

```ts
private async resolveSegments(executor, staffId, date, overrides) {
  if (overrides.some((row) => row.type === 'off'))
    return { off: true, segments: [] };
  const customs = overrides
    .filter((row) => row.type === 'custom' && row.startTime && row.endTime)
    .map((row) => ({ startTime: row.startTime, endTime: row.endTime }))
    .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
  if (customs.length) return { off: false, segments: customs };
  const weekly = await executor.select({ startTime, endTime })
    .from(bizStaffWeeklyShifts)
    .where(and(eq(bizStaffWeeklyShifts.staffId, staffId), eq(bizStaffWeeklyShifts.weekday, shopWeekday(date))));
  return { off: false, segments: weekly.map(/* … */).sort(/* 按开始时间 */) };
}
```

对外入口是 `resolveShifts(staffId, date, tx?)`，返回 `{ off, segments }`：

```ts
async resolveShifts(staffId: number, date: string, tx?: BizTx) {
  const executor: BizExecutor = tx ?? this.database.db;   // 事务内调用必须传 tx
  const localDate = this.assertLocalDate(date);
  const overrides = await this.loadDayOverrides(executor, staffId, localDate);
  return (await this.resolveSegments(executor, staffId, localDate, overrides)) /* → { off, segments } */;
}
```

::: warning 例外是「替代」不是「叠加」
最常见的误用是把它当成「在周模板上再加一段」。实际语义是**整天的时段被 `custom` 完全替换**。销售想「这周六只上 14:00–17:00」时，写一条 `custom` 就够了，不需要先删周模板。
:::

## 三、排班如何被可约时段算法消费

`SlotsService.availableSlots()` 里的一组调用：

```ts
// src/modules/biz/booking/slots.service.ts
const { start: dayStart, end: dayEnd } = shopDayRange(query.date, timeZone);
const { off, segments } = await this.schedule.resolveShifts(
  query.staffId,
  query.date,
);
if (off) return { slots: [], reason: 'off', durationMinutes, bufferMinutes };
if (!segments.length)
  return { slots: [], reason: 'no_shift', durationMinutes, bufferMinutes };
// …然后对每个 segment 枚举网格起点，做对称 gap 判据
for (const segment of segments) {
  const segStart = shopLocalToUtc(query.date, segment.startTime, timeZone);
  const segEnd = shopLocalToUtc(query.date, segment.endTime, timeZone);
  // 网格以店内本地日 00:00 为基准
  const firstGrid =
    dayStart.getTime() +
    Math.ceil(Math.max(segStart.getTime() - dayStart.getTime(), 0) / stepMs) *
      stepMs;
  for (let t = firstGrid; ; t += stepMs) {
    if (t + durationMs > segEnd.getTime()) break; // 服务必须完整落在段内
    /* …提前期 / 冲突判据… */
  }
}
```

`segments` 的数据结构就是 `{ startTime, endTime }` 的字符串数组（`SchedulePort.ShiftSegment`），**时间是店内墙钟 `HH:MM:SS`**，转绝对时刻一律走 `shopLocalToUtc(date, time, timeZone)`。

创建预约时另有一道 `assertWithinShift()`，判定 `[startAt, startAt + D]` 必须完整落在**某个**段内：

```ts
const inside =
  !off &&
  segments.some((segment) => {
    const segStart = shopLocalToUtc(date, segment.startTime, tz).getTime();
    const segEnd = shopLocalToUtc(date, segment.endTime, tz).getTime();
    return start >= segStart && end <= segEnd;
  });
if (!inside) throw new BadRequestException('所选时间不在该美甲师的班次内');
```

内部预约页展示用 `SlotsService.listDayBookings(staffId, date, timeZone)`（只读，无锁）。

::: danger 后台与小程序必须复用同一个 `SlotsService`
`GET /biz/bookings/available-slots` 与 `GET /app/available-slots` 共用 `SlotsService.availableSlots()`。自己写一套时段算法 = 两侧结果不一致 = B6 验收项直接挂。
:::

## 四、主数据变更与既有预约的冲突保护（本页重点）

**已存在的预约是事实，不允许被静默作废。**

### 保护矩阵

| 变更                       | 判定                                            | 行为                                                      |
| -------------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| 新增 `off` 请假            | 该日存在 `pending`/`confirmed`/`arrived` 的预约 | **默认 409** + 受影响清单；`force=true` 才落库            |
| `custom` 缩短 / 改时段     | 既有预约超出新时段                              | 同上                                                      |
| 删除日期例外               | 回到周模板后预约越界                            | 同上（`?force=true`）                                     |
| 缩短 / 删除周模板班次      | **未来 30 天**内既有预约越界                    | **409，且刻意不提供 `force`**                             |
| 停用美甲师                 | 存在未完成预约                                  | 拒绝（`staffs.service.ts`）                               |
| 停用 / 删除服务项目        | 存在引用它的未完成预约                          | 拒绝（`service-items.service.ts`）                        |
| 修改项目时长 / 缓冲 / 价格 | —                                               | **不动历史**，只影响新单（快照已落在 `biz_booking_item`） |

### 实现

**判定基准是「落库后的有效班次」**，不是「变更本身」：

```ts
// createOverride：把新例外加进当天 overrides 后重新求值，再用这个结果去扫冲突
const after = await this.resolveSegments(this.database.db, staffId, date, [
  ...existing,
  { type: input.type, startTime, endTime },
]);
const conflicts = await this.findDayConflicts(
  this.database.db,
  staffId,
  date,
  after.segments,
  timeZone,
);
if (conflicts.length && !force)
  throw this.conflictException(
    `该日（${date}）已有 ${conflicts.length} 条预约落在新班次之外，请先改期，或确认后强制保存`,
    conflicts,
  );
```

扫描用 `shopDayRange(date)` 得到本地日区间，再逐条用 `withinSegments()` 判断：

```ts
private async findDayConflicts(executor, staffId, date, segments, timeZone) {
  const { start, end } = shopDayRange(date, timeZone);
  const rows = await executor.select({ id, bookingNo, startAt, endAt, customerName })
    .from(bizBookings)
    .where(and(
      eq(bizBookings.staffId, staffId),
      inArray(bizBookings.status, [...UNFINISHED_BOOKING_STATUSES]),   // pending/confirmed/arrived
      isNull(bizBookings.deletedAt),
      gte(bizBookings.startAt, start),
      lt(bizBookings.startAt, end),
    ))
    .orderBy(asc(bizBookings.startAt));
  return rows
    .filter((row) => !this.withinSegments(row.startAt, row.endAt, date, segments, timeZone))
    .map((row) => ({ id, bookingNo, startAt, endAt, customerName, staffId }));
}
```

### 周模板：未来 30 天扫描

`TEMPLATE_CONFLICT_DAYS = 30`。周模板是长期生效的骨架，因此：

- 扫描窗口是 `[今天, 今天+29]`；
- **有日期例外的日子跳过**（那些天不吃周模板）；
- 命中冲突直接 409，**没有 `force`**（注释写明：「刻意不提供 force，避免静默把已约的单甩在班次外」）。

```ts
const overrides = await this.database.db
  .select({ date })
  .from(bizStaffScheduleOverrides)
  .where(and(eq(staffId), gte(date, today), lte(date, lastDate)));
const overrideDates = new Set(overrides.map((row) => row.date));
return this.findRangeConflicts(
  staffId,
  shopDayRange(today, tz).start,
  shopDayRange(addLocalDays(lastDate, 1), tz).start,
  byWeekday,
  tz,
  overrideDates,
);
```

### 真实接口路径与响应结构

| 方法     | 路径                                                      | 权限                  | 说明                                               |
| -------- | --------------------------------------------------------- | --------------------- | -------------------------------------------------- |
| `GET`    | `/api/v1/biz/staffs/:id/weekly-shifts`                    | `biz:schedule:list`   | 周模板（7 天全部段）                               |
| `PUT`    | `/api/v1/biz/staffs/:id/weekly-shifts`                    | `biz:schedule:update` | **整体替换**；越界预约 → 409                       |
| `GET`    | `/api/v1/biz/staffs/:id/overrides?from=&to=`              | `biz:schedule:list`   | 例外列表                                           |
| `POST`   | `/api/v1/biz/staffs/:id/overrides`                        | `biz:schedule:update` | 新增例外；409 + 清单；body 里 `force: true` 才放行 |
| `DELETE` | `/api/v1/biz/staffs/:id/overrides/:overrideId?force=true` | `biz:schedule:update` | 删除例外；409 + 清单                               |

409 响应体（`ConflictException({ message, conflicts })`）：

```json
{
  "statusCode": 409,
  "message": "该日（2026-09-12）已有 2 条预约落在新班次之外，请先改期，或确认后强制保存",
  "conflicts": [
    {
      "id": 1024,
      "bookingNo": "B202609120001024",
      "startAt": "2026-09-12T10:00:00+08:00",
      "endAt": "2026-09-12T11:00:00+08:00",
      "customerName": "张三",
      "staffId": 7
    }
  ]
}
```

`conflicts` 里的时间是**带偏移的 ISO8601**（`Date` 经 Nest 序列化时按 UTC 输出，前端按店内时区格式化后展示）。

### `force` 覆盖的语义与后果

- 只对 `POST /overrides` 与 `DELETE /overrides/:id` 有效（`force=true` 或 `?force=true`/`force=1`）。
- 语义：**明知有预约仍然写**。返回值里会把 `conflicts` 一并带回，前端可以据此提示「以下单据需要改期」。
- 后果：这些预约的 `start_at`/`end_at` 落在班次之外了。系统**不会**自动取消它们；它们仍然是 `pending/confirmed/arrived`，占用时段、可被到店/完成，但**不再出现在可约时段里**（因为 `availableSlots` 只枚举班次内网格）。
- 因此 `force` 之后唯一正确的动作是：**立刻按 `conflicts` 清单逐单改期**。

::: danger 前端二次确认是硬要求
`web/src/views/biz/schedules/index.vue` 在 409 时弹确认框列出 `conflicts`，用户确认后才带 `force` 重发。不要在前端静默 `force=true`。
:::

### 安全顺序（重要）

`createOverride` 的校验顺序是：

1. `assertStaffExists`
2. `assertLocalDate` + `type` 合法性
3. `off` / `custom` 的字段与重叠校验
4. **以落库后的班次扫冲突 → 409**
5. **才** `INSERT`

所以「409 时数据库里什么都没有」，不会留下半成品。而周模板替换的「先删后插」在**同一事务**内：

```ts
await this.database.db.transaction(async (tx) => {
  await tx
    .delete(bizStaffWeeklyShifts)
    .where(eq(bizStaffWeeklyShifts.staffId, staffId));
  if (!normalized.length) return;
  await tx.insert(bizStaffWeeklyShifts).values(normalized.map(/* … */));
});
```

::: warning 先删后插必须同事务
中途失败会**丢排班**（人还能被约但没有任何班次）。这段代码看起来平淡，但它是本节最容易被重构掉的一行。
:::

## 五、时区与营业日切分

### `shopDayRange()` 的位置与用法

定义在 `src/modules/biz/common/shop-time.ts`：

```ts
/** 店内本地日 [00:00, 次日 00:00) 对应的绝对时刻区间 */
export function shopDayRange(
  date: string,
  timeZone: string = DEFAULT_SHOP_TIMEZONE,
): { start: Date; end: Date } {
  assertLocalDate(date);
  return {
    start: shopLocalToUtc(date, '00:00:00', timeZone),
    end: shopLocalToUtc(addLocalDays(date, 1), '00:00:00', timeZone),
  };
}
```

时区由业务配置 `biz.booking.timezone` 决定，默认 `Asia/Shanghai`（`DEFAULT_SHOP_TIMEZONE`），通过 `BizConfigService.booking()` 读取。

调用点（全站）：

| 位置                                    | 用途                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `slots.service.ts`                      | 枚举当天可约时段的日界、`assertGridAligned()` 的网格基准               |
| `scheduling.service.ts`                 | `findDayConflicts()` / `findTemplateConflicts()` 的扫描区间            |
| `common/query.ts` 的 `localDateRange()` | 所有列表的日期筛选（`from`/`to` 是本地日，右边界取 `to+1` 天的 00:00） |
| `notices.service.ts`                    | `sendBookingReminders()` 取「明天」的区间                              |
| `bookings.service.ts` 的 `monthRange()` | 月度业绩按店内时区取月                                                 |

### 跨夜班次怎么处理

`biz_staff_weekly_shift.end_time` 是 `time`，`normalizeTime()` 把取值限制在 **`00:00`–`23:59`**：

```ts
const minutes = timeToMinutes(text);
if (minutes < 0 || minutes > 24 * 60 - 1) return null;
```

因此 **同一个 `date` 内的段必须 `start < end`**：

```ts
if (timeToMinutes(startTime) >= timeToMinutes(endTime))
  throw new BadRequestException(
    `星期${weekday} 的班次 ${startTime}-${endTime} 开始时间必须早于结束时间`,
  );
```

::: danger 当前不支持跨夜班次
`shopLocalToUtc(date, '02:00:00')` 会解析成**当天**凌晨 2 点，而不是次日。想要「晚上 22:00 到次日 02:00」，只能在**次日**加一段 `custom: 00:00–02:00`（日期例外），不能写成一段跨零点的时段。
:::

### 三个必须记住的时区铁律

1. **时间是 UTC 存储**：连接会话 `SET time_zone='+00:00'`，`mysql2` 的 `timezone: 'Z'`。
2. **不要把本地日直接 `new Date('2026-09-12')`**：会按 UTC 零点解析，东八区整体偏 8 小时。
3. `shopLocalToUtc()` 内部做了**两轮偏移修正**（跨 DST 时必要）：

```ts
let offset = timeZoneOffsetMs(new Date(wallAsUtc), timeZone);
offset = timeZoneOffsetMs(new Date(wallAsUtc - offset), timeZone);
return new Date(wallAsUtc - offset);
```

集成测试（`tests/integration/b1-booking.int.spec.ts`）：

- `时段落在店内本地日区间内，且是带 +08:00 偏移的 ISO8601`（L91）
- `当天无班次 → reason=no_shift；请假 → reason=off`（L116）
- `custom 例外替代周模板（仅返回自定义时段）`（L147）

## 延伸阅读

- [预约主链路实现](/backend/booking) —— `resolveShifts()` 的消费方与冲突锁
- [数据模型总览](/data/) —— 排班两张表的索引与物理删豁免
- [接口契约索引](/appendix/api) —— 排班 5 个端点的完整请求/响应
