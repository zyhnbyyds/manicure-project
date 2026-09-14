import { memberApi } from '../../api/index';
import { fenToYuan } from '../../utils/format';
import type { IconName } from '../../utils/icons';
import { definePage } from '../../utils/page';
import { isApiFailure } from '../../utils/request';
import { toast } from '../../utils/ui';

const PAGE_ICONS: IconName[] = ['card'];
const WHITE_ICONS: IconName[] = ['card'];

/**
 * 充值档位的展示态。
 *
 * 档位**来自服务端**（`GET /app/recharge-plans`），这里只做展示映射 ——
 * 曾经硬编码在本页（充 2000 送 800…），门店改了后台配置、小程序还按旧比例宣传，
 * 充值通道一接通就是资金纠纷。
 * 「赠送金额」必须与本金分开记账（后端 `creditBalance` 支持 principal / bonus 分开入账）。
 */
interface PlanVM {
  id: number;
  /** 实付（分） */
  amount: number;
  /** 赠送（分） */
  bonus: number;
  /** 主标题：用门店自己起的档位名 */
  label: string;
  /** 赠送金额（元，展示用） */
  bonusText: string;
}

definePage({
  chromeIcons: PAGE_ICONS,
  whiteIcons: WHITE_ICONS,

  data: {
    loading: true,
    errorText: '',
    needBind: false,
    /** 账户余额（本金 + 赠送） */
    balanceText: '0.00',
    principalText: '0.00',
    bonusText: '0.00',
    /** 累计充值（元，毛额）—— 设计稿右上角那一行 */
    rechargedText: '0.00',
    /** 服务端下发的档位（加载前为空，不展示任何伪造档位） */
    plans: [] as PlanVM[],
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

  async load() {
    this.setData({ loading: true, errorText: '' });
    try {
      const [me, planPage] = await Promise.all([
        memberApi.getMe(),
        memberApi.rechargePlans(),
      ]);
      this.setData({
        loading: false,
        balanceText: fenToYuan(me.balancePrincipal + me.balanceBonus),
        principalText: fenToYuan(me.balancePrincipal),
        bonusText: fenToYuan(me.balanceBonus),
        // 设计稿的「累计充值」：毛额口径，由服务端从充值流水汇总（退款不减这一项）
        rechargedText: fenToYuan(me.totalRecharged),
        plans: planPage.items.map((plan) => ({
          id: plan.id,
          amount: plan.payAmount,
          bonus: plan.bonusAmount,
          label: plan.name || `${fenToYuan(plan.payAmount)} 元`,
          bonusText: fenToYuan(plan.bonusAmount),
        })),
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
    const plan = this.data.plans[index];
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
    const bonus =
      activeIndex >= 0 ? (this.data.plans[activeIndex]?.bonus ?? 0) : 0;
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
