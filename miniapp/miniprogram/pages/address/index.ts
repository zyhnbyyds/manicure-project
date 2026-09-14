import { addressApi, memberApi } from '../../api/index';
import type { Address, AddressUpsertRequest } from '../../api/types';
import { isBound } from '../../store/auth';
import { requireSession } from '../../store/session';
import type { IconName } from '../../utils/icons';
import { isApiFailure } from '../../utils/request';
import { definePage } from '../../utils/page';
import { confirm, hideLoading, showLoading, toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['location', 'plus'];

/** 空表单（新增时的初值） */
const EMPTY_FORM: AddressUpsertRequest = {
  contactName: '',
  contactPhone: '',
  province: '',
  city: '',
  district: '',
  detail: '',
  isDefault: false,
};

/**
 * 收货地址（`docs/manicure-ui-batch4` 第 6 屏）。
 *
 * ## 这页为什么现在真的做出来了
 *
 * 上一版只还原了空态骨架，理由写在这里：「本店以到店服务为主，设计稿里的收货地址
 * 可能是电商模板混入」。**该判断已被门店否掉** —— 门店要卖「周边好物」并邮寄，
 * 所以地址簿是真实需求；后端 `biz_customer_address` + `/app/member/addresses` 已就位。
 *
 * ## 一张表单两个用途
 *
 * 新增与编辑共用同一个底部弹层（`mode: 'create' | 'edit'`）：字段完全一样，
 * 拆成两个页面只会得到两份各自漂移的校验逻辑。
 *
 * ## 默认地址
 *
 * 「最多一个默认」由服务端在同一事务里保证（切默认清旧的、删默认把最新的顶上），
 * 前端只显示 `isDefault` 徽标与「设为默认」按钮 —— **不要**在本地自己算哪个是默认。
 */
definePage({
  chromeIcons: PAGE_ICONS,

  data: {
    loading: true,
    errorText: '',
    needBind: false,
    addresses: [] as Address[],

    /** 弹层 */
    sheetOpen: false,
    mode: 'create' as 'create' | 'edit',
    /** 编辑中的地址 id（新增时为 0） */
    editingId: 0,
    form: { ...EMPTY_FORM },
    /** `<picker mode="region">` 的当前值：省/市/区三段 */
    region: [] as string[],
    submitting: false,
  },

  onLoad() {
    if (!isBound()) {
      this.setData({ loading: false, needBind: true });
      return;
    }
    void this.load();
  },

  /** 回到本页时静默刷新（新增/编辑后不用手动 load） */
  onShow() {
    if (this.data.needBind) return;
    if (!isBound()) {
      this.setData({ needBind: true, loading: false });
      return;
    }
    if (!this.data.loading) void this.load();
  },

  async load() {
    this.setData({ errorText: '' });
    try {
      const result = await addressApi.list();
      this.setData({
        loading: false,
        needBind: false,
        addresses: result.items,
      });
    } catch (error) {
      if (isApiFailure(error) && error.needBind) {
        this.setData({ loading: false, needBind: true });
        return;
      }
      this.setData({
        loading: false,
        errorText: isApiFailure(error) ? error.message : '网络连接失败',
      });
    }
  },

  onRetry() {
    void this.load();
  },

  async onGuestLogin() {
    await requireSession({
      needBind: true,
      reason: '管理地址需要先绑定手机号',
    });
    if (isBound()) void this.load();
  },

  /* ------------------------------ 弹层 ------------------------------ */

  /**
   * 新增：**用顾客档案里的姓名/手机号预填**。
   *
   * 绝大多数人的收货人就是自己，预填能省一次输入；填错了也能改。
   */
  async onAdd() {
    let form: AddressUpsertRequest = { ...EMPTY_FORM };
    try {
      const me = await memberApi.getMe();
      form = {
        ...form,
        contactName: me.name,
        contactPhone: me.phone ?? '',
        // 第一个地址默认勾上（省一步），已有地址时交给顾客自己决定
        isDefault: this.data.addresses.length === 0,
      };
    } catch {
      /* 取不到档案就留空，不挡着新增 */
    }
    this.setData({
      sheetOpen: true,
      mode: 'create',
      editingId: 0,
      form,
      region: [],
    });
  },

  onEdit(event: WechatMiniprogram.TouchEvent) {
    const id = Number(event.currentTarget.dataset.id);
    const target = this.data.addresses.find((item) => item.id === id);
    if (!target) return;
    this.setData({
      sheetOpen: true,
      mode: 'edit',
      editingId: id,
      form: {
        contactName: target.contactName,
        contactPhone: target.contactPhone,
        province: target.province ?? '',
        city: target.city ?? '',
        district: target.district ?? '',
        detail: target.detail,
        isDefault: target.isDefault,
      },
      region: [target.province ?? '', target.city ?? '', target.district ?? ''],
    });
  },

  onCloseSheet() {
    if (this.data.submitting) return;
    this.setData({ sheetOpen: false });
  },

  /** 吞掉弹层内容上的点击，避免冒泡到遮罩把弹层关掉 */
  onSheetBodyTap() {},

  onNameInput(event: WechatMiniprogram.Input) {
    this.setData({ 'form.contactName': event.detail.value });
  },

  onPhoneInput(event: WechatMiniprogram.Input) {
    this.setData({ 'form.contactPhone': event.detail.value });
  },

  onDetailInput(event: WechatMiniprogram.Input) {
    this.setData({ 'form.detail': event.detail.value });
  },

  /** 省市区：`<picker mode="region">` 原生三段选择，与后端三个字段一一对应 */
  onRegion(event: WechatMiniprogram.PickerChange) {
    const value = event.detail.value as string[];
    this.setData({
      region: value,
      'form.province': value[0] ?? '',
      'form.city': value[1] ?? '',
      'form.district': value[2] ?? '',
    });
  },

  onDefaultSwitch(event: WechatMiniprogram.SwitchChange) {
    this.setData({ 'form.isDefault': event.detail.value });
  },

  async onSubmit() {
    const { form, mode, editingId } = this.data;
    if (this.data.submitting) return;

    // 本地校验只拦「明显不对」，真正的规则在服务端
    const contactName = form.contactName.trim();
    const contactPhone = form.contactPhone.trim();
    const detail = form.detail.trim();
    if (!contactName) {
      toast('请填写收货人');
      return;
    }
    if (!/^[\d+\-() ]{6,20}$/.test(contactPhone)) {
      toast('请填写正确的联系电话');
      return;
    }
    if (detail.length < 2) {
      toast('请填写详细地址（楼栋 / 门牌号）');
      return;
    }

    const payload: AddressUpsertRequest = {
      contactName,
      contactPhone,
      province: form.province || null,
      city: form.city || null,
      district: form.district || null,
      detail,
      isDefault: form.isDefault,
    };

    this.setData({ submitting: true });
    showLoading(mode === 'create' ? '保存中' : '更新中');
    try {
      if (mode === 'create') {
        await addressApi.create(payload);
      } else {
        await addressApi.update(editingId, payload);
      }
      hideLoading();
      this.setData({ submitting: false, sheetOpen: false });
      toast(mode === 'create' ? '地址已添加' : '地址已更新');
      await this.load();
    } catch (error) {
      hideLoading();
      this.setData({ submitting: false });
      toast(isApiFailure(error) ? error.message : '保存失败，请稍后再试');
    }
  },

  /* ------------------------------ 列表操作 ------------------------------ */

  async onSetDefault(event: WechatMiniprogram.TouchEvent) {
    const id = Number(event.currentTarget.dataset.id);
    const target = this.data.addresses.find((item) => item.id === id);
    if (!target || target.isDefault) return;
    showLoading('设置中');
    try {
      await addressApi.setDefault(id);
      hideLoading();
      await this.load();
    } catch (error) {
      hideLoading();
      toast(isApiFailure(error) ? error.message : '设置失败，请稍后再试');
    }
  },

  async onDelete(event: WechatMiniprogram.TouchEvent) {
    const id = Number(event.currentTarget.dataset.id);
    const target = this.data.addresses.find((item) => item.id === id);
    if (!target) return;
    const ok = await confirm({
      title: '删除地址',
      content: target.isDefault
        ? '删除后会把剩下最新的一个地址设为默认。'
        : '删除后不可恢复。',
      confirmText: '删除',
    });
    if (!ok) return;
    showLoading('删除中');
    try {
      await addressApi.remove(id);
      hideLoading();
      await this.load();
    } catch (error) {
      hideLoading();
      toast(isApiFailure(error) ? error.message : '删除失败，请稍后再试');
    }
  },
});
