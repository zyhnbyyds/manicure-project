import { BadRequestException, Injectable } from '@nestjs/common';
import {
  BookingPort,
  CommissionPort,
  ReviewPort,
  SchedulePort,
  StaffPort,
} from '../../biz/common/ports.js';
import {
  maskPhone,
  type AppStaffMeVo,
  type AppStaffPerformanceVo,
  type AppStaffScheduleVo,
} from '../dto/app-staff-workbench.vo.js';

/** `yyyyMM`，与提成记录的 period 同一口径 */
const PERIOD_PATTERN = /^\d{6}$/;

/**
 * 美甲师工作台只读面（S3）。
 *
 * 全部方法**第一件事就是吃 `staffId`**，不存在「传进来再校验是不是本人」：
 * 调用方只能从 `AppStaffScopeGuard` 拿到自己的 id（§12.4-2）。
 * 这里也**不复用后台的数据权限**——美甲师不是 sys_user，套角色/部门口径会算错。
 */
@Injectable()
export class AppStaffWorkbenchService {
  // 注入名一律带 `Port` 后缀：与方法名（bookings / schedule / reviews）区分开
  constructor(
    private readonly staffPort: StaffPort,
    private readonly bookingPort: BookingPort,
    private readonly schedulePort: SchedulePort,
    private readonly commissionPort: CommissionPort,
    private readonly reviewPort: ReviewPort,
  ) {}

  async me(staffId: number): Promise<AppStaffMeVo> {
    const staff = await this.staffPort.findOne(staffId);
    return {
      staffId: staff.id,
      nickname: staff.nickname,
      avatar: staff.avatar,
      // 自己的手机号也脱敏：小程序端只是展示，不需要明文
      phone: maskPhone(staff.phone),
      bio: staff.bio,
      staffStatus: 'active',
      allowedServiceItemIds:
        await this.staffPort.allowedServiceItemIds(staffId),
    };
  }

  async bookings(
    staffId: number,
    page: number,
    pageSize: number,
    filter: { date?: string | undefined; status?: string | undefined },
  ) {
    const result = await this.bookingPort.listByStaff(staffId, page, pageSize, {
      date: filter.date,
      status: filter.status as never,
    });
    return {
      page: result.page,
      pageSize: result.pageSize,
      items: result.items.map((booking) => ({
        id: booking.id,
        bookingNo: booking.bookingNo,
        customerName: booking.customerName,
        customerPhoneMasked: maskPhone(booking.customerPhone),
        startAt: booking.startAt.toISOString(),
        endAt: booking.endAt.toISOString(),
        status: booking.status,
        payStatus: booking.payStatus,
        payableAmount: booking.payableAmount,
        paidAmount: booking.paidAmount,
        dueAmount: booking.dueAmount,
        remark: booking.remark,
        items: booking.items.map((item) => ({
          serviceItemId: item.serviceItemId,
          name: item.name,
          price: item.price,
          durationMinutes: item.durationMinutes,
        })),
      })),
    };
  }

  async schedule(staffId: number, date: string): Promise<AppStaffScheduleVo> {
    /*
     * 工作台看的是**通用班次**（不传门店）：美甲师在多家店有专属班次时，这里只反映
     * 「不分店的那一层」。要按门店分层看班次请用排班页 —— 工作台按店显示是下一批的事
     * （见 `dev-docs/data/multi-store.md` 的「还没做」）。
     */
    const [shifts, overrides] = await Promise.all([
      this.schedulePort.resolveShifts(staffId, date),
      this.schedulePort.listOverrides(staffId, { from: date, to: date }),
    ]);
    return {
      date,
      off: shifts.off,
      segments: shifts.segments,
      overrides: overrides.map((item) => ({
        id: item.id,
        date: item.date,
        type: item.type,
        startTime: item.startTime,
        endTime: item.endTime,
        reason: item.reason,
      })),
    };
  }

  async performance(
    staffId: number,
    period?: string | undefined,
  ): Promise<AppStaffPerformanceVo> {
    if (period !== undefined && !PERIOD_PATTERN.test(period))
      throw new BadRequestException('period 必须是 yyyyMM，例如 202609');
    const [summary, commission, rating] = await Promise.all([
      this.bookingPort.performanceByStaff(staffId, period),
      this.commissionPort.listByStaff(staffId, period),
      this.reviewPort.averageScore(staffId),
    ]);
    const totals = await this.commissionPort.summarizeByStaff(staffId, period);
    return {
      period: summary.period,
      completedCount: summary.completedCount,
      paidAmount: summary.paidAmount,
      commission: totals,
      rating,
      items: commission.map((item) => ({
        id: item.id,
        bookingId: item.bookingId,
        bookingNo: item.bookingNo,
        serviceItemName: item.serviceItemName,
        baseAmount: item.baseAmount,
        amount: item.amount,
        period: item.period,
        status: item.status,
        settledAt: item.settledAt?.toISOString() ?? null,
      })),
    };
  }

  async reviews(staffId: number, page: number, pageSize: number) {
    const result = await this.reviewPort.listByStaff(staffId, page, pageSize);
    return {
      page: result.page,
      pageSize: result.pageSize,
      items: result.items.map((review) => ({
        id: review.id,
        bookingId: review.bookingId,
        bookingNo: review.bookingNo,
        score: review.score,
        content: review.content,
        reply: review.reply,
        createdAt: review.createdAt.toISOString(),
      })),
    };
  }
}
