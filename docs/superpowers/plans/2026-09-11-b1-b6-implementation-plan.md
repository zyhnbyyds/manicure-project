# 实施计划：B1~B6 模块划分与跨模块接口（唯一施工契约）

> 本文件是并行施工的**接口冻结文档**。模块内部实现自由，但**服务类名、文件路径、跨模块方法签名必须一致**，
> 否则并行开发会互相踩。修改本文件前先确认没有其它模块正在实现。
>
> 规则来源：`docs/superpowers/specs/2026-09-11-nail-salon-booking-design.md`（v1.3，唯一事实来源）
> 与 `.agents/skills/*`（15 个技能，含红线与坑）。

## 0. 通用约定

- 运行时 Bun 1.4；`bun run typecheck` / `bun run lint` / `bun run test` 必须全过。
- ESM：**所有相对导入必须带 `.js` 后缀**。
- Drizzle：表名变量见 `src/database/schema/index.ts`（业务表 `biz*`，小程序 `appWxUsers`，通知 `sysNotice*`）。
  禁止改 schema（表结构已冻结并已生成迁移）；需要加字段先提出来。
- 金额整数「分」，时间 UTC 存储；本地日转换只能用 `shop-time.ts` 的 `shopDayRange()` / `shopLocalToUtc()`。
- 列表接口返回 `{ items, page, pageSize }`（没有 `total`）。
- 事务内一切读写用 `tx`；锁顺序 `biz_staff → biz_customer → biz_payment → biz_member_card`。
- 权限点写进 `src/database/seed/menus.ts`（各段全小写冒号分隔）。
- 公共工具：`src/modules/biz/common/`
  | 文件                   | 导出                                                                                                          |
  | ---------------------- | ------------------------------------------------------------------------------------------------------------- |
  | `shop-time.ts`         | `shopDayRange` `shopLocalToUtc` `formatShopDateTime` `shopDateOf` `shopToday` `addLocalDays` `shopWeekday` `daysBetween` `listLocalDates` `timeToMinutes` `minutesToTime` `DEFAULT_SHOP_TIMEZONE` |
  | `money.ts`             | `quoteBooking` `calcDepositAmount` `permilleOf` `sumDuration` `maxBuffer` `splitBalanceDeduction` `commissionOf` `pointsToCents` `centsToPoints` |
  | `doc-no.ts`            | `buildDocNo` `buildOutTradeNo` `buildSettleBatch`                                                             |
  | `query.ts`             | `parsePagination` `keywordLike` `localDateRange` `andConditions`                                              |
  | `biz-config.service.ts`| `BizConfigService`（`@Global`，直接注入）：`booking()` `member()` `payment()` `notice()` `credit()` `commission()` `all()` `getString/getInt/getBoolean/getList` `invalidate()` |

## 1. 模块与文件清单

| 模块         | 目录                                  | 服务类                                                                | 控制器前缀                                                       |
| ------------ | ------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 基础数据     | `src/modules/biz/base-data/`          | `ServiceItemsService` / `StaffsService` / `CustomersService`           | `biz/service-items` `biz/staffs` `biz/customers`                 |
| 排班         | `src/modules/biz/scheduling/`         | `SchedulingService`                                                   | `biz/staffs`（`:id/weekly-shifts` `:id/overrides`）              |
| 预约主链路   | `src/modules/biz/booking/`            | `SlotsService` / `BookingsService` / `BookingSettlementService`        | `biz/bookings`                                                   |
| 会员         | `src/modules/biz/membership/`         | `MemberLevelsService` `RechargePlansService` `CardTypesService` `MemberAccountsService` `MemberCardsService` `PointsGoodsService` | `biz/member-levels` `biz/recharge-plans` `biz/card-types` `biz/members` `biz/member-cards` `biz/points-goods` `biz/points` `biz/points-redeems` |
| 收银         | `src/modules/biz/payment/`            | `PaymentsService` `RefundsService` `PaymentDiffsService`              | `biz/payments` `biz/refunds` `biz/payment-diffs`                 |
| 挂账         | `src/modules/biz/credit/`             | `CreditAccountsService` `ReceivablesService`                          | `biz/credit-accounts` `biz/receivables`                          |
| 报表/提成    | `src/modules/biz/operations/`         | `ReportsService` `CommissionService`                                  | `biz/reports` `biz/commission-*`                                 |
| 评价/周期/通知 | `src/modules/biz/operations/`       | `ReviewsService` `RecurrencesService` `NoticesService` `SmsProvider`  | `biz/reviews` `biz/recurrences` `biz/notice-*`                   |
| 小程序域     | `src/modules/app/`                    | `AppAuthService` `AppCatalogService` `AppMemberService` `AppAccessTokenGuard` | `/api/v1/app/**`                                          |

批次归属：B1 = 基础数据 + 排班 + 预约；B2 = 会员；B3 = 收银；B4 = 挂账 + 报表 + 提成；
B5 = 评价 + 周期 + 通知 + 美甲师项目；B6 = 小程序。**全部一次性交付**。

## 2. 跨模块方法签名（冻结）

### 2.1 `MemberAccountsService`（会员账务，B2）

```ts
type PricingContext = {
  customerId: number;
  levelId: number | null;
  levelDiscountPermille: number; // 无等级 = 1000
  points: number;
  balancePrincipal: number;
  balanceBonus: number;
};

/** 算价上下文（只读，事务外可调用） */
getPricingContext(customerId: number): Promise<PricingContext>;

/** 事务内锁会员行并返回最新账务快照（锁顺序第二位） */
lockAccount(tx: Tx, customerId: number): Promise<PricingContext>;

/** 储值余额扣减（条件更新，余额不足抛 ConflictException，绝不部分扣） */
applyBalancePayment(tx: Tx, input: {
  customerId: number; amount: number; bookingId?: number | null; paymentId?: number | null;
  remark?: string | null; actorId?: number | null;
}): Promise<{ transactionId: number; bonus: number; principal: number }>;

/** 积分抵扣（条件更新，积分不足抛 ConflictException） */
deductPoints(tx: Tx, input: {
  customerId: number; points: number; bookingId?: number | null;
  type?: 'points_spend' | 'points_redeem'; remark?: string | null; actorId?: number | null;
}): Promise<{ transactionId: number; amount: number }>;

/** 消费落账：累加 total_spent + 按 pointsPerYuan 累计积分 + 写流水 + 触发自动升级 */
recordConsumption(tx: Tx, input: {
  customerId: number; paidAmount: number; bookingId?: number | null;
  payChannel?: 'cash' | 'wechat' | 'alipay' | 'balance' | 'card' | null;
  remark?: string | null; actorId?: number | null;
}): Promise<{ transactionId: number; pointsEarned: number; levelId: number | null }>;

/** 按比例冲减消费与积分（退款用） */
reverseConsumption(tx: Tx, input: {
  customerId: number; amount: number; bookingId?: number | null;
  reversalOf?: number | null; remark?: string | null; actorId?: number | null;
}): Promise<{ transactionId: number; pointsReversed: number }>;

/** 回补储值余额（退入储值 / 退款用，余额只增不减） */
creditBalance(tx: Tx, input: {
  customerId: number; principal?: number; bonus?: number; bookingId?: number | null;
  remark?: string | null; actorId?: number | null;
}): Promise<{ transactionId: number }>;

/** 按流水重算余额/积分/累计消费/等级（对账修复，幂等） */
recount(customerId: number, actorId?: number | null): Promise<void>;

/** 自动升级（幂等；也供定时任务 recountMemberLevels 调用） */
syncLevel(tx: Tx, customerId: number): Promise<number | null>;
recountAllLevels(): Promise<{ updated: number }>;
```

`Tx` = `Parameters<Parameters<MySql2Database<typeof relations>['transaction']>[0]>[0]`，
在 `src/modules/biz/common/tx.ts` 导出别名 `BizTx`。

### 2.2 `MemberCardsService`（次卡，B2）

```ts
/** 发卡（事务内可用；返回卡 id 与卡号） */
issueCard(tx: Tx, input: {
  customerId: number; cardTypeId: number; payChannel: 'cash' | 'wechat' | 'alipay' | 'balance';
  price?: number; remark?: string | null; actorId?: number | null;
}): Promise<{ id: number; cardNo: string; expireAt: Date | null }>;

/** 核销一次（条件更新当闸门；卡不可用抛 ConflictException） */
useCard(tx: Tx, input: {
  cardId: number; serviceItemId: number; bookingId?: number | null; actorId?: number | null;
}): Promise<{ cardId: number; usedTimes: number; totalTimes: number; status: string }>;

/** 撤销一次核销（写 revert 记录 + 回补次数） */
revertUse(tx: Tx, input: { cardId: number; bookingId?: number | null; actorId?: number | null }): Promise<void>;

/** 可用卡校验（下单时校验卡是否可用、项目是否在适用范围内） */
assertUsable(tx: Tx, cardId: number, serviceItemIds: number[]): Promise<CardRow>;
list(page, pageSize, filter): Promise<{ items; page; pageSize }>;
findOne(id): Promise<CardRow>;
refund(cardId: number, amount: number, reason: string, actorId: number): Promise<void>;
expireCards(): Promise<{ expired: number }>;   // 定时任务用
```

### 2.3 `PaymentsService`（支付，B3）

```ts
type PaymentDraft = {
  customerId: number;
  bookingId?: number | null;
  purpose: 'deposit' | 'final' | 'recharge' | 'card_buy' | 'credit_settle';
  channel: 'wxpay_native' | 'alipay_qr' | 'cash' | 'wechat_offline' | 'alipay_offline' | 'balance' | 'card' | 'credit';
  amount: number;              // 应收
  receivedAmount?: number;     // 实收（默认 = amount）
  memberCardId?: number | null;
  remark?: string | null;
};
type PaymentOutcome = {
  paymentId: number; paymentNo: string; outTradeNo: string;
  status: 'pending' | 'success';
  channel: PaymentDraft['channel'];
  amount: number; receivedAmount: number;
  codeUrl?: string | null; expireAt?: Date | null;
};

/**
 * 在同一事务内落支付单：
 * - 现金 / 线下扫码 / 储值 / 次卡 → 直接 success
 * - 在线渠道（wxpay_native / alipay_qr）→ pending + code_url（未配置通道抛 ConflictException('通道未启用')）
 * - 挂账（credit）不走本方法，由 ReceivablesService.createFromBooking 处理
 * 储值 / 次卡的余额与次数扣减由本方法内部完成（不产生渠道回调）。
 */
createInTx(tx: Tx, draft: PaymentDraft, actorId?: number | null): Promise<PaymentOutcome>;

/** 外部接口用：自己开事务（创建独立收款项，如充值、购卡、销账） */
create(draft: PaymentDraft, actorId?: number | null): Promise<PaymentOutcome>;

list(page, pageSize, filter): Promise<{ items; page; pageSize }>;
findOne(id): Promise<PaymentRow & { logs: PaymentLogRow[] }>;
statusOf(id: number): Promise<{ id: number; status: string; paidAt: Date | null }>;
queryChannel(id: number, actorId: number): Promise<{ status: string }>;
close(id: number, actorId: number): Promise<void>;
/** 渠道回调：验签 → 金额校验 → 条件更新 → 同事务发货；返回给渠道的应答体 */
handleNotify(channel: 'wxpay_native' | 'alipay_qr', raw: { headers: Record<string, string | string[] | undefined>; body: unknown }): Promise<{ statusCode: number; body: string }>;
closeExpired(): Promise<{ closed: number }>;
queryPending(): Promise<{ checked: number; settled: number }>;
reconcile(billDate: string): Promise<{ diffs: number }>;
```

### 2.4 `ReceivablesService`（挂账，B4）

```ts
/** 下单挂账（不写支付单）：校验额度 → 建应收单 → 回吐信息 */
createFromBooking(tx: Tx, input: {
  creditAccountId: number; bookingId: number; customerId: number; amount: number; actorId?: number | null;
}): Promise<{ receivableId: number; receivableNo: string; dueDate: string | null }>;
settle(receivableId: number, input: { payments: PaymentDraftLike[]; remark?: string; actorId: number }): Promise<{ settledAmount: number; status: string }>;
list(page, pageSize, filter): Promise<{ items; page; pageSize }>;
findOne(id): Promise<ReceivableRow & { payments: Row[] }>;
cancel(receivableId: number, reason: string, actorId: number): Promise<void>;
summary(): Promise<Row[]>;
markOverdue(): Promise<{ overdue: number }>;
assertCreditAvailable(tx: Tx, creditAccountId: number, amount: number): Promise<CreditAccountRow>;
```

### 2.5 `NoticesService`（通知，B5）

```ts
/** 事务后发送：内部捕获异常，失败只写 failed 日志，绝不抛出（不拖垮主流程） */
send(input: {
  templateCode: string; recipientType: 'customer' | 'user'; recipientId: number;
  variables: Record<string, string | number>; bookingId?: number | null; channels?: ('sms'|'site')[];
}): Promise<{ sent: number; failed: number; logIds: number[] }>;
/** 只落 pending 记录（回调事务内调用，避免事务里做网络 IO） */
enqueueInTx(tx: Tx, input: SendInput): Promise<number[]>;
retryFailed(): Promise<{ retried: number; succeeded: number }>;
assertTemplateVariables(template: { content: string; title?: string | null; variables?: unknown }): void;
```

### 2.6 `CommissionService`（提成，B4）

```ts
/** 预约完成时计提（幂等：同一 booking_item 已计提则跳过） */
accrueForBooking(tx: Tx, bookingId: number, actorId?: number | null): Promise<{ records: number; amount: number }>;
/** 退款 / 取消时冲销该预约的计提 */
reverseForBooking(tx: Tx, bookingId: number, reason: string, actorId?: number | null): Promise<{ reversed: number }>;
settle(period: string, actorId: number): Promise<{ batch: string; count: number; amount: number }>;
```

### 2.7 `SlotsService`（可约时段，B1）—— 唯一实现，后台与小程序共用

```ts
type SlotQuery = {
  staffId: number; date: string; serviceItemIds: number[];
  channel: 'admin' | 'miniapp'; timeZone?: string;
};
type SlotResult = {
  slots: { startAt: string; endAt: string }[];      // 带偏移的 ISO8601
  reason?: 'off' | 'no_shift' | 'staff_cannot_do' | 'fully_booked' | 'out_of_window';
  durationMinutes: number; bufferMinutes: number;
};
availableSlots(query: SlotQuery): Promise<SlotResult>;
/** 事务内冲突复检（`FOR UPDATE`，§6.2 硬约束 1） */
assertNoConflict(tx: Tx, input: { staffId: number; startAt: Date; durationMinutes: number; bufferMinutes: number; excludeBookingId?: number }): Promise<void>;
```

### 2.8 `BookingSettlementService`（资金重算，B1）

```ts
/** 金额事实的唯一重算入口（§15.7 不变量 4） */
recalc(tx: Tx, bookingId: number): Promise<{
  paidAmount: number; dueAmount: number; refundAmount: number;
  payStatus: 'unpaid' | 'partial' | 'paid' | 'refunded' | 'credit';
  channelSummary: string | null; settledAt: Date | null;
}>;
```

### 2.9 基础数据（B1）

```ts
ServiceItemsService: {
  list(page,pageSize,filter): ListResult; findOne(id); create(input,actorId): {id};
  update(id,input,actorId); remove(id,actorId);
  requireActiveItems(ids: number[], tx?: Tx): Promise<ServiceItemRow[]>;  // 去重后 1..3 个，缺失/停用抛 BadRequest
  listActive(): Promise<ServiceItemRow[]>;
}
StaffsService: {
  list(page,pageSize,filter): ListResult; findOne(id); create(input,actorId): {id}; update(id,input,actorId); remove(id,actorId);
  requireActive(id: number, tx?: Tx): Promise<StaffRow>;
  listActive(): Promise<StaffRow[]>;
  findByUserId(userId: number): Promise<StaffRow | null>;
  /** 空数组 = 可做全部（§22）；返回 null 表示「无限制」 */
  allowedServiceItemIds(staffId: number, tx?: Tx): Promise<number[] | null>;
  setServiceItems(staffId: number, ids: number[], actorId: number): Promise<void>;
  getServiceItems(staffId: number): Promise<{ id: number; name: string }[]>;
}
CustomersService: {
  list(page,pageSize,filter): ListResult; findOne(id); create(input,actorId): {id}; update(id,input,actorId); remove(id,actorId);
  requireById(id: number, tx?: Tx): Promise<CustomerRow>;
  listBookings(id,page,pageSize): ListResult;
  recount(id, actorId?): Promise<{visitCount:number;lastVisitAt:Date|null}>;
  findByPhone(phone: string): Promise<CustomerRow | null>;   // 不过滤软删（§4.3 坑 1）
  onBookingCompleted(tx: Tx, customerId: number): Promise<void>;  // 累加 visit_count / last_visit_at
  ensureMembership(tx: Tx, customerId: number, actorId?: number | null): Promise<{ memberNo: string; memberSince: Date }>;
}
SchedulingService: {
  getWeeklyShifts(staffId): Promise<WeeklyShiftRow[]>;
  replaceWeeklyShifts(staffId, shifts: {weekday:number;startTime:string;endTime:string}[], actorId): Promise<void>;
  listOverrides(staffId, filter: {from?:string;to?:string}): Promise<OverrideRow[]>;
  createOverride(staffId, input: {date:string;type:'off'|'custom';startTime?:string;endTime?:string;reason?:string}, actorId, force=false): Promise<{ id:number; conflicts: ConflictItem[] }>;
  deleteOverride(staffId, overrideId, actorId, force=false): Promise<{ conflicts: ConflictItem[] }>;
  /** 求值优先级：off → 当天不可约；custom → 替代周模板；否则周模板 */
  resolveShifts(staffId, date: string, tx?: Tx): Promise<{ off: boolean; segments: {startTime:string;endTime:string}[] }>;
  listConflicts(staffId, date, segments): Promise<ConflictItem[]>;   // ConflictItem = {id,bookingNo,startAt,endAt,customerName}
}
```

## 3. 禁止事项（评审红线）

1. 禁止改 `src/database/schema/index.ts` 与已有迁移；需要新字段先在交付说明里提出。
2. 禁止手写 SQL 迁移。
3. 禁止在 controller 里直接 `db.update(...)` 改金额 / 余额 / 积分 / 次数 —— 只能通过上表服务。
4. 禁止在事务内做网络 IO（短信、渠道下单/查单），一律事务后发送（§9.5 第 9 步）。
5. 禁止 `total` 字段；禁止 `new Date('YYYY-MM-DD')`；禁止驼峰权限点。
6. 定时任务**不碰钱**，只改状态与等级（§15.7 不变量 5）。
