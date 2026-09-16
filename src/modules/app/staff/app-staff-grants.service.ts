import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, desc, eq, isNull, ne } from 'drizzle-orm';
import { DatabaseService } from '../../../database/database.service';
import { appWxUsers, bizStaffs } from '../../../database/schema/index';
import { readCount } from '../../biz/common/query';

export type GrantStatus = 'pending' | 'active' | 'rejected';

export type GrantFilter = { status?: GrantStatus | undefined };

export type GrantItem = {
  /** `app_wx_user.id`：申请单号，approve / reject 用的就是这个 id */
  id: number;
  openid: string;
  nickname: string | null;
  phone: string | null;
  staffId: number | null;
  staffName: string | null;
  /** 档案在职状态（disabled / 已删除的档案即使批准也进不去工作台） */
  staffArchivedStatus: 'active' | 'disabled' | null;
  staffStatus: GrantStatus | 'none';
  staffRequestedAt: string | null;
  staffDecidedAt: string | null;
  staffRejectReason: string | null;
};

export type GrantDecision = {
  id: number;
  staffId: number | null;
  staffStatus: GrantStatus;
  staffDecidedAt: string | null;
};

/**
 * 店长侧「小程序工作台开通申请」（施工单 §12.5）。
 *
 * 这里读写的是 `app_wx_user`，但**不属于小程序端**：走后台 RBAC（`biz:staff:grant`），
 * 与 `AppStaffService.apply`（小程序端发起）刚好是这条流程的两端。
 *
 * 铁律：**批准不意味着永久有效** —— `AppStaffScopeGuard` 每个请求都会复查
 * `staff_status='active'` 且 `biz_staff.status='active'`，所以停用档案即撤权。
 */
@Injectable()
export class AppStaffGrantsService {
  constructor(private readonly database: DatabaseService) {}

  async list(
    page: number,
    pageSize: number,
    filter: GrantFilter,
  ): Promise<{
    items: GrantItem[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const where = and(
      isNull(appWxUsers.deletedAt),
      // `none` 是从没申请过的普通顾客，不该出现在店长的待办里
      ne(appWxUsers.staffStatus, 'none'),
      filter.status ? eq(appWxUsers.staffStatus, filter.status) : undefined,
    );
    const [rows, counted] = await Promise.all([
      this.database.db
        .select({
          id: appWxUsers.id,
          openid: appWxUsers.openid,
          nickname: appWxUsers.nickname,
          phone: appWxUsers.phone,
          staffId: appWxUsers.staffId,
          staffStatus: appWxUsers.staffStatus,
          staffRequestedAt: appWxUsers.staffRequestedAt,
          staffDecidedAt: appWxUsers.staffDecidedAt,
          staffRejectReason: appWxUsers.staffRejectReason,
          staffName: bizStaffs.nickname,
          staffArchivedStatus: bizStaffs.status,
        })
        .from(appWxUsers)
        .leftJoin(bizStaffs, eq(appWxUsers.staffId, bizStaffs.id))
        .where(where)
        .orderBy(desc(appWxUsers.staffRequestedAt), asc(appWxUsers.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      // count 带上同一个 leftJoin（select 里用到了 bizStaffs.nickname）
      this.database.db
        .select({ value: count() })
        .from(appWxUsers)
        .leftJoin(bizStaffs, eq(appWxUsers.staffId, bizStaffs.id))
        .where(where),
    ]);
    return {
      items: rows.map((row) => ({
        ...row,
        staffRequestedAt: row.staffRequestedAt?.toISOString() ?? null,
        staffDecidedAt: row.staffDecidedAt?.toISOString() ?? null,
      })),
      total: readCount(counted),
      page,
      pageSize,
    };
  }

  async approve(id: number, actorId: number): Promise<GrantDecision> {
    const grant = await this.requireGrant(id);
    if (grant.staffStatus === 'active') return this.decisionOf(grant, 'active');
    if (grant.staffStatus === 'rejected')
      throw new ConflictException('该申请已被驳回，请让对方在小程序端重新申请');
    if (!grant.staffId)
      throw new ConflictException('该申请未关联美甲师档案，无法批准');
    // 档案停用 / 已删除 → 批准了也进不去（守卫会挡），不如现在就讲清楚
    const staff = await this.findArchive(grant.staffId);
    if (!staff)
      throw new ConflictException('匹配到的美甲师档案已被删除，无法批准');
    if (staff.status !== 'active')
      throw new ConflictException('匹配到的美甲师档案已停用，请先恢复在职状态');

    return this.decide(id, grant.staffId, 'active', actorId, null);
  }

  async reject(
    id: number,
    reason: string,
    actorId: number,
  ): Promise<GrantDecision> {
    const grant = await this.requireGrant(id);
    if (!reason?.trim())
      throw new BadRequestException('驳回必须填写原因（申请人会看到）');
    if (grant.staffStatus === 'rejected')
      return this.decisionOf(grant, 'rejected');
    if (grant.staffStatus === 'active')
      throw new ConflictException(
        '已开通的授权不能驳回；如需撤权请停用对应的美甲师档案',
      );
    return this.decide(id, grant.staffId, 'rejected', actorId, reason.trim());
  }

  /* ---------------------------------------------------------------- *
   * 内部
   * ---------------------------------------------------------------- */

  private async requireGrant(id: number) {
    const [row] = await this.database.db
      .select({
        id: appWxUsers.id,
        staffId: appWxUsers.staffId,
        staffStatus: appWxUsers.staffStatus,
        staffDecidedAt: appWxUsers.staffDecidedAt,
      })
      .from(appWxUsers)
      .where(and(eq(appWxUsers.id, id), isNull(appWxUsers.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundException('申请不存在');
    return row;
  }

  private async findArchive(staffId: number) {
    const [row] = await this.database.db
      .select({ id: bizStaffs.id, status: bizStaffs.status })
      .from(bizStaffs)
      .where(and(eq(bizStaffs.id, staffId), isNull(bizStaffs.deletedAt)))
      .limit(1);
    return row ?? null;
  }

  private async decide(
    id: number,
    staffId: number | null,
    status: GrantStatus,
    actorId: number,
    rejectReason: string | null,
  ): Promise<GrantDecision> {
    const decidedAt = new Date();
    await this.database.db
      .update(appWxUsers)
      .set({
        staffStatus: status,
        staffDecidedAt: decidedAt,
        staffDecidedBy: actorId,
        staffRejectReason: rejectReason,
      })
      .where(and(eq(appWxUsers.id, id), isNull(appWxUsers.deletedAt)));
    return {
      id,
      staffId,
      staffStatus: status,
      staffDecidedAt: decidedAt.toISOString(),
    };
  }

  /** 已经是目标状态时**不重复写库**，直接回当前状态（幂等） */
  private decisionOf(
    grant: { id: number; staffId: number | null; staffDecidedAt: Date | null },
    status: GrantStatus,
  ): GrantDecision {
    return {
      id: grant.id,
      staffId: grant.staffId,
      staffStatus: status,
      staffDecidedAt: grant.staffDecidedAt?.toISOString() ?? null,
    };
  }
}
