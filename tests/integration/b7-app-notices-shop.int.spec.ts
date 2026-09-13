/**
 * app 域站内消息（收件箱）与门店档案。
 *
 * 这一组守三件事：
 * 1. **收件箱只出站内消息**：`channel='sms'` 的投递日志不该出现 —— 顾客不需要知道
 *    「系统给你发过短信」这种投递记录；
 * 2. **分类来自模板**（`sys_notice_template.category`），并且 `categories` 只列**该顾客
 *    收件箱里真实出现过的分类** —— 前端页签直接用，不能硬编码；
 * 3. **归属**：别人的消息标记不了已读（按 `recipient_id` 收口）；
 *    门店档案来自 `sys_config`，没配过时回落默认值而不是空字符串。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import multipart from '@fastify/multipart';
import { BizConfigService } from '../../src/modules/biz/common/biz-config.service.js';
import { createTestContext, type TestContext } from './harness.js';

let ctx: TestContext;

beforeAll(async () => {
  /**
   * 用例要在测试里打**真实 multipart**，而 harness 默认不注册 `@fastify/multipart`
   * （它的注释里写明「不注册 rate-limit / helmet / multipart，需要验时通过 `configure` 补」）。
   * 这里按 `main.ts` 的真实配置补上，限制值保持一致 —— 否则测的就不是线上那套。
   */
  ctx = await createTestContext({
    configure: async (app) => {
      await app.register(multipart, {
        limits: { files: 1, fileSize: 10 * 1024 * 1024 },
      });
    },
  });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.resetBusinessData();
});

async function seedBoundAppUser(
  openid: string,
  customerId: number | null,
): Promise<{ appUserId: number; token: string }> {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO app_wx_user (openid, customer_id, staff_status) VALUES (?, ?, 'none')`,
    [openid, customerId],
  );
  const appUserId = inserted.insertId;
  return { appUserId, token: await ctx.appToken(openid, appUserId) };
}

async function seedCustomer(name: string, phone: string): Promise<number> {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO biz_customer (name, phone) VALUES (?, ?)`,
    [name, phone],
  );
  return inserted.insertId;
}

/** 造一条模板（分类可指定；不传 = 模板没分类） */
async function seedTemplate(
  code: string,
  category: string | null,
): Promise<void> {
  await ctx.sql(
    `INSERT INTO sys_notice_template (code, name, channel, category, title, content, status)
     VALUES (?, ?, 'both', ?, ?, '模板内容', 'active')`,
    [code, `模板-${code}`, category, `标题-${code}`],
  );
}

/**
 * 造一条消息日志。
 *
 * `recipientType='customer'` + `channel='site'` 是收件箱的两个过滤条件，
 * 所以这里允许造出「短信日志」「发给店员的消息」来验证它们不会串进来。
 */
async function seedLog(input: {
  templateCode: string;
  recipientId: number;
  recipientType?: 'customer' | 'user';
  channel?: 'sms' | 'site';
  title?: string;
  readAt?: Date | null;
}): Promise<number> {
  const inserted = await ctx.sql<{ insertId: number }>(
    `INSERT INTO sys_notice_log
       (template_code, channel, recipient_type, recipient_id, title, content, status, read_at)
     VALUES (?, ?, ?, ?, ?, '正文内容', 'success', ?)`,
    [
      input.templateCode,
      input.channel ?? 'site',
      input.recipientType ?? 'customer',
      input.recipientId,
      input.title ?? `标题-${input.templateCode}`,
      input.readAt ?? null,
    ],
  );
  return inserted.insertId;
}

describe('B6 站内消息 /app/notices', () => {
  it('收件箱：只出本人的站内消息；短信日志与店员消息都不出现', async () => {
    const customerId = await seedCustomer('李女士', '13800009001');
    const { token } = await seedBoundAppUser('openid-notice-1', customerId);
    await seedTemplate('booking_created', '预约提醒');
    await seedTemplate('member_recharged', '账户通知');

    await seedLog({ templateCode: 'booking_created', recipientId: customerId });
    await seedLog({
      templateCode: 'member_recharged',
      recipientId: customerId,
    });
    // 不该出现的三种
    await seedLog({
      templateCode: 'booking_created',
      recipientId: customerId,
      channel: 'sms',
    });
    await seedLog({
      templateCode: 'booking_created',
      recipientId: customerId,
      recipientType: 'user',
    });
    await seedLog({ templateCode: 'booking_created', recipientId: 999999 });

    const res = await ctx.request('GET', '/api/v1/app/notices', { token });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(Object.keys(res.body.items[0]).sort()).toEqual(
      [
        'bookingId',
        'category',
        'content',
        'createdAt',
        'id',
        'readAt',
        'title',
      ].sort(),
    );
    expect(res.body.unread).toBe(2);
    // 分类清单来自模板，且只含本顾客出现过的
    expect(res.body.categories).toEqual(['账户通知', '预约提醒'].sort());
  });

  it('分类筛选 + 未读数；模板没分类的消息仍在「全部」里', async () => {
    const customerId = await seedCustomer('李女士', '13800009002');
    const { token } = await seedBoundAppUser('openid-notice-2', customerId);
    await seedTemplate('booking_remind', '预约提醒');
    await seedTemplate('orphan_template', null);

    await seedLog({ templateCode: 'booking_remind', recipientId: customerId });
    await seedLog({
      templateCode: 'orphan_template',
      recipientId: customerId,
      readAt: new Date(),
    });

    const all = await ctx.request('GET', '/api/v1/app/notices', { token });
    expect(all.body.items).toHaveLength(2);
    // 未读数只算未读的
    expect(all.body.unread).toBe(1);
    // 没分类的不进页签（宁可少一个页签，不可少一条消息）
    expect(all.body.categories).toEqual(['预约提醒']);

    const filtered = await ctx.request(
      'GET',
      '/api/v1/app/notices?category=预约提醒',
      { token },
    );
    expect(filtered.body.items).toHaveLength(1);
    expect(filtered.body.items[0].title).toBe('标题-booking_remind');
    // 筛选时清单仍是全量，否则切一次分类其它页签就消失了
    expect(filtered.body.categories).toEqual(['预约提醒']);
  });

  it('标记已读：单条幂等、返回剩余未读数；别人的消息标不了', async () => {
    const mineId = await seedCustomer('我', '13800009003');
    const otherId = await seedCustomer('别人', '13800009004');
    const mine = await seedBoundAppUser('openid-notice-3a', mineId);
    // 别人的身份（只用来造一条属于他的消息）
    await seedBoundAppUser('openid-notice-3b', otherId);
    await seedTemplate('booking_created', '预约提醒');
    const mineLog = await seedLog({
      templateCode: 'booking_created',
      recipientId: mineId,
    });
    const otherLog = await seedLog({
      templateCode: 'booking_created',
      recipientId: otherId,
    });

    const read = await ctx.request(
      'POST',
      `/api/v1/app/notices/${mineLog}/read`,
      { token: mine.token },
    );
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ updated: 1, unread: 0 });

    // 再来一次：已读的不重复更新（updated = 0），不是错误
    const again = await ctx.request(
      'POST',
      `/api/v1/app/notices/${mineLog}/read`,
      { token: mine.token },
    );
    expect(again.status).toBe(200);
    expect(again.body.updated).toBe(0);

    // 别人的消息：我的 token 标不动它
    const foreign = await ctx.request(
      'POST',
      `/api/v1/app/notices/${otherLog}/read`,
      { token: mine.token },
    );
    expect(foreign.status).toBe(200);
    expect(foreign.body.updated).toBe(0);
    const rows = await ctx.sql<{ read_at: Date | null }[]>(
      `SELECT read_at FROM sys_notice_log WHERE id = ?`,
      [otherLog],
    );
    expect(rows[0]!.read_at).toBeNull();
  });

  it('全部已读：不传分类 = 全清；传分类 = 只清该分类的未读', async () => {
    const customerId = await seedCustomer('李女士', '13800009005');
    const { token } = await seedBoundAppUser('openid-notice-4', customerId);
    await seedTemplate('booking_created', '预约提醒');
    await seedTemplate('member_recharged', '账户通知');
    await seedLog({ templateCode: 'booking_created', recipientId: customerId });
    await seedLog({
      templateCode: 'member_recharged',
      recipientId: customerId,
    });

    // 只清「预约提醒」
    const partial = await ctx.request(
      'POST',
      '/api/v1/app/notices/read-all?category=预约提醒',
      { token },
    );
    expect(partial.status).toBe(200);
    expect(partial.body.updated).toBe(1);
    expect(partial.body.unread).toBe(1);

    // 剩下那条（账户通知）还在未读里
    const left = await ctx.request('GET', '/api/v1/app/notices', { token });
    expect(left.body.unread).toBe(1);
    expect(
      (left.body.items as { readAt: string | null }[]).filter(
        (item) => item.readAt === null,
      ),
    ).toHaveLength(1);

    // 全清
    const all = await ctx.request('POST', '/api/v1/app/notices/read-all', {
      token,
    });
    expect(all.body.updated).toBe(1);
    expect(all.body.unread).toBe(0);
  });

  it('未绑定手机号 → 400 + needBind（消息是发给具体顾客的）', async () => {
    const { token } = await seedBoundAppUser('openid-notice-5', null);
    const res = await ctx.request('GET', '/api/v1/app/notices', { token });
    expect(res.status).toBe(400);
    expect(res.body.needBind).toBe(true);
  });
});

describe('B6 取消预约的费用预览 /app/bookings/:id/refund-preview', () => {
  /** 造一笔已付定金的预约（判责只看 `start_at`，已付金额来自**成功支付单**） */
  async function seedPaidBooking(input: {
    bookingNo: string;
    customerId: number;
    startAtSql: string;
    paidAmount: number;
  }): Promise<number> {
    const staff = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_staff (nickname, phone, status) VALUES (?, ?, 'active')`,
      [`美甲师-${input.bookingNo}`, `139${input.bookingNo.slice(-8)}`],
    );
    const inserted = await ctx.sql<{ insertId: number }>(
      `INSERT INTO biz_booking
         (store_id, booking_no, customer_id, staff_id, start_at, end_at, duration_minutes,
          customer_name, status, pay_status, paid_amount, due_amount)
       VALUES ((SELECT id FROM sys_store WHERE is_default = 1 LIMIT 1), ?, ?, ?, ${input.startAtSql}, DATE_ADD(${input.startAtSql}, INTERVAL 1 HOUR), 60,
               '李女士', 'confirmed', 'partial', ?, 10000)`,
      [input.bookingNo, input.customerId, staff.insertId, input.paidAmount],
    );
    // 判责的「已付金额」读的是**成功支付单**的实收，不是 booking.paid_amount
    // （派生字段只由结算链路写，这里照真实链路造一条支付单）
    await ctx.sql(
      `INSERT INTO biz_payment
         (store_id, payment_no, out_trade_no, booking_id, customer_id, channel, amount,
          received_amount, status, paid_at)
       VALUES ((SELECT id FROM sys_store WHERE is_default = 1 LIMIT 1), ?, ?, ?, ?, 'cash', ?, ?, 'success', NOW())`,
      [
        `P-${input.bookingNo}`,
        `OUT-${input.bookingNo}`,
        inserted.insertId,
        input.customerId,
        input.paidAmount,
        input.paidAmount,
      ],
    );
    return inserted.insertId;
  }

  it('按门店政策算真实可退 / 扣除金额（≥24h 全退）', async () => {
    const customerId = await seedCustomer('李女士', '13800009010');
    const { token } = await seedBoundAppUser('openid-refund-1', customerId);
    await ctx.sql(
      `INSERT INTO biz_refund_policy (name, hours_before, refund_permille, min_amount, sort, status)
       VALUES ('24 小时以上全退', 24, 1000, 0, 1, 'active'),
              ('2-24 小时退一半', 2, 500, 0, 2, 'active'),
              ('2 小时内不退', 0, 0, 0, 3, 'active')`,
    );
    const bookingId = await seedPaidBooking({
      bookingNo: 'B20260914001',
      customerId,
      startAtSql: 'DATE_ADD(NOW(), INTERVAL 48 HOUR)',
      paidAmount: 30000,
    });

    const res = await ctx.request(
      'GET',
      `/api/v1/app/bookings/${bookingId}/refund-preview`,
      { token },
    );
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      [
        'deductAmount',
        'hoursToStart',
        'paidAmount',
        'policyName',
        'refundPermille',
        'suggestAmount',
      ].sort(),
    );
    expect(res.body.paidAmount).toBe(30000);
    expect(res.body.refundPermille).toBe(1000);
    expect(res.body.suggestAmount).toBe(30000);
    expect(res.body.deductAmount).toBe(0);
    expect(res.body.policyName).toBe('24 小时以上全退');
  });

  it('临近开始：按「退一半」算，且金额全部由服务端给', async () => {
    const customerId = await seedCustomer('李女士', '13800009011');
    const { token } = await seedBoundAppUser('openid-refund-2', customerId);
    await ctx.sql(
      `INSERT INTO biz_refund_policy (name, hours_before, refund_permille, min_amount, sort, status)
       VALUES ('24 小时以上全退', 24, 1000, 0, 1, 'active'),
              ('2-24 小时退一半', 2, 500, 0, 2, 'active'),
              ('2 小时内不退', 0, 0, 0, 3, 'active')`,
    );
    const bookingId = await seedPaidBooking({
      bookingNo: 'B20260914002',
      customerId,
      startAtSql: 'DATE_ADD(NOW(), INTERVAL 5 HOUR)',
      paidAmount: 30000,
    });

    const res = await ctx.request(
      'GET',
      `/api/v1/app/bookings/${bookingId}/refund-preview`,
      { token },
    );
    expect(res.status).toBe(200);
    expect(res.body.refundPermille).toBe(500);
    expect(res.body.suggestAmount).toBe(15000);
    expect(res.body.deductAmount).toBe(15000);
    expect(res.body.policyName).toBe('2-24 小时退一半');
  });

  it('越权：别人的预约 → 404（不是 403）；不存在的预约同样 404', async () => {
    const mineId = await seedCustomer('我', '13800009012');
    const otherId = await seedCustomer('别人', '13800009013');
    const mine = await seedBoundAppUser('openid-refund-3a', mineId);
    await seedBoundAppUser('openid-refund-3b', otherId);
    await ctx.sql(
      `INSERT INTO biz_refund_policy (name, hours_before, refund_permille, min_amount, sort, status)
       VALUES ('24 小时以上全退', 24, 1000, 0, 1, 'active')`,
    );
    const otherBooking = await seedPaidBooking({
      bookingNo: 'B20260914003',
      customerId: otherId,
      startAtSql: 'DATE_ADD(NOW(), INTERVAL 48 HOUR)',
      paidAmount: 20000,
    });

    const foreign = await ctx.request(
      'GET',
      `/api/v1/app/bookings/${otherBooking}/refund-preview`,
      { token: mine.token },
    );
    expect(foreign.status).toBe(404);

    const missing = await ctx.request(
      'GET',
      '/api/v1/app/bookings/999999/refund-preview',
      { token: mine.token },
    );
    expect(missing.status).toBe(404);
  });
});

describe('B6 意见反馈 /app/feedback', () => {
  const BODY = {
    type: '体验建议',
    content: '希望可以按美甲师筛选档期，现在只能一个个点进去看',
  };

  it('实名提交：落库并带上顾客身份', async () => {
    const customerId = await seedCustomer('李女士', '13800009020');
    const { token } = await seedBoundAppUser('openid-feedback-1', customerId);

    const res = await ctx.request('POST', '/api/v1/app/feedback', {
      token,
      body: { ...BODY, contact: '13800009020' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: expect.any(Number), anonymous: false });

    const [row] = await ctx.sql<
      {
        customer_id: number | null;
        type: string;
        content: string;
        contact: string | null;
        is_anonymous: number;
        status: string;
      }[]
    >(
      `SELECT customer_id, type, content, contact, is_anonymous, status
         FROM biz_feedback WHERE id = ?`,
      [res.body.id],
    );
    expect(row!.customer_id).toBe(customerId);
    expect(row!.type).toBe('体验建议');
    expect(row!.content).toBe(BODY.content);
    expect(row!.contact).toBe('13800009020');
    expect(Number(row!.is_anonymous)).toBe(0);
    // 新反馈一律「待处理」，门店在后台跟进
    expect(row!.status).toBe('pending');
  });

  it('匿名提交：**不写 customer_id**（记了身份再标匿名等于骗人）', async () => {
    const customerId = await seedCustomer('李女士', '13800009021');
    const { token } = await seedBoundAppUser('openid-feedback-2', customerId);

    const res = await ctx.request('POST', '/api/v1/app/feedback', {
      token,
      body: { ...BODY, anonymous: true },
    });
    expect(res.status).toBe(200);
    expect(res.body.anonymous).toBe(true);

    const [row] = await ctx.sql<
      { customer_id: number | null; is_anonymous: number }[]
    >(`SELECT customer_id, is_anonymous FROM biz_feedback WHERE id = ?`, [
      res.body.id,
    ]);
    expect(row!.customer_id).toBeNull();
    expect(Number(row!.is_anonymous)).toBe(1);
  });

  it('未绑定手机号也能提交（访客也有意见要说），此时不记身份', async () => {
    const { token } = await seedBoundAppUser('openid-feedback-3', null);
    const res = await ctx.request('POST', '/api/v1/app/feedback', {
      token,
      body: BODY,
    });
    expect(res.status).toBe(200);

    const [row] = await ctx.sql<{ customer_id: number | null }[]>(
      `SELECT customer_id FROM biz_feedback WHERE id = ?`,
      [res.body.id],
    );
    expect(row!.customer_id).toBeNull();
  });

  it('入参：白名单外字段 400、内容太短 400、类型必填', async () => {
    const customerId = await seedCustomer('李女士', '13800009022');
    const { token } = await seedBoundAppUser('openid-feedback-4', customerId);

    for (const body of [
      { ...BODY, customerId: 999 }, // 身份由 token 决定
      { ...BODY, status: 'resolved' }, // 状态是门店侧的
      { ...BODY, content: '太短' }, // 少于 5 个字
      { type: '', content: BODY.content },
      { content: BODY.content }, // 类型必填
    ]) {
      const res = await ctx.request('POST', '/api/v1/app/feedback', {
        token,
        body,
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    // 全部被拒 → 一条都没落
    const rows = await ctx.sql<{ total: number }[]>(
      `SELECT COUNT(*) AS total FROM biz_feedback`,
    );
    expect(Number(rows[0].total)).toBe(0);
  });

  it('带截图：图片地址落库；超过 3 张或空数组的处理', async () => {
    const customerId = await seedCustomer('李女士', '13800009023');
    const { token } = await seedBoundAppUser('openid-feedback-5', customerId);

    const withImages = await ctx.request('POST', '/api/v1/app/feedback', {
      token,
      body: {
        ...BODY,
        images: ['/api/v1/files/1/download', '/api/v1/files/2/download'],
      },
    });
    expect(withImages.status).toBe(200);
    const [row] = await ctx.sql<{ images: unknown }[]>(
      `SELECT images FROM biz_feedback WHERE id = ?`,
      [withImages.body.id],
    );
    // mysql2 会把 JSON 列直接解析成数组，也可能给原始字符串 —— 两种都兜住
    const parsed =
      typeof row!.images === 'string'
        ? (JSON.parse(row!.images) as string[])
        : (row!.images as string[]);
    expect(parsed).toEqual([
      '/api/v1/files/1/download',
      '/api/v1/files/2/download',
    ]);

    // 超过 3 张直接 400（设计稿三格图位，多传说明前端在乱塞）
    const tooMany = await ctx.request('POST', '/api/v1/app/feedback', {
      token,
      body: {
        ...BODY,
        images: ['/a', '/b', '/c', '/d'],
      },
    });
    expect(tooMany.status).toBe(400);

    // 空数组 = 没传图：存 null，而不是空 JSON（前端判空只判一种值）
    const empty = await ctx.request('POST', '/api/v1/app/feedback', {
      token,
      body: { ...BODY, images: [] },
    });
    expect(empty.status).toBe(200);
    const [emptyRow] = await ctx.sql<{ images: string | null }[]>(
      `SELECT images FROM biz_feedback WHERE id = ?`,
      [empty.body.id],
    );
    expect(emptyRow!.images).toBeNull();
  });
});

describe('B6 C 端图片上传 /app/upload', () => {
  /** 1×1 的合法 PNG（真实字节，避免用假数据绕过图片解析） */
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/gGr' +
      'HwAAAABJRU5ErkJggg==',
    'base64',
  );

  /** 手工拼一个 multipart 请求体（Fastify inject 需要原始 payload） */
  function multipart(
    filename: string,
    mime: string,
    content: Buffer,
  ): { boundary: string; payload: Buffer } {
    const boundary = '----dshAppUploadBoundary';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `Content-Type: ${mime}\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return { boundary, payload };
  }

  it('上传图片：200 + 可访问的 url；下载回来就是图片', async () => {
    const customerId = await seedCustomer('李女士', '13800009030');
    const { token } = await seedBoundAppUser('openid-upload-1', customerId);
    const { boundary, payload } = multipart('shot.png', 'image/png', PNG);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/app/upload',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      id: number;
      url: string;
      mime: string;
      size: number;
    };
    expect(body.mime).toBe('image/png');
    expect(body.size).toBe(PNG.length);
    // url 是相对路径（小程序侧用 absoluteAssetUrl 拼接口域名）
    expect(body.url).toBe(`/api/v1/files/${body.id}/download`);

    // 再把这个 url 下回来：能拿到图片字节，证明真的落盘了
    const download = await ctx.app.inject({ method: 'GET', url: body.url });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toContain('image/png');
    expect(Buffer.from(download.rawPayload).length).toBe(PNG.length);
  });

  it('只收图片：文本文件 400；不带 app token 401', async () => {
    const customerId = await seedCustomer('李女士', '13800009031');
    const { token } = await seedBoundAppUser('openid-upload-2', customerId);

    const text = multipart(
      'note.txt',
      'text/plain',
      Buffer.from('not an image'),
    );
    const rejected = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/app/upload',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': `multipart/form-data; boundary=${text.boundary}`,
      },
      payload: text.payload,
    });
    expect(rejected.statusCode).toBe(400);
    expect(JSON.parse(rejected.body).message).toContain('图片');

    const png = multipart('shot.png', 'image/png', PNG);
    const noToken = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/app/upload',
      headers: {
        'content-type': `multipart/form-data; boundary=${png.boundary}`,
      },
      payload: png.payload,
    });
    expect(noToken.statusCode).toBe(401);
  });
});

describe('B6 门店档案 /app/shop', () => {
  it('未配置时回落内置默认值（不是空字符串），且不要求绑定手机号', async () => {
    const { token } = await seedBoundAppUser('openid-shop-1', null);
    // 先把 seed 写进去的默认值删掉，才验得到「完全没配」这条路径
    await ctx.sql(`DELETE FROM sys_config WHERE config_key LIKE 'biz.shop.%'`);
    // 配置有 10 秒缓存：删完要让它失效，否则读到的是上一个用例写进去的值
    ctx.app.get(BizConfigService).invalidate();

    const res = await ctx.request('GET', '/api/v1/app/shop', { token });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('美甲小铺');
    expect(res.body.nameEn).toBe('BEAUTY NAILS');
    expect(res.body.hours).toBe('10:00 - 20:00');
    expect(res.body.address).toContain('南京西路');
    // 经纬度是数字（前端直接拿去导航，不该是字符串）
    expect(typeof res.body.latitude).toBe('number');
    expect(typeof res.body.longitude).toBe('number');
    // 门店没写公告 → null（前端只判一种空值）
    expect(res.body.notice).toBeNull();
  });

  it('门店在后台改了门店档案，小程序读到新值（不用发版）', async () => {
    const { token } = await seedBoundAppUser('openid-shop-2', null);
    /**
     * 阶段 0 起**门店表是唯一事实来源**（`sys_store` 优先、`biz.shop.*` 只兜底未填字段），
     * 所以这里改的是门店表 —— 也就是后台「门店管理」改的那张表。
     * 顺带验「即时生效」：门店读取不走配置缓存（10 秒 TTL），改完下一次请求就是新值。
     */
    await ctx.sql(
      `UPDATE sys_store SET phone = '021-8888-9999', notice = '本周三店休，请提前改约'
        WHERE is_default = 1`,
    );

    const res = await ctx.request('GET', '/api/v1/app/shop', { token });
    expect(res.status).toBe(200);
    expect(res.body.phone).toBe('021-8888-9999');
    expect(res.body.notice).toBe('本周三店休，请提前改约');
    // 没改的字段仍然是原来的值
    expect(res.body.name).toBeTruthy();

    // 复原，免得污染后面的用例（门店是 `sys_*`，resetBusinessData 不清它）
    await ctx.sql(
      `UPDATE sys_store SET phone = '13800000000', notice = NULL WHERE is_default = 1`,
    );
  });
});
