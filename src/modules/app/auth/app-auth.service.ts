import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { AppConfigService } from '../../../config/app-config.service.js';
import { DatabaseService } from '../../../database/database.service.js';
import { appWxUsers } from '../../../database/schema/index.js';
import { CustomerPort, StaffPort } from '../../biz/common/ports.js';
import type {
  AppBindPhoneRequest,
  AppBindPhoneVo,
  AppLoginRequest,
  AppLoginVo,
} from '../dto/app-vo.js';
import { WxMiniappProvider } from './wx-miniapp.provider.js';

/**
 * 小程序顾客档案自建时的 `created_by`（`biz_customer.created_by` 无外键约束）。
 * 用 0 表示「小程序/系统代建」，与后台操作者（`sys_user.id`）区分开，便于事后审计。
 */
const APP_ACTOR_ID = 0;

/** 身份记录快照（去掉了不必要的外传字段） */
type AppIdentity = {
  id: number;
  nickname: string | null;
  customerId: number | null;
  staffId: number | null;
  staffStatus: 'none' | 'pending' | 'active' | 'rejected';
};

/**
 * 小程序端认证（spec §16.2）。
 *
 * - `login`：`code` → `openid` → upsert `app_wx_user`（openid 唯一，重复登录不产生第二条身份）
 *   → 签发 app token（`scope: 'app'`）；
 * - `bindPhone`：`getPhoneNumber` 的 code → 手机号 → 匹配/创建 `biz_customer` → 绑定锚点；
 *   同时**探测**美甲师档案，但**绝不自动开通工作台**（须店长后台确认）。
 *
 * 微信能力全部走 `WxMiniappProvider` 端口：凭据未配置时可注入假实现，
 * 让上述业务分支（软删顾客、并发首登、美甲师候选）都能被离线测试覆盖。
 */
@Injectable()
export class AppAuthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: AppConfigService,
    private readonly wx: WxMiniappProvider,
    private readonly customers: CustomerPort,
    private readonly staffs: StaffPort,
  ) {}

  async login(input: AppLoginRequest): Promise<AppLoginVo> {
    const now = new Date();
    const session = await this.wx.code2Session(input.code);

    // upsert：openid 唯一索引 + ON DUPLICATE KEY UPDATE，
    // 并发登录也不会产生第二条身份记录（幂等）
    await this.database.db
      .insert(appWxUsers)
      .values({
        openid: session.openid,
        unionid: session.unionid,
        nickname: input.nickname ?? null,
        avatar: input.avatar ?? null,
        lastLoginAt: now,
      })
      .onDuplicateKeyUpdate({
        set: {
          lastLoginAt: now,
          // 身份记录若曾被软删，重新登录即恢复（同一 openid 永远只有一行）
          deletedAt: null,
          ...(session.unionid ? { unionid: session.unionid } : {}),
          ...(input.nickname ? { nickname: input.nickname } : {}),
          ...(input.avatar ? { avatar: input.avatar } : {}),
        },
      });

    const identity = await this.requireIdentityByOpenid(session.openid);

    return {
      accessToken: await this.signAppToken(identity.id, session.openid),
      tokenType: 'Bearer',
      expiresIn: this.config.jwt.JWT_ACCESS_TTL,
      customerId: identity.customerId,
      staffId: identity.staffId,
      staffStatus: identity.staffStatus,
    };
  }

  /**
   * 手机号绑定。
   *
   * 分四步，顺序有讲究：
   * 1. **先落手机号快照**（`app_wx_user.phone`）——与「绑定顾客」解耦。
   *    这样即使命中软删档案需要用户确认，也不必再弹一次微信授权
   *    （`getPhoneNumber` 的 code 是一次性的，无法复用，**不能**设计成「先换号、让用户确认、再用同一个 code 继续」）。
   * 2. 按手机号匹配顾客档案（`findByPhone` **不过滤软删**）。
   * 3. 命中**软删**档案 → 抛 409 并带回 `needRestoreConfirm`，**不自动恢复**：
   *    恢复会带回余额/积分/次卡历史，属于数据完整性动作，交门店在后台确认。
   * 4. 探测美甲师档案，只返回候选：能否进工作台由店长在后台决定。
   */
  async bindPhone(
    appUserId: number,
    input: AppBindPhoneRequest,
  ): Promise<AppBindPhoneVo> {
    const identity = await this.requireIdentityById(appUserId);
    const { phone } = await this.wx.getPhoneNumber(input.code);

    await this.database.db
      .update(appWxUsers)
      .set({ phone })
      .where(eq(appWxUsers.id, appUserId));

    const existing = await this.customers.findByPhone(phone);

    if (existing && existing.deletedAt) {
      throw new ConflictException({
        message:
          `该手机号的历史档案已被门店删除（顾客 #${existing.id}` +
          `${existing.name ? ` ${existing.name}` : ''}），请联系门店恢复后再绑定`,
        needRestoreConfirm: true,
        customerId: existing.id,
      });
    }

    let customerId: number;
    let created = false;
    if (existing) {
      customerId = existing.id;
    } else {
      // 有手机号即为会员档（§4.3）；但 `member_no` / `member_since` 的生成
      // 由会员账务链路的 `ensureMembership` 在首次储值/消费时完成，
      // 这里不重复实现（`member-accounts.service.ts` 已有调用）。
      const result = await this.customers.create(
        {
          name: identity.nickname ?? `微信顾客${phone.slice(-4)}`,
          phone,
        },
        APP_ACTOR_ID,
      );
      customerId = result.id;
      created = true;
    }

    // 换绑覆盖旧关系：一个 openid 同时只绑定一个 customer_id
    await this.database.db
      .update(appWxUsers)
      .set({ customerId })
      .where(eq(appWxUsers.id, appUserId));

    const staff = await this.staffs.findByPhone(phone);
    const staffCandidate =
      staff && !staff.deletedAt && staff.status === 'active'
        ? { id: staff.id, nickname: staff.nickname }
        : null;

    return {
      customerId,
      created,
      staffId: identity.staffId,
      staffStatus: identity.staffStatus,
      staffCandidate,
    };
  }

  private readonly identityColumns = {
    id: appWxUsers.id,
    nickname: appWxUsers.nickname,
    customerId: appWxUsers.customerId,
    staffId: appWxUsers.staffId,
    staffStatus: appWxUsers.staffStatus,
  };

  private async requireIdentityByOpenid(openid: string): Promise<AppIdentity> {
    const [identity] = await this.database.db
      .select(this.identityColumns)
      .from(appWxUsers)
      .where(eq(appWxUsers.openid, openid))
      .limit(1);
    if (!identity) throw new UnauthorizedException('小程序端登录失败');
    return identity;
  }

  private async requireIdentityById(appUserId: number): Promise<AppIdentity> {
    const [identity] = await this.database.db
      .select(this.identityColumns)
      .from(appWxUsers)
      .where(and(eq(appWxUsers.id, appUserId), isNull(appWxUsers.deletedAt)))
      .limit(1);
    if (!identity) throw new UnauthorizedException('身份不存在，请重新进入小程序');
    return identity;
  }

  /**
   * 签发 app 域 access token。
   *
   * - 与后台共用 `JWT_ACCESS_SECRET` / `issuer` / `audience`（配置复用）；
   * - payload 带 `scope: 'app'` → `AppAccessTokenGuard` 才认；
   * - **故意不写 `username`** → 后台 `AccessTokenGuard` 因
   *   `typeof payload.username === 'string'` 不成立而自然拒绝（双向隔离，见 §8.3）；
   * - **故意不写角色**：美甲师权限每请求从库校验（停用/撤权立即失效），
   *   放进 token 会有一段「已撤权但 token 仍有效」的窗口。
   */
  private async signAppToken(
    appUserId: number,
    openid: string,
  ): Promise<string> {
    return new SignJWT({ scope: 'app', openid })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(appUserId))
      .setIssuedAt()
      .setIssuer(this.config.jwt.JWT_ISSUER)
      .setAudience(this.config.jwt.JWT_AUDIENCE)
      .setExpirationTime(this.config.jwt.JWT_ACCESS_TTL)
      .sign(new TextEncoder().encode(this.config.jwt.JWT_ACCESS_SECRET));
  }
}
