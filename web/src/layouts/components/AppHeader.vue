<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import {
  AlertTriangle,
  BookOpen,
  ChevronDown,
  Github,
  Info,
  MonitorPlay,
  Moon,
  Palette,
  Sparkles,
  Store as StoreIcon,
  Sun,
} from 'lucide-vue-next';
import { LewDropdown, LewMessage } from 'lew-ui';
import type { LewContextMenusOption } from 'lew-ui';
import { logout as logoutApi } from '~/api/auth';
import { useStoreScopeStore } from '~/store/store-scope';
import { useUserStore } from '~/store/user';
import { useSettingsStore } from '~/store/settings';
import { resetRouteFlag } from '~/router/guard';

const emit = defineEmits<{ openTheme: []; openAi: [] }>();

const router = useRouter();
const userStore = useUserStore();
const settings = useSettingsStore();
const storeScope = useStoreScopeStore();

/** 切换器里代表「全部门店」的哨兵值（`value` 是 string，且 0 在 lew-ui 里不当真值） */
const ALL_STORES = 'all';

/**
 * 一个下拉项。
 *
 * `checkable: true` 不能省：lew-ui 的 `LewContextMenu` **只看 option 上的 `checkable`**
 * 来决定要不要渲染勾选列（dropdown 自己的 `checkable` prop 不参与这段逻辑）——
 * 漏了就变成「所有项都看不出当前选中」，只能靠 trigger 上的文案猜。
 */
function storeOption(
  label: string,
  value: string,
  active: boolean,
): LewContextMenusOption {
  return { label, value, checkable: true, checked: active, active };
}

/**
 * 门店切换器选项。
 *
 * 「全部门店」= 不按门店筛选（`activeStoreId` 为 null）：
 * 超管看到的是全部门店合并，店长看到的是自己那几家的合并 —— 选项列表本身就只含
 * 他可见的门店，所以这个说法不会让人误会成「看到了别人的店」。
 */
const storeOptions = computed<LewContextMenusOption[]>(() => [
  storeOption('全部门店', ALL_STORES, storeScope.activeStoreId === null),
  ...storeScope.stores.map((store) =>
    storeOption(
      store.isDefault ? `${store.name}（默认）` : store.name,
      String(store.id),
      storeScope.activeStoreId === store.id,
    ),
  ),
]);

/**
 * 切换门店：只改本地上下文（`request.ts` 会把 `x-store-id` 带到之后每个请求），
 * 列表页由 `useTable` 监听 `activeStoreId` 自动重载 —— 这里不发任何请求，
 * 所以不需要 loading，但必须给一条结果反馈，否则用户不知道「切成功了没」。
 */
function handleStoreChange(option: LewContextMenusOption) {
  const value = String(option.value ?? '');
  const next = value === ALL_STORES ? null : Number(value);
  if (next === storeScope.activeStoreId) return;
  const label =
    next === null
      ? '全部门店'
      : (storeScope.stores.find((store) => store.id === next)?.name ?? '门店');
  storeScope.setActive(next);
  LewMessage.success(`已切换到「${label}」`);
}

async function handleLogout() {
  try {
    await logoutApi(userStore.refreshToken);
  } catch {
    // 后端登出失败不阻塞前端登出
  }
  userStore.reset();
  resetRouteFlag();
  LewMessage.success('已退出登录');
  router.push('/login');
}

/**
 * 大屏展示地址。
 *
 * `BASE_URL` 既可能是 `/` 也可能是子路径（如 `/admin/`），结尾必须保证有一个斜杠，
 * 不能直接字符串相加 —— 否则会拼出 `/adminscreen`。
 */
const screenUrl = `${(import.meta.env.BASE_URL || '/').replace(/\/?$/, '/')}screen`;

/**
 * 外部文档入口。
 *
 * 开发者文档与商家文档是**两个独立部署的站点**，所以收进一个下拉里 ——
 * 并排摆两个图标，等于为两个「一个月点一次」的入口各占一个常驻位。
 */
const docOptions: LewContextMenusOption[] = [
  { label: '开发者文档', value: 'https://dev.fairtech.work' },
  { label: '商家文档', value: 'https://docs.fairtech.work' },
];

/**
 * 打开外部文档。
 *
 * 这里用 `window.open` 而不是像大屏入口那样用 `<a>`：下拉项是拿数据渲染出来的，
 * 挂不上真链接。它是**用户点下拉项**触发的（有用户激活），不会像脚本自动调用
 * 那样被弹窗拦截器当弹窗拍掉。
 */
function handleDocChange(option: LewContextMenusOption) {
  const url = String(option.value ?? '');
  if (url) window.open(url, '_blank', 'noopener');
}

function handleUserMenu(option: LewContextMenusOption) {
  if (option.value === 'profile') {
    router.push('/profile');
  } else if (option.value === 'logout') {
    void handleLogout();
  }
}

function toggleDark() {
  settings.setMode(settings.isDark ? 'light' : 'dark');
}
</script>

<template>
  <header
    class="flex items-center justify-between h-14 px-4 shrink-0 bg-[var(--app-bg-card)] border-b border-[var(--app-border)]"
  >
    <div class="flex min-w-0 items-center gap-3">
      <span class="text-15px font-600">{{ $route.meta.title ?? '' }}</span>

      <!-- 免责声明：常驻但不抢眼（不带交互，所以只放静态徽标 + tooltip）。
           窄屏隐藏 —— 它是「背景信息」，比右侧的门店切换器与各项操作优先级低得多。 -->
      <span
        class="hidden items-center gap-1.5 h-22px px-2.5 rounded-full border border-[var(--app-border)] bg-[var(--app-bg-page)] shrink-0 text-12px whitespace-nowrap text-[var(--app-text-secondary)] md:inline-flex"
        title="本系统为技术演示环境：所有数据均为虚构，仅用于功能演示，未从事任何商业经营活动"
      >
        <Info :size="13" class="shrink-0" />
        仅演示，未从事商业活动
      </span>
    </div>

    <div class="flex items-center gap-2">
      <!-- 门店切换器：多店（可见门店 > 1）才显示，单店期不该让运营看见这个概念 -->
      <LewDropdown
        v-if="storeScope.hasSwitcher"
        trigger="click"
        :options="storeOptions"
        @change="handleStoreChange"
      >
        <button
          class="flex items-center gap-1.5 h-30px px-2.5 border-none rounded-full bg-transparent cursor-pointer transition-colors duration-200 hover:bg-[var(--app-bg-hover)]"
          :title="`当前门店：${storeScope.activeLabel}（列表与新建单据都按它走）`"
        >
          <StoreIcon
            :size="15"
            class="shrink-0 text-[var(--app-text-secondary)]"
          />
          <span
            class="max-w-110px truncate text-13px text-[var(--app-text-primary)]"
            >{{ storeScope.activeLabel }}</span
          >
          <ChevronDown
            :size="13"
            class="shrink-0 text-[var(--app-text-secondary)]"
          />
        </button>
      </LewDropdown>

      <!-- 未分配门店：常驻提示（不是静默的空列表，也不是每次刷新弹一次错误框） -->
      <span
        v-else-if="storeScope.loaded && storeScope.scope === 'none'"
        class="flex items-center gap-1.5 h-30px px-2.5 rounded-full bg-[var(--lew-color-warning-light)] text-12px text-[var(--lew-color-warning)]"
        title="当前账号未分配门店：预约 / 收款 / 顾客等业务数据都会是空的，请在「用户管理 → 设置可见门店」里分配"
      >
        <AlertTriangle :size="14" class="shrink-0" />
        未分配门店
      </span>

      <!-- 暗色切换 -->
      <button class="icon-btn" title="切换暗色模式" @click="toggleDark">
        <Moon v-if="!settings.isDark" :size="17" />
        <Sun v-else :size="17" />
      </button>

      <!-- 主题面板 -->
      <button class="icon-btn" title="主题设置" @click="emit('openTheme')">
        <Palette :size="17" />
      </button>

      <!-- 大屏展示：新窗口打开。
           这里用 <a target="_blank"> 而不是 window.open —— 后者依赖「用户激活」，
           在部分环境下会被当作弹窗直接拦掉（返回值 null，静默失效）；
           链接导航不算弹窗，稳得多，还白送了中键 / Ctrl+点击的用法。 -->
      <a
        class="icon-btn no-underline"
        :href="screenUrl"
        target="_blank"
        rel="noopener"
        title="大屏展示（新窗口打开）"
      >
        <MonitorPlay :size="17" />
      </a>

      <!-- AI 助手 -->
      <button
        v-permission="'ai:chat'"
        class="icon-btn"
        title="AI 助手"
        @click="emit('openAi')"
      >
        <Sparkles :size="17" />
      </button>

      <!-- 外部文档：开发者文档 / 商家文档，两个独立站点收进一个下拉 -->
      <LewDropdown
        trigger="click"
        :options="docOptions"
        @change="handleDocChange"
      >
        <button class="icon-btn" title="外部文档（新窗口打开）">
          <BookOpen :size="17" />
        </button>
      </LewDropdown>

      <!-- GitHub 链接 -->
      <a
        class="icon-btn"
        href="https://github.com/zyhnbyyds/manicure-project"
        target="_blank"
        rel="noopener noreferrer"
        title="GitHub 仓库"
      >
        <Github :size="17" />
      </a>

      <!-- 用户菜单 -->
      <LewDropdown
        trigger="click"
        :options="[
          { label: '个人中心', value: 'profile' },
          { label: '退出登录', value: 'logout' },
        ]"
        @change="handleUserMenu"
      >
        <button
          class="flex items-center gap-2 py-1 pr-2.5 pl-1 border-none rounded-full bg-transparent cursor-pointer transition-colors duration-200 hover:bg-[var(--app-bg-hover)]"
        >
          <img
            v-if="userStore.avatar"
            :src="userStore.avatar"
            alt="avatar"
            class="w-26px h-26px rounded-full object-cover"
          />
          <span
            v-else
            class="flex items-center justify-center w-26px h-26px rounded-full bg-[var(--lew-color-button-primary-fill)] text-white text-12px font-700"
          >
            {{ userStore.username.slice(0, 1).toUpperCase() }}
          </span>
          <span class="text-13px text-[var(--app-text-primary)]">{{
            userStore.username
          }}</span>
        </button>
      </LewDropdown>
    </div>
  </header>
</template>
