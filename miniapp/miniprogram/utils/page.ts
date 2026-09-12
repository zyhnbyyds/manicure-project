/**
 * 页面公共数据 / 页面工厂 —— 让每个页面**不再重复**这段样板：
 *
 * ```ts
 * Page({
 *   data: { ...basePageData(), icons: buildIcons(PAGE_ICONS, '#2D221E'), ... },
 *   onShow() {
 *     this.setData({ ...basePageData(), icons: buildIcons(PAGE_ICONS, getThemeTokens().text) });
 *     syncTabBar(this);          // ← 而且只有部分页面记得写
 *   },
 * });
 * ```
 *
 * ## 为什么要抽
 *
 * 主题是全局的，但小程序里没有「全局 CSS 变量」可以跨页面生效，
 * **每个页面都得把当前主题令牌挂到自己的根节点上**；登录态、图标颜色同理。
 * 迁移前这段样板在 29 个页面里各写了一遍，直接后果有三个：
 * 1. 初始 `data` 里的图标色是**写死的 `#2D221E`**（不是主题令牌）→ 换主题时首帧会闪一下旧色；
 * 2. `syncTabBar(this)` **漏了一半页面** → 自定义 TabBar 的高亮只能靠 `pageLifetimes.show`
 *    自己兜，兜不住就出现「高亮在首页、人在我的」这种错位；
 * 3. 每个新页面复制粘贴一遍，漏一行就是一类 bug。
 *
 * ## 用法
 *
 * ```ts
 * definePage({
 *   chromeIcons: PAGE_ICONS,             // 自动跟随主题生成图标
 *   data: { loading: true, items: [] },
 *   onShow() { void this.load(); },      // chrome 已经刷新过了，这里只写业务
 *   async load() { ... },
 * });
 * ```
 *
 * `chromeIcons` / `whiteIcons` / `extra` 之外的图标，请在页面里用 `whiteIconSet()` 等 helper 自行生成。
 */
import { getSession } from '../store/session';
import { getThemeState, getThemeTokens, themeStyle } from '../theme/theme';
import { buildIcons, type IconName } from './icons';
import { syncTabBar } from './tabbar';

/**
 * 页面公共数据（主题 + 登录态）。
 *
 * 刻意写成 type alias 而不是 interface：type alias 会被 TS 赋予**隐式索引签名**，
 * 于是整份 chrome 能直接喂给 `setData`；interface 不行（会报 "Index signature is missing"）。
 */
export type BasePageData = {
  /** `--c-*` 自定义属性串，挂在页面根节点 style 上 */
  themeStyle: string;
  themePrimary: string;
  /** 主色上的可读前景色，供需要内联色值的场景使用 */
  onPrimary: string;
  themeName: string;
  themeEmoji: string;
  /**
   * 登录态两个标志 —— 放进公共数据，**所有页面天然可用**：
   * - `loggedIn`：有 app token，可浏览项目/美甲师/时段
   * - `bound`：已绑定手机号，可下单、看会员与订单
   *
   * 页面用它们决定展示（如未登录时把「会员资产」换成「登录后查看」入口）；
   * 需要身份的动作则统一走 `store/session.ts` 的 `requireSession()` 做引导。
   */
  loggedIn: boolean;
  bound: boolean;
};

/**
 * 加载态四件套（配合 `utils/load.ts` 的 `runLoad`）。
 *
 * 放在 chrome 里一起注入，是为了让「所有页面都有同一套加载语义」——
 * 页面自己声明 `loading: true` 表示「首屏要骨架屏」，其余三个由状态机接管。
 */
export interface LoadStateData {
  /** 首屏加载中（渲染骨架屏） */
  loading: boolean;
  /** 非首屏刷新中（保留旧内容，只做轻提示） */
  refreshing: boolean;
  /** 加载失败文案（空串 = 没有错误） */
  errorText: string;
  /** 是否成功加载过至少一次 —— 决定「回骨架屏」还是「静默刷新」 */
  loaded: boolean;
}

export interface ChromeOptions {
  /**
   * 跟随主题色生成的主图标集（进 `data.icons`）。
   *
   * ⚠️ 字段名是 `chromeIcons` 而不是 `icons`：`data` 里的键叫 `icons`，
   * 配置项若同名极易与页面自己的 data 混淆；一旦拼错（如 `chromeIcon`），
   * 它会落进 `...rest` 被原样透传给 `Page()`，而 `CustomOption` 是
   * `Record<string, any>` → **tsc 不报错、图标却全没了**。`definePage` 里有防呆告警兜这一手。
   */
  chromeIcons?: IconName[];
  /** 固定白色的图标集（主色底上的对勾等），进 `data.iconsWhite` */
  whiteIcons?: IconName[];
  /**
   * 其余需要跟随主题重算的 chrome（如评分星的实心/描边两态）。
   * 每次 `onShow` 都会重新调用，所以里面请**只做纯计算**（可以读主题令牌）。
   */
  extra?: () => Record<string, unknown>;
}

/**
 * chrome 里的**外观/身份**部分（`onShow` 每次刷新的就是这一份，不含加载态）。
 *
 * 刻意写成 type alias（不是 interface）：type alias 会被 TS 赋予**隐式索引签名**，
 * 于是能直接喂给 `setData`；interface 不行（会报 "Index signature is missing"）。
 */
export type ChromeAppearance = BasePageData & {
  icons?: Record<string, string>;
  iconsWhite?: Record<string, string>;
};

/** chrome 注入给页面的那部分 data（页面自己的 `data` 之外，`this.data` 上一定拿得到） */
export type ChromeData = ChromeAppearance & LoadStateData;

export function basePageData(): BasePageData {
  const theme = getThemeState();
  const tokens = getThemeTokens();
  const session = getSession();
  return {
    themeStyle: themeStyle(),
    themePrimary: tokens.primary,
    onPrimary: tokens.onPrimary,
    themeName: theme.name,
    themeEmoji: theme.emoji,
    loggedIn: session.loggedIn,
    bound: session.bound,
  };
}

/**
 * **外观/身份** chrome —— `onShow` 每次只推这一份。
 *
 * ⚠️ **绝对不要把加载态（loading / refreshing / errorText / loaded）放进来。**
 * 这里是踩过一次的坑：`onShow` 里推全量 chrome 会把 `loading` 打回 false、把 `loaded`
 * 打回 false，后果有两个且都很隐蔽：
 * 1. `onLoad` 里发起请求的页面（`onLoad → onShow` 紧邻）**骨架屏会被立刻撤掉**，
 *    请求还在飞就先闪一下空态；
 * 2. `runLoad` 的 `loaded` 一直被重置 → 每次切回本页都判成「首屏」→
 *    又回骨架屏，且刷新失败不再「保留旧内容」，整个状态机被抵消。
 *
 * 加载态四件套只在 **`data` 初始化**时由 `pageChrome()` 播一次种，
 * 之后就**只归 `runLoad` 所有**（和迁移前各页 `onShow` 只写 basePageData+icons 的行为一致）。
 */
export function pageAppearance(options: ChromeOptions = {}): ChromeAppearance {
  const tokens = getThemeTokens();
  return {
    ...basePageData(),
    ...(options.chromeIcons
      ? { icons: buildIcons(options.chromeIcons, tokens.text) }
      : {}),
    ...(options.whiteIcons
      ? { iconsWhite: buildIcons(options.whiteIcons, '#FFFFFF') }
      : {}),
    ...(options.extra ? options.extra() : {}),
  };
}

/** `data` 初始化的完整 chrome = 外观/身份 + 加载态四件套的初值 */
export function pageChrome(options: ChromeOptions = {}): ChromeData {
  return {
    ...pageAppearance(options),
    loading: false,
    refreshing: false,
    errorText: '',
    loaded: false,
  };
}

/** 主色底上的白色图标（如选中态对勾）；颜色写死白色是**语义**，不是偷懒 */
export function whiteIconSet(names: IconName[]): Record<string, string> {
  return buildIcons(names, '#FFFFFF');
}

type DataOption = WechatMiniprogram.Page.DataOption;
type CustomOption = WechatMiniprogram.Page.CustomOption;
type PageOptions<D extends DataOption, C extends CustomOption> =
  WechatMiniprogram.Page.Options<D, C>;
type PageInstance<D extends DataOption, C extends CustomOption> =
  WechatMiniprogram.Page.Instance<D, C>;

/**
 * 页面配置。
 *
 * `data` 只声明**页面自己的**字段（chrome 由工厂注入），但 `this.data` / `this.setData`
 * 的类型是 `D & ChromeData` —— 所以在页面里直接读 `this.data.bound` / `this.data.refreshing`
 * 都是有类型的。
 *
 * ⚠️ 这里**不能**用 `Omit<Page.Options<...>, 'data'>`：
 * `Omit = Pick<T, Exclude<keyof T, K>>`，而 `keyof (C & …)` 在 `C` 还在推断时是 deferred 的，
 * 于是泛型 `C`（页面自定义属性/方法）**永远推不出来、静默退化成 `Record<string, any>`** ——
 * 后果是所有页面的 `this.bookingId` / `this.slotsByStaff` 都变 `any`，
 * 自定义属性与方法名的拼写错误再也不会被 tsc 抓到（并行重构时就真踩到了）。
 * 直接用 `& C` 交叉即可：它保留 `C` 的推断位，同时 `Partial<ILifetime>` 提供生命周期签名。
 */
export type DefinePageConfig<
  D extends DataOption,
  C extends CustomOption,
> = ChromeOptions & { data: D } & Partial<WechatMiniprogram.Page.ILifetime> & C &
  // ThisType 必须留在最终交叉类型里：它给对象字面量里的每个方法提供 `this`
  ThisType<PageInstance<D & ChromeData, C>>;

/**
 * `Page()` 的包装：自动挂 chrome，并在**每次 onShow**（含首次）刷新主题/登录态/图标 +
 * 同步自定义 TabBar，然后才调用页面自己的 `onShow`。
 *
 * 注意：页面自己的 `onShow` 里**不要再**写 `basePageData()` / `buildIcons` / `syncTabBar`。
 */
export function definePage<D extends DataOption, C extends CustomOption>(
  config: DefinePageConfig<D, C>,
): void {
  const {
    chromeIcons,
    whiteIcons: whiteNames,
    extra,
    data,
    onShow,
    ...rest
  } = config;

  // 防呆：chrome 配置项拼错时会被 `...rest` 静默透传给 Page()（CustomOption 是
  // `Record<string, any>`，tsc 抓不到），症状是「整页图标凭空消失、却没有任何报错」。
  // 这里把「静默」变回「一眼可见」——只在键名以 chrome/white 开头时检查，零成本。
  Object.keys(rest).forEach((key) => {
    if (key.startsWith('chrome') || key.startsWith('white')) {
      console.warn(
        `[definePage] 未知的 chrome 配置项 "${key}"（应为 chromeIcons / whiteIcons / extra）：` +
          '它会落进 Page() 的自定义方法里，图标不会生成。',
      );
    }
  });

  const chrome = (): ChromeData =>
    pageChrome({ chromeIcons, whiteIcons: whiteNames, extra });
  // onShow 只刷外观/身份，**不碰加载态**（详见 pageAppearance 的注释）
  const appearance = (): Record<string, unknown> =>
    pageAppearance({ chromeIcons, whiteIcons: whiteNames, extra });

  const options = {
    ...rest,
    // chrome 在前、页面自己的 data 在后：页面可以覆盖（例如首屏 `loading: true`）
    data: { ...chrome(), ...data },
    onShow(this: PageInstance<DataOption, CustomOption>) {
      this.setData(appearance());
      // 自定义 TabBar 的高亮由它自己按真实路由算，这里只是**同一个 onShow 时机**推一把，
      // 覆盖「TabBar 实例先于页面 onShow 创建」的时序（历史 bug：高亮错位 → 点不动）
      syncTabBar(this);
      if (typeof onShow === 'function') {
        (onShow as (this: unknown) => void).call(this);
      }
    },
  };

  // 工厂内部用宽类型拼装、出口收窄成调用方声明的 D/C：
  // 这是**唯一**能既保留页面侧完整类型推断、又不让 chrome 的额外字段到处报错的办法。
  Page<D & ChromeData, C>(options as unknown as PageOptions<D & ChromeData, C>);
}
