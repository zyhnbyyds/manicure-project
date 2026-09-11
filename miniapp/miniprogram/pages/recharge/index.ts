import { memberApi } from '../../api/index';
import { getThemeTokens } from '../../theme/theme';
import { fenToYuan } from '../../utils/format';
import { buildIcons, type IconName } from '../../utils/icons';
import { basePageData } from '../../utils/page';
import { isApiFailure } from '../../utils/request';
import { toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['card'];
const WHITE_ICONS: IconName[] = ['card'];

/**
 * 充值档位。
 *
 * ⚠️ **应该来自后端**：`biz_recharge_plan` 表是有的（管理端有充值方案模块），
 * 但 app 域没有暴露（如 `GET /app/recharge-plans`），所以先本地化。
 * 「赠送金额」必须与本金分开记账（后端 `creditBalance` 支持 principal / bonus 分开入账），
 * 页面上也据此分列展示。
 */
const PLANS = [
  { amount: 10000, bonus: 2000, label: '100元' },
  { amount: 20000, bonus: 5000, label: '200元' },
  { amount: 50000, bonus: 15000, label: '500元' },
  { amount: 100000, bonus: 35000, label: '1000元' },
  { amount: 200000, bonus: 80000, label: '2000元' },
  { amount: 500000, bonus: 220000, label: '5000元' },
];

Page({
  data: {
    ...basePageData(),
    icons: buildIcons(PAGE_ICONS, '#2D221E'),
    iconsWhite: buildIcons(WHITE_ICONS, '#FFFFFF'),
    loading: true,
    errorText: '',
    needBind: false,
    /** 账户余额（本金 + 赠送） */
    balanceText: '0.00',
    principalText: '0.00',
    bonusText: '0.00',
    plans: PLANS.map((plan) => ({
      ...plan,
      bonusText: fenToYuan(plan.bonus),
    })),
    activeIndex: -1,
    customAmount: '',
    /** 实付（分）与赠送（分） */
    payAmount: 0,
    payText: '0.00',
    gainText: '0.00',
  },

  onLoad() {
    this.load();
  },

  onShow() {
    this.setData({
      ...basePageData(),
      icons: buildIcons(PAGE_ICONS, getThemeTokens().text),
    });
  },

  async load() {
    this.setData({ loading: true, errorText: '' });
    try {
      const me = await memberApi.getMe();
      this.setData({
        loading: false,
        balanceText: fenToYuan(me.balancePrincipal + me.balanceBonus),
        principalText: fenToYuan(me.balancePrincipal),
        bonusText: fenToYuan(me.balanceBonus),
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

  onPickPlan(event: WechatMiniprogram.TouchEvent) {
    const index = Number(event.currentTarget.dataset.index);
    if (index === this.data.activeIndex) {
      // 再点一次取消选中，方便改自定义金额
      this.setData({ activeIndex: -1, customAmount: '' }, () => this.recalc());
      return;
    }
    const plan = PLANS[index];
    this.setData(
      { activeIndex: index, customAmount: '', payAmount: plan.amount },
      () => this.recalc(),
    );
  },

  /** 自定义金额：输入「元」，换算成「分」 */
  onCustomInput(event: WechatMiniprogram.Input) {
    const raw = event.detail.value.replace(/[^\d]/g, '');
    const yuan = raw ? Number(raw) : 0;
    this.setData(
      {
        customAmount: raw,
        activeIndex: -1,
        payAmount: Math.max(0, Math.round(yuan * 100)),
      },
      () => this.recalc(),
    );
  },

  recalc() {
    const { payAmount, activeIndex } = this.data;
    // 赠送只随档位走：自定义金额没有赠送（与线下规则一致，避免刷赠送）
    const bonus = activeIndex >= 0 ? PLANS[activeIndex].bonus : 0;
    this.setData({
      payText: fenToYuan(payAmount),
      gainText: fenToYuan(bonus),
    });
  },

  onRecharge() {
    const { payAmount, needBind } = this.data;
    if (needBind) {
      toast('请先绑定手机号');
      return;
    }
    if (payAmount <= 0) {
      toast('先选一个充值金额吧～');
      return;
    }
    // app 域还没有充值下单接口（后端能力在支付/账务侧），如实提示而不是假装成功
    toast('充值通道正在接入，可先到店充值');
  },

  onRetry() {
    this.load();
  },
});
