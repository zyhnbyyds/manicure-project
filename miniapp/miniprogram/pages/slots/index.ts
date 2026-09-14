import { catalogApi } from '../../api/index';
import {
  getDraftItems,
  getDraftStaff,
  setDraftRemark,
  setDraftSlot,
  setDraftStaff,
} from '../../store/draft';
import {
  buildDateChips,
  fenToYuan,
  formatDuration,
  formatSlotReason,
  type DateChip,
} from '../../utils/format';
import { goConfirm, goServices } from '../../utils/nav';
import { runLoad } from '../../utils/load';
import { definePage } from '../../utils/page';
import {
  toSlotVM,
  toStaffVM,
  resolveServiceImage,
  type SlotVM,
  type StaffVM,
} from '../../utils/present';
import { toast } from '../../utils/ui';

/**
 * 预约美甲（设计稿第 4 屏）：把「选时间 + 选美甲师 + 备注」合并成一页。
 *
 * **一个设计↔接口的张力**：设计稿是「先选时间、后选美甲师」，
 * 但 `GET /app/available-slots` **必须传 `staffId`**（时段是按美甲师算的）。
 * 这里不改接口，而是**并行为每位美甲师各查一次、取时段并集**：
 * - 未选美甲师 → 展示所有人可约时间的并集；
 * - 选了美甲师 → 收敛为该美甲师的时段；
 * - 选了时间 → 只有该时段空闲的美甲师可选，其余置灰并提示。
 * 这样既守住了「时段必须由服务端算」的红线，也还原了设计稿的交互顺序。
 */
definePage({
  data: {
    dateChips: [] as DateChip[],
    activeDate: '',
    loading: true,
    errorText: '',
    /** 未先选款式就进入本页（从底部 Tab 直进） */
    emptyDraft: false,
    /** 展示用时段（含禁用态） */
    timeSlots: [] as { startAt: string; endAt: string; timeText: string }[],
    /** 展示用美甲师（含禁用/选中态） */
    staffList: [] as (StaffVM & { disabled: boolean; selected: boolean })[],
    selectedStart: '',
    selectedTimeText: '',
    staffName: '',
    itemNames: '',
    /** 摘要卡首图（设计稿那张卡左边有作品缩略图） */
    pickedImage: '',
    durationText: '',
    totalText: '0.00',
    reasonText: '',
    remark: '',
  },

  /** 每位美甲师的时段表：`staffId -> SlotVM[]`，用于时间与美甲师互相过滤 */
  slotsByStaff: {} as Record<string, SlotVM[]>,

  onLoad() {
    const items = getDraftItems();
    if (items.length === 0) {
      // 底部 Tab 里有「预约」，顾客可能不经过款式库直接进来；
      // 此时**不能弹回**（那是条死路），改为展示空态并把入口给到款式库。
      this.setData({ loading: false, emptyDraft: true });
      return;
    }
    const dateChips = buildDateChips(14);
    this.setData(
      {
        dateChips,
        activeDate: dateChips[0].value,
        durationText: formatDuration(
          items.reduce((sum, item) => sum + item.durationMinutes, 0),
        ),
        totalText: fenToYuan(items.reduce((sum, item) => sum + item.price, 0)),
        itemNames: items.map((item) => item.name).join(' · '),
        // 必须走 resolveServiceImage：草稿里存的是接口原值（`/api/v1/files/...` 相对路径），
        // 直接绑到 `<image>` 会被小程序当成**包内文件** → 静默空白。
        pickedImage: resolveServiceImage({
          id: items[0].id,
          image: items[0].image,
        }),
      },
      () => {
        this.loadAll();
      },
    );
  },

  /**
   * 拉美甲师 + 每位美甲师在该日的可约时段。
   *
   * `force` = 数据源整体换了（**换日期**）：必须回到骨架屏。
   * 否则 `runLoad` 会走「静默刷新」—— 旧日期的时段继续显示且**可点**，
   * 顾客可能在新日期上选中一个旧日期的钟点（`goNext` 会拿 activeDate + 旧 slot 拼草稿）。
   * 时段是「按美甲师 × 按日」算出来的，换日等于换了整个数据集，不是同源刷新。
   */
  async loadAll(force = false) {
    await runLoad(
      this,
      async () => {
        const staffPage = await catalogApi.listStaffs();
        const staffs = staffPage.items.map(toStaffVM);
        const items = getDraftItems();
        const serviceItemIds = items.map((item) => item.id);

        const results = await Promise.all(
          staffs.map((staff) =>
            catalogApi
              .getAvailableSlots({
                staffId: staff.id,
                date: this.data.activeDate,
                serviceItemIds,
              })
              .catch(() => null),
          ),
        );
        return { staffs, results };
      },
      {
        force,
        merge: ({ staffs, results }) => {
          const slotsByStaff: Record<string, SlotVM[]> = {};
          let reason = '';
          staffs.forEach((staff, index) => {
            const result = results[index];
            slotsByStaff[String(staff.id)] = result
              ? result.slots.map(toSlotVM)
              : [];
            // 所有人都是空的时候，用第一位美甲师给出的原因解释（off / no_shift / …）
            if (
              !reason &&
              result &&
              result.slots.length === 0 &&
              result.reason
            ) {
              reason = formatSlotReason(result.reason);
            }
          });

          this.slotsByStaff = slotsByStaff;
          return {
            staffList: staffs.map((staff) => ({
              ...staff,
              disabled: false,
              selected: false,
            })),
            reasonText: reason,
          };
        },
        after: () => this.refreshView(),
      },
    );
  },

  /** 按「已选美甲师 / 已选时间 / 已选日期」重算可选项 */
  refreshView() {
    const staff = getDraftStaff();
    const { selectedStart, activeDate } = this.data;
    const slotsByStaff = this.slotsByStaff;
    // 不用 flatMap：它是 ES2019 的**运行时** API，tsc 只会降级语法、不会替换 API，
    // 老基础库上会 undefined。空值合并运算符则会被 tsc 降级 —— 两者风险不同，别混为一谈。
    // （注释里刻意不写该运算符的字面量，否则 `grep 该符号` 会把它当成漏网的语法。）
    const all: SlotVM[] = [];
    Object.keys(slotsByStaff).forEach((key) => {
      all.push(...(slotsByStaff[key] ?? []));
    });

    // 时段：选了美甲师就只看他的；否则看并集（同一钟点去重）
    const source = staff ? (slotsByStaff[String(staff.id)] ?? []) : all;
    const seen = new Set<string>();
    const timeSlots = source
      .filter((slot) => {
        if (seen.has(slot.startAt)) return false;
        seen.add(slot.startAt);
        return true;
      })
      .map((slot) => ({
        startAt: slot.startAt,
        endAt: slot.endAt,
        timeText: slot.timeText,
      }));

    // 美甲师：选了时间就只让该时段空闲的人可点
    const staffList = this.data.staffList.map((item) => {
      const slots = slotsByStaff[String(item.id)] ?? [];
      const busy = selectedStart
        ? !slots.some((slot) => slot.startAt === selectedStart)
        : slots.length === 0;
      return {
        ...item,
        disabled: busy,
        selected: staff ? staff.id === item.id : false,
      };
    });

    this.setData({
      timeSlots,
      staffList,
      activeDate,
    });
  },

  onDate(event: WechatMiniprogram.TouchEvent) {
    const date = String(event.currentTarget.dataset.date);
    if (date === this.data.activeDate) return;
    // 换日期要清掉已选时段：旧日期的时间在新日期没有意义；并**回骨架屏**（见 loadAll 的 force）
    this.setData(
      { activeDate: date, selectedStart: '', selectedTimeText: '' },
      () => this.loadAll(true),
    );
  },

  onSlot(event: WechatMiniprogram.TouchEvent) {
    const startAt = String(event.currentTarget.dataset.start);
    const slot = this.data.timeSlots.find((item) => item.startAt === startAt);
    this.setData(
      { selectedStart: startAt, selectedTimeText: slot ? slot.timeText : '' },
      () => this.refreshView(),
    );
  },

  onPickStaff(event: WechatMiniprogram.TouchEvent) {
    const id = Number(event.currentTarget.dataset.id);
    const target = this.data.staffList.find((item) => item.id === id);
    if (!target) return;
    if (target.disabled) {
      toast('这位美甲师在这个时间已经有约了');
      return;
    }
    const staff = {
      id: target.id,
      nickname: target.nickname,
      avatar: target.avatar,
    };
    // 换美甲师会清掉已选时段（排班与冲突都变了），见 store/draft.ts
    setDraftStaff(staff);
    this.setData({ selectedStart: '', selectedTimeText: '' }, () =>
      this.refreshView(),
    );
  },

  onRemarkInput(event: WechatMiniprogram.Input) {
    const value = event.detail.value;
    setDraftRemark(value);
    this.setData({ remark: value });
  },

  goNext() {
    const staff = getDraftStaff();
    if (!staff) {
      toast('先选一位美甲师吧～');
      return;
    }
    const { selectedStart, activeDate, timeSlots } = this.data;
    if (!selectedStart) {
      toast('再选一个时间就可以啦');
      return;
    }
    const slot = timeSlots.find((item) => item.startAt === selectedStart);
    if (!slot) return;
    setDraftSlot({
      date: activeDate,
      startAt: slot.startAt,
      endAt: slot.endAt,
    });
    goConfirm();
  },

  goPickService() {
    goServices();
  },

  onRetry() {
    this.loadAll();
  },
});
