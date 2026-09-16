<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import dayjs from 'dayjs';
// 副作用导入：设置 dayjs 默认时区为东八区（本页所有时间都按它换算）
import '~/composables/useFormat';
import {
  Activity,
  ArrowLeft,
  CalendarCheck,
  CircleAlert,
  CircleCheck,
  Clock,
  Maximize,
  Minimize,
  RefreshCw,
  Timer,
  Users,
} from 'lucide-vue-next';
import {
  listBookingCalendar,
  type BookingCalendarBlock,
} from '~/api/biz/bookings';
import {
  getScheduleCalendar,
  type ScheduleCalendarCell,
} from '~/api/biz/schedules';
import { useStoreScopeStore } from '~/store/store-scope';
import {
  buildLanes,
  buildTimelineScale,
  isDeadStatus,
  isoWeekday,
  nowSeconds,
  percentOf,
  rangeStyle,
  secondsLabel,
  shopSecondsOf,
  TONE_LABELS,
  TONE_ORDER,
  type LaneStaff,
  type ScreenLane,
} from './screen-utils';

/**
 * 大屏展示（店内挂屏 / 电视）。
 *
 * ## 它为什么不在后台布局里
 *
 * 这是给**店里那块屏**看的东西，没有侧边栏、没有顶栏、没有弹窗、不能有操作入口 ——
 * 所以它是一条**顶层静态路由**（`constantRoutes`），不进菜单驱动的动态路由
 * （那些一律挂在 `layout` 下，会带出一整套后台 chrome）。入口在顶栏的新窗口按钮上。
 *
 * ## 视觉口径：固定深色，不跟随后台主题
 *
 * 深色底 + 高饱和色块是远距离识别的正解，也避免「店员把后台切成浅色 →
 * 挂屏上的块全糊成浅底浅字」。所以这里所有颜色走本组件自己的 `--scr-*` 变量，
 * **刻意不复用** `--app-*` / `--lew-*`（那两套是跟着主题变的）。
 *
 * ## 刷新节奏
 *
 * - 时钟与「现在线」**每秒**走：读屏的人靠它判断「还剩多久」；
 * - 业务数据**每 30 秒**重拉：这块屏一挂一整天，不能让员工手动刷。
 */

const REFRESH_MS = 30_000;

const storeScope = useStoreScopeStore();

/** 每秒自增的「店内本地时间秒数」——时钟、现在线、每个块的进度都由它驱动 */
const nowSec = ref(nowSeconds());
const loading = ref(false);
const refreshing = ref(false);
const error = ref<string | null>(null);
const lastSyncAt = ref<string | null>(null);
const truncated = ref(false);

const staffs = ref<LaneStaff[]>([]);
const cells = ref<ScheduleCalendarCell[]>([]);
const rawBlocks = ref<BookingCalendarBlock[]>([]);

const isFullscreen = ref(false);

const today = dayjs().tz().format('YYYY-MM-DD');

/* ------------------------------------------------------------------ *
 * 派生视图
 * ------------------------------------------------------------------ */

const lanes = computed<ScreenLane[]>(() =>
  buildLanes(staffs.value, cells.value, rawBlocks.value, nowSec.value),
);

/**
 * 时间轴范围**只看有效预约块** —— 排班与当前时间都不参与（理由见 `buildTimelineScale`）。
 * 已取消 / 爽约的单本来就不上时间轴，它们若是深夜的单，也不该把范围拖过去。
 */
const scale = computed(() =>
  buildTimelineScale(
    rawBlocks.value
      .filter((block) => !isDeadStatus(block.status))
      .map((block) => ({
        startSec: shopSecondsOf(block.startAt),
        endSec: shopSecondsOf(block.endAt),
      })),
  ),
);

/** 块宽档位：`lg` 带头像的全量 / `md` 姓名 + 时段 + 时长 / `sm` 姓名 + 时段 / `xs` 只保姓名 */
type BlockSize = 'xs' | 'sm' | 'md' | 'lg';

/**
 * 泳道视图：给每个块补一个**宽度百分比**，据此决定块内信息显示到哪一档。
 *
 * 块宽 = 时长 ÷ 时间轴总跨度，跨度一固定，块宽就只跟时长有关 —— 60 分钟的块
 * 在 13 小时轴上只有 7% 宽，硬塞「姓名 + 时段 + 徽章」只会挤成一团黑点。
 * 所以按宽度砍信息：`lg` 全给、`md` 姓名 + 时段 + 时长、`sm` 保姓名与时段、`xs` 只保姓名。
 *
 * 头像单独卡在 `lg`（而不是跟着 `md`）：它要吃掉三十多像素，而 `md` 的下限
 * （約 130px）里「头像 + 徽章」已占掉三分之二，剩下的宽度只够显示一个半汉字。
 *
 * **砍的永远是次要信息，字号一档都不降** —— 大屏上字一旦变小就等于没有。
 * 这里的 `3.2` 必须与模板里 `rangeStyle(..., 3.2)` 的兜底宽度一致，
 * 否则极短的块会被判成 `xs`、却按 `sm` 的宽度渲染出来（多出的字被裁一半）。
 */
const laneViews = computed(() =>
  lanes.value.map((lane) => ({
    ...lane,
    blocks: lane.blocks.map((block) => {
      const width = Math.max(
        3.2,
        percentOf(block.endSec, scale.value) -
          percentOf(block.startSec, scale.value),
      );
      const size: BlockSize =
        width >= 12 ? 'lg' : width >= 9 ? 'md' : width >= 4.5 ? 'sm' : 'xs';
      /**
       * 摆不摆得下「装饰件」（顾客首字头像 / 时长）。
       *
       * 只在**很宽**的块上摆：这两样合起来要吃掉一百多像素，实测在一个 276px 的块里
       * 会把姓名挤到只剩一个字（「微…」），而且首字头像与姓名首字完全重复，
       * 看起来就是「微 微…」。三者的价值排序是 姓名 > 时长 > 头像，
       * 挤不下时从右往左砍。
       */
      const showDeco = width >= 25;
      return { ...block, width, size, showDeco };
    }),
  })),
);

const stats = computed(() => {
  const all = lanes.value.flatMap((lane) => lane.blocks);
  const count = (tone: string) =>
    all.filter((block) => block.tone === tone).length;
  return {
    total: all.length,
    active: count('active'),
    soon: count('soon'),
    upcoming: count('upcoming'),
    done: count('done'),
    overtime: count('overtime'),
    // 取消 / 爽约不上时间轴，但店里还是要知道今天被放掉了几单
    cancelled: rawBlocks.value.filter((block) => isDeadStatus(block.status))
      .length,
  };
});

const clockLabel = computed(() => {
  const total = Math.floor(nowSec.value);
  const hour = Math.floor(total / 3600) % 24;
  const minute = Math.floor((total % 3600) / 60);
  const second = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(hour)}:${pad(minute)}:${pad(second)}`;
});

const dateLabel = computed(() => `${today} ${weekdayLabel(isoWeekday(today))}`);

const syncedLabel = computed(() =>
  lastSyncAt.value ? `已同步 ${lastSyncAt.value}` : '尚未同步',
);

function weekdayLabel(weekday: number): string {
  return (
    ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][weekday - 1] ?? ''
  );
}

function laneStateLabel(lane: ScreenLane): string {
  if (lane.state === 'busy') return '进行中';
  if (lane.state === 'off') return lane.off ? '今日休息' : '未排班';
  return lane.nextStartSec === null
    ? '空闲'
    : `空闲 · 下一单 ${secondsLabel(lane.nextStartSec)}`;
}

/**
 * 美甲师首字头像的底色。
 *
 * 后端的美甲师档案里没有头像字段（`staffs` 只给 `{ id, nickname }`），
 * 所以用昵称派一个**稳定**的色相 —— 同一个人每次刷新、隔几天再看都是同一个颜色，
 * 店员才能靠颜色认人；随机色会让这块屏每 30 秒刷新一次就换一次脸。
 *
 * 色相刻意收在 190~330（青 → 蓝 → 紫），避开状态色的红 / 琥珀 / 绿：
 * 头像要是跟「进行中」撞成一片绿，扫视时会被误读成状态。
 */
function avatarStyle(nickname: string): Record<string, string> {
  let hash = 0;
  for (const char of nickname) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 1000;
  }
  return { background: `hsl(${190 + (hash % 140)} 52% 42%)` };
}

function avatarText(nickname: string): string {
  return nickname.trim().slice(0, 1) || '?';
}

/** 现在线位置，超出时间轴范围时贴边 —— 时间轴不为了「现在」而拉伸 */
const nowPercent = computed(() => percentOf(nowSec.value, scale.value));

const nowOutOfRange = computed(
  () => nowPercent.value < 0 || nowPercent.value > 100,
);

/** 给 CSS 的比例，必须 clamp 到 0~1：否则 `left` 的 calc 会把现在线推到容器外 */
const nowRatio = computed(() =>
  Math.min(1, Math.max(0, nowPercent.value / 100)),
);

/* ------------------------------------------------------------------ *
 * 取数
 * ------------------------------------------------------------------ */

/**
 * 拉今日数据。
 *
 * 排班接口要 `biz:schedule:list` 权限，只有预约权限的账号拿不到 —— 这时
 * **静默降级成「只画预约块」**，而不是把整块屏打挂（与预约管理页日历一致）。
 */
async function load(options: { silent?: boolean } = {}) {
  if (!options.silent) loading.value = true;
  else refreshing.value = true;
  error.value = null;
  try {
    const [bookingResult, scheduleResult] = await Promise.all([
      listBookingCalendar({ dateFrom: today, dateTo: today }),
      getScheduleCalendar({
        from: today,
        to: today,
        storeId: storeScope.activeStoreId ?? undefined,
      }).catch(() => null),
    ]);
    rawBlocks.value = bookingResult.items;
    truncated.value = bookingResult.truncated;
    staffs.value = scheduleResult?.staffs ?? [];
    cells.value = scheduleResult?.cells ?? [];
    lastSyncAt.value = dayjs().tz().format('HH:mm:ss');
  } catch (err) {
    error.value = err instanceof Error ? err.message : '数据加载失败';
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

/* ------------------------------------------------------------------ *
 * 全屏 / 返回
 * ------------------------------------------------------------------ */

/** 全屏 API 在各浏览器前缀不一，这里只做「能用就用」的降级，不强行 polyfill */
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    // 用户没给全屏权限（或浏览器不支持）：不报错，挂屏上用 F11 也一样
  }
}

function onFullscreenChange() {
  isFullscreen.value = Boolean(document.fullscreenElement);
}

/**
 * 退出大屏。
 *
 * 从顶栏新窗口点进来的能直接 `close()`；同标签手输地址进来的会被浏览器忽略
 * （「只能关闭由脚本打开的窗口」），这时退回后台首页。所以不能靠
 * `window.opener` 判断 —— 入口用的是 `noopener`，它在那儿恒为 null。
 */
function leave() {
  window.close();
  window.setTimeout(() => {
    window.location.href = import.meta.env.BASE_URL || '/';
  }, 150);
}

/* ------------------------------------------------------------------ *
 * 定时器
 * ------------------------------------------------------------------ */

let tickTimer: ReturnType<typeof setInterval> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  void storeScope.ensureLoaded().then(() => load());
  tickTimer = setInterval(() => {
    nowSec.value = nowSeconds();
  }, 1000);
  refreshTimer = setInterval(() => void load({ silent: true }), REFRESH_MS);
  document.addEventListener('fullscreenchange', onFullscreenChange);
});

onBeforeUnmount(() => {
  if (tickTimer) clearInterval(tickTimer);
  if (refreshTimer) clearInterval(refreshTimer);
  document.removeEventListener('fullscreenchange', onFullscreenChange);
});
</script>

<template>
  <div class="screen-root">
    <!-- 顶栏：品牌 / 门店 / 日期 / 大时钟 / 工具 -->
    <header class="scr-head">
      <div class="scr-head-left">
        <img src="/image/logo.png" alt="" class="scr-logo" />
        <div class="scr-head-text">
          <span class="scr-brand">不做美甲吗</span>
          <span class="scr-store-sub">
            {{ storeScope.activeLabel }} · 在岗 {{ lanes.length }} 人
          </span>
        </div>
      </div>

      <!-- 右侧一串：日期 → 大时钟 → 工具。
           日期与时钟刻意拆成两个元素，而不是合成一句「2026-09-16 周三 14:32:07」——
           秒跳的只有时钟，拆开后日期是静止的，余光不会扫到整行都在抖。 -->
      <div class="scr-head-right">
        <span class="scr-date">{{ dateLabel }}</span>

        <div class="scr-clock-wrap">
          <span class="scr-clock">{{ clockLabel }}</span>
          <span class="scr-sync" :class="{ 'is-error': Boolean(error) }">
            <CircleAlert v-if="error" :size="14" />
            <RefreshCw v-else :size="14" :class="{ spin: refreshing }" />
            {{ error ?? syncedLabel }}
          </span>
        </div>

        <div class="scr-tools">
          <button
            type="button"
            class="scr-tool"
            :title="isFullscreen ? '退出全屏' : '全屏'"
            @click="toggleFullscreen"
          >
            <Minimize v-if="isFullscreen" :size="18" />
            <Maximize v-else :size="18" />
          </button>
          <button
            type="button"
            class="scr-tool"
            title="立即刷新"
            :disabled="refreshing"
            @click="load({ silent: true })"
          >
            <RefreshCw :size="18" :class="{ spin: refreshing }" />
          </button>
          <button
            type="button"
            class="scr-tool"
            title="退出大屏"
            @click="leave"
          >
            <ArrowLeft :size="18" />
          </button>
        </div>
      </div>
    </header>

    <!-- 概览：远距离一眼看总量。
         每张卡 = 图标 + 标签 + 大数字，图标只是「找得到」的锚点，真正的信息是大数字。 -->
    <div class="scr-stats">
      <div class="scr-stat tone-total">
        <span class="scr-stat-icon"><CalendarCheck :size="22" /></span>
        <div class="scr-stat-body">
          <span class="scr-stat-label">今日预约</span>
          <span class="scr-stat-num">{{ stats.total }}</span>
          <!-- 取消 / 爽约不上时间轴，但不代表这单没发生过，单列一行小字 -->
          <span v-if="stats.cancelled" class="scr-stat-note">
            另有 {{ stats.cancelled }} 单已取消
          </span>
        </div>
      </div>

      <div class="scr-stat tone-active">
        <span class="scr-stat-icon"><Activity :size="22" /></span>
        <div class="scr-stat-body">
          <span class="scr-stat-label">进行中</span>
          <span class="scr-stat-num">{{ stats.active }}</span>
          <!-- 超时单数不单开一张卡（设计稿是 6 卡），但它是店里最该动手的信号，
               以红色备注挂在「进行中」下面：出现了就跳出来，没出现就不占地方。 -->
          <span v-if="stats.overtime" class="scr-stat-note is-alert">
            {{ stats.overtime }} 单超时未完成
          </span>
        </div>
      </div>

      <div class="scr-stat tone-soon">
        <span class="scr-stat-icon"><Timer :size="22" /></span>
        <div class="scr-stat-body">
          <span class="scr-stat-label">30 分钟内开始</span>
          <span class="scr-stat-num">{{ stats.soon }}</span>
        </div>
      </div>

      <div class="scr-stat tone-upcoming">
        <span class="scr-stat-icon"><Clock :size="22" /></span>
        <div class="scr-stat-body">
          <span class="scr-stat-label">待服务</span>
          <span class="scr-stat-num">{{ stats.upcoming }}</span>
        </div>
      </div>

      <div class="scr-stat tone-done">
        <span class="scr-stat-icon"><CircleCheck :size="22" /></span>
        <div class="scr-stat-body">
          <span class="scr-stat-label">已完成</span>
          <span class="scr-stat-num">{{ stats.done }}</span>
        </div>
      </div>

      <div class="scr-stat tone-staff">
        <span class="scr-stat-icon"><Users :size="22" /></span>
        <div class="scr-stat-body">
          <!-- 写「在岗」而不是「美甲师数」：这个数字是「今天有排班或有单的人」，
               不是档案里挂着的全部美甲师，名字得跟口径一致。 -->
          <span class="scr-stat-label">在岗美甲师</span>
          <span class="scr-stat-num">{{ lanes.length }}</span>
        </div>
      </div>
    </div>

    <!-- 主体：每行一位美甲师，横向时间轴 -->
    <div class="scr-body">
      <!-- 面板头：左边说明这块屏在讲什么，右边是颜色词典。
           块内**不写状态文字**（省下的那行全给字号，隔三五米才看得清），
           所以图例是必需件，不是装饰。 -->
      <div class="scr-panel-head">
        <span class="scr-panel-title">今日排期</span>
        <span class="scr-panel-sub">共 {{ stats.total }} 单</span>
        <div class="scr-legend">
          <span v-for="tone in TONE_ORDER" :key="tone" class="scr-legend-item">
            <span class="scr-legend-chip" :class="`tone-${tone}`" />
            {{ TONE_LABELS[tone] }}
          </span>
        </div>
      </div>

      <div v-if="loading" class="scr-hint">正在加载今日排期…</div>

      <div v-else-if="!lanes.length" class="scr-hint">
        <span class="scr-hint-title">今天还没有排班或预约</span>
        <span class="scr-hint-sub">排班与预约一进来，这里会自动显示</span>
      </div>

      <div v-else class="scr-lanes">
        <!-- 刻度行 -->
        <div class="scr-ruler-label" />
        <div class="scr-ruler">
          <span
            v-for="tick in scale.ticks"
            :key="tick"
            class="scr-tick"
            :style="{ left: `${percentOf(tick, scale)}%` }"
          >
            {{ secondsLabel(tick) }}
          </span>
        </div>

        <!-- 每位美甲师一行 -->
        <template v-for="lane in laneViews" :key="lane.staffId">
          <div class="scr-lane-label">
            <span
              class="scr-avatar"
              :style="avatarStyle(lane.nickname)"
              aria-hidden="true"
            >
              {{ avatarText(lane.nickname) }}
            </span>
            <span class="scr-lane-text">
              <span class="scr-name">{{ lane.nickname }}</span>
              <span class="scr-state" :class="`is-${lane.state}`">
                {{ laneStateLabel(lane) }}
              </span>
            </span>
          </div>

          <div class="scr-track">
            <span
              v-for="tick in scale.ticks"
              :key="`g${tick}`"
              class="scr-gridline"
              :style="{ left: `${percentOf(tick, scale)}%` }"
            />
            <span
              v-for="(shift, index) in lane.shifts"
              :key="`s${index}`"
              class="scr-shift"
              :style="rangeStyle(shift.startSec, shift.endSec, scale)"
            />

            <div
              v-for="block in lane.blocks"
              :key="block.id"
              class="scr-block"
              :class="[`tone-${block.tone}`, `is-${block.size}`]"
              :style="rangeStyle(block.startSec, block.endSec, scale, 3.2)"
            >
              <!-- 行 1「谁」+ 右端的次要信息：姓名与「到店 / 时长」分列两端。
                   两端而不是都堆在左边 —— 块宽就是时段长度，堆在左边会空出一大片纯色。 -->
              <span class="scr-block-top">
                <!-- 顾客首字头像与时长都是「装饰件」，只在很宽的块上摆（见 `showDeco`）。
                     头像用中性半透明白圈 + 继承块的字色，不另派生色相 ——
                     泳道左侧的美甲师头像已经用掉了色相区分，块里再来一套彩色圈，
                     两者会被当成同一类信息。 -->
                <span v-if="block.showDeco" class="scr-block-ava">
                  {{ avatarText(block.customerName) }}
                </span>
                <span class="scr-block-who">{{ block.customerName }}</span>
                <span v-if="block.arrived" class="scr-block-flag">到店</span>
                <span v-else-if="block.showDeco" class="scr-block-dur">
                  {{ block.durationLabel }}
                </span>
              </span>
              <!-- 行 2「还剩多久」：独享一整行、字号最大，而且**横贯整块** ——
                   抬头看屏真正要的就是这个答案，塞在角落里只会被忽略。 -->
              <span
                v-if="block.badge && block.size !== 'xs'"
                class="scr-block-badge"
                :class="`is-${block.badgeKind}`"
              >
                {{ block.badge }}
              </span>
              <!-- 行 3「几点到几点」-->
              <span v-if="block.size !== 'xs'" class="scr-block-time">
                {{ block.startLabel }}–{{ block.endLabel }}
              </span>
              <span
                v-if="block.tone === 'active' || block.tone === 'overtime'"
                class="scr-block-progress"
                :style="{ width: `${block.progressPercent}%` }"
              />
            </div>
          </div>
        </template>

        <!-- 现在线：跨所有泳道的一条竖线，两端带箭头。
             颜色是青而非红 —— 红已经被「超时」占满，两条红线同时出现在屏上，
             看的人会以为现在线也是个告警。青在这套色板里是唯一没被状态占用的色。 -->
        <div
          class="scr-nowline"
          :class="{ 'is-out': nowOutOfRange }"
          :style="{ '--scr-now-ratio': nowRatio }"
        />
      </div>
    </div>

    <footer v-if="truncated" class="scr-foot">
      今日预约过多，已只展示前 1000 条
    </footer>
  </div>
</template>

<style scoped>
/*
 * 固定深色主题：变量只作用在本页（`--scr-*`），不进全局 —— 后台主题是用户可切的，
 * 而这块屏必须**永远是深底高对比**，否则浅色主题下色块会糊成一片。
 */
.screen-root {
  --scr-bg: #070b14;
  --scr-panel: #0e1626;
  --scr-panel-2: #121c30;
  --scr-line: #1d2942;
  --scr-text: #e9eefc;
  --scr-dim: #8ba1c6;

  /* 每个状态的「代表色」：统计卡的字色、泳道状态胶囊用它；
     时间轴上那些块铺的是它的渐变版（见 `.scr-block.tone-*`），保证同一状态同一个色系。 */
  --scr-upcoming: #6b7af5;
  --scr-soon: #f59e0b;
  --scr-active: #22c55e;
  --scr-overtime: #ef4444;
  --scr-done: #64748b;

  /* 现在线用青：红、琥珀、绿、酸蓝都已经被「状态」占满，
     再拿一个去画「现在」，看屏的人会分不清哪个是告警。 */
  --scr-now: #2dd4bf;

  --scr-label-w: clamp(120px, 9vw, 230px);

  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100vh;
  overflow: hidden;
  color: var(--scr-text);
  background: var(--scr-bg);
}

/* ---------- 顶栏 ---------- */

.scr-head {
  display: flex;
  align-items: center;
  gap: clamp(12px, 1.4vw, 32px);
  flex-shrink: 0;
  padding: clamp(10px, 1vw, 20px) clamp(14px, 1.4vw, 28px);
  background: var(--scr-panel);
  border-bottom: 1px solid var(--scr-line);
}

.scr-head-left {
  display: flex;
  align-items: center;
  gap: clamp(8px, 0.7vw, 16px);
  min-width: 0;
}

.scr-logo {
  width: clamp(28px, 2.4vw, 52px);
  height: clamp(28px, 2.4vw, 52px);
  object-fit: contain;
  flex-shrink: 0;
}

.scr-head-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

/* 品牌名：大屏上它是「这块屏是哪家店」的第一眼信标，所以字号给到与门店名同级，
   只靠「白色重字 vs 灰色小字」拉开层级。 */
.scr-brand {
  font-size: clamp(16px, 1.35vw, 32px);
  font-weight: 800;
  letter-spacing: 0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.scr-store-sub {
  font-size: clamp(11px, 0.72vw, 16px);
  color: var(--scr-dim);
  white-space: nowrap;
}

/* 右侧一串整体靠右：日期静、时钟动、工具可点，三者视线权重递减 */
.scr-head-right {
  display: flex;
  align-items: center;
  gap: clamp(10px, 1vw, 26px);
  min-width: 0;
  margin-left: auto;
}

.scr-date {
  font-size: clamp(14px, 1.05vw, 24px);
  font-weight: 600;
  color: var(--scr-dim);
  white-space: nowrap;
}

.scr-clock-wrap {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}

.scr-clock {
  font-size: clamp(26px, 2.5vw, 58px);
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  letter-spacing: 0.02em;
}

.scr-sync {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: clamp(10px, 0.68vw, 15px);
  color: var(--scr-dim);
  white-space: nowrap;
}

.scr-sync.is-error {
  color: #fca5a5;
}

.scr-tools {
  display: flex;
  align-items: center;
  gap: clamp(4px, 0.4vw, 10px);
  flex-shrink: 0;
}

.scr-tool {
  display: flex;
  align-items: center;
  justify-content: center;
  width: clamp(30px, 2.4vw, 46px);
  height: clamp(30px, 2.4vw, 46px);
  color: var(--scr-dim);
  cursor: pointer;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 10px;
  transition:
    color 0.15s,
    background-color 0.15s,
    border-color 0.15s;
}

.scr-tool:hover {
  color: var(--scr-text);
  background: var(--scr-panel-2);
  border-color: var(--scr-line);
}

.scr-tool:disabled {
  cursor: default;
  opacity: 0.45;
}

/* ---------- 概览 ---------- */

.scr-stats {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: clamp(8px, 0.8vw, 18px);
  flex-shrink: 0;
  padding: clamp(10px, 0.9vw, 18px) clamp(14px, 1.4vw, 28px) 0;
}

.scr-stat {
  display: flex;
  align-items: center;
  gap: clamp(8px, 0.7vw, 16px);
  min-width: 0;
  padding: clamp(8px, 0.75vw, 16px) clamp(10px, 0.9vw, 20px);
  background: var(--scr-panel);
  border: 1px solid var(--scr-line);
  border-radius: 12px;
}

/* 图标只是「找得到」的锚点 —— 六张卡形状一样，靠它的颜色和形状才能在余光里区分。
   信息主体是下面的大数字，所以图标块尺寸封顶，不跟字号一起放大。 */
.scr-stat-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: clamp(30px, 2.6vw, 54px);
  height: clamp(30px, 2.6vw, 54px);
  color: var(--scr-dim);
  background: rgb(255 255 255 / 6%);
  border-radius: 10px;
}

.scr-stat-icon :deep(svg) {
  width: 55%;
  height: 55%;
}

.scr-stat-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.scr-stat-num {
  font-size: clamp(24px, 2.2vw, 52px);
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.scr-stat-label {
  font-size: clamp(14px, 1vw, 24px);
  color: var(--scr-dim);
  white-space: nowrap;
}

.scr-stat-note {
  font-size: clamp(12px, 0.85vw, 20px);
  color: #6b7b96;
  white-space: nowrap;
}

/* 超时提醒：整块屏里唯一一行「自己跳出来」的字，给告警红 */
.scr-stat-note.is-alert {
  font-weight: 700;
  color: #fca5a5;
}

.scr-stat.tone-total .scr-stat-icon {
  color: #7ea8f5;
  background: rgb(47 107 216 / 18%);
}

.scr-stat.tone-active .scr-stat-icon {
  color: #4ade80;
  background: rgb(34 197 94 / 18%);
}

.scr-stat.tone-active .scr-stat-num {
  color: var(--scr-active);
}

.scr-stat.tone-soon .scr-stat-icon {
  color: #fbbf24;
  background: rgb(245 158 11 / 18%);
}

.scr-stat.tone-soon .scr-stat-num {
  color: var(--scr-soon);
}

.scr-stat.tone-upcoming .scr-stat-icon {
  color: #a3b3ff;
  background: rgb(91 108 240 / 20%);
}

.scr-stat.tone-upcoming .scr-stat-num {
  color: #a3b3ff;
}

.scr-stat.tone-done .scr-stat-icon {
  color: #9aa8bd;
  background: rgb(100 116 139 / 20%);
}

.scr-stat.tone-done .scr-stat-num {
  color: #9aa8bd;
}

.scr-stat.tone-staff .scr-stat-icon {
  color: var(--scr-now);
  background: rgb(45 212 191 / 16%);
}

.scr-stat.tone-staff .scr-stat-num {
  color: #7fe7d8;
}

/* 窗口窄时（开发时的小窗、竖屏副屏）统计卡折成三列，别把数字挤掉 */
@media (max-width: 1199px) {
  .scr-stats {
    grid-template-columns: repeat(3, 1fr);
  }
}

/* ---------- 面板头 / 图例 ---------- */

.scr-panel-head {
  display: flex;
  align-items: center;
  gap: clamp(8px, 0.8vw, 18px);
  flex-shrink: 0;
  min-width: 0;
}

.scr-panel-title {
  font-size: clamp(17px, 1.35vw, 30px);
  font-weight: 800;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.scr-panel-sub {
  font-size: clamp(13px, 0.9vw, 21px);
  color: var(--scr-dim);
  white-space: nowrap;
}

.scr-legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: clamp(8px, 0.9vw, 22px);
  margin-left: auto;
}

.scr-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: clamp(13px, 0.95vw, 22px);
  color: var(--scr-dim);
  white-space: nowrap;
}

/* 图例色块**照抄各 tone 的填充**（含渐变方向），不图省事去引 `--scr-*` 单色 ——
   图例的唯一职责就是「墙上这个颜色 = 屏上那个颜色」，稍有偏差它就白摆了。 */
.scr-legend-chip {
  width: clamp(12px, 0.95vw, 20px);
  height: clamp(12px, 0.95vw, 20px);
  border-radius: 4px;
}

.scr-legend-chip.tone-upcoming {
  background: linear-gradient(180deg, #6b7af5, #4b5ada);
}

.scr-legend-chip.tone-soon {
  background: linear-gradient(180deg, #fbbf24, #f59e0b);
}

.scr-legend-chip.tone-active {
  background: linear-gradient(180deg, #4ade80, #22c55e);
}

.scr-legend-chip.tone-overtime {
  background: linear-gradient(180deg, #f87171, #dc2626);
}

.scr-legend-chip.tone-done {
  background: #334155;
}

/* ---------- 泳道矩阵 ---------- */

.scr-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: clamp(8px, 0.7vw, 16px);
  min-height: 0;
  padding: clamp(10px, 0.9vw, 18px) clamp(14px, 1.4vw, 28px);
}

.scr-lanes {
  position: relative;
  display: grid;
  flex: 1;
  /* 第 1 行是刻度行（按内容高），其后的泳道行**平分剩余高度** ——
     店里只有两三位美甲师时，行高会被擑开铺满整块屏，而不是挤在顶部留一片黑。
     行多到装不下时由 minmax 的下限兜住，多余部分走纵向滚动。 */
  grid-auto-rows: minmax(clamp(56px, 5.6vh, 118px), 1fr);
  grid-template-columns: var(--scr-label-w) 1fr;
  grid-template-rows: auto;
  min-height: 0;
  /* 必须显式写 `overflow-x: hidden`：只要 `overflow-y` 不是 visible，
     浏览器就会把 `overflow-x` 算成 auto，尾部刻度那半个标签足以拉出一条横向滚动条。 */
  overflow: hidden auto;
}

.scr-ruler-label {
  border-bottom: 1px solid var(--scr-line);
}

.scr-ruler {
  position: relative;
  height: clamp(20px, 1.6vw, 32px);
  border-bottom: 1px solid var(--scr-line);
}

.scr-tick {
  position: absolute;
  bottom: 4px;
  font-size: clamp(14px, 1vw, 24px);
  color: var(--scr-dim);
  font-variant-numeric: tabular-nums;
  transform: translateX(-50%);
}

/* 两端刻度贴边对齐：默认的居中定位会让尾巴上的「22:00」有一半落到轨道外，
   而被 `overflow-x: hidden` 裁成「22:」。 */
.scr-tick:last-child {
  transform: translateX(-100%);
}

.scr-lane-label {
  display: flex;
  align-items: center;
  gap: clamp(6px, 0.55vw, 12px);
  min-width: 0;
  padding: clamp(6px, 0.5vw, 12px) clamp(6px, 0.6vw, 14px);
  border-bottom: 1px solid var(--scr-line);
}

/* 首字头像：档案里没有头像字段，底色由昵称派生（见 avatarStyle） */
.scr-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: clamp(26px, 2.2vw, 46px);
  height: clamp(26px, 2.2vw, 46px);
  font-size: clamp(12px, 0.95vw, 20px);
  font-weight: 800;
  color: #fff;
  border-radius: 50%;
}

.scr-lane-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.scr-name {
  font-size: clamp(18px, 1.55vw, 36px);
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 状态徽章：贴昵称下方的胶囊。窄屏时会把「空闲 · 下一单 14:30」截断，
   宁可截断也不换行 —— 换行会把行高顶开，把右侧时间轴整行挤歪。 */
.scr-state {
  align-self: flex-start;
  max-width: 100%;
  padding: 0 clamp(4px, 0.35vw, 8px);
  overflow: hidden;
  font-size: clamp(13px, 0.95vw, 22px);
  color: var(--scr-dim);
  white-space: nowrap;
  text-overflow: ellipsis;
  background: rgb(255 255 255 / 7%);
  border-radius: 999px;
}

/* 「进行中」给实心绿：一行里只有它需要「抬头看见名字就知道她在忙」，
   半透底在深色屏上太安静，撑不起这份注意力。 */
.scr-state.is-busy {
  font-weight: 800;
  color: #04240f;
  background: var(--scr-active);
}

.scr-track {
  position: relative;
  /* 高度交给 grid 行高（`grid-auto-rows`）决定，这里不能设 min-height ——
     行高小于它时会把泳道顶出容器，右侧时间轴与左侧姓名整列错位。 */
  min-height: 0;
  border-bottom: 1px solid var(--scr-line);
  /* 让块能用 `cqh` 量到**行高**（见 `.scr-block` 的 `font-size`）。
     `size` 在这里是安全的：轨道的高宽都由 grid 定，与块的内容无关。 */
  container-type: size;
}

.scr-gridline {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--scr-line);
  opacity: 0.5;
}

/* 班次底：今天这个人应该在店里的时段，做块的下衬 */
.scr-shift {
  position: absolute;
  top: 0;
  bottom: 0;
  background: var(--scr-panel-2);
}

/* ---------- 预约块 ---------- */

.scr-block {
  /* 块内小片的配色（到店 / 时长 / 量化徽章）。深底块用白片深字，亮底块反过来 ——
     存在这两个变量的原因很具体：不区分就会踩到「白字块 + 白片」= 白底白字，
     超时块那个「已超 8 分」就这么消失过。 */
  --scr-chip-bg: #fff;
  --scr-chip-fg: #0b1220;

  position: absolute;
  top: clamp(4px, 0.42vw, 10px);
  bottom: clamp(4px, 0.42vw, 10px);
  /* 自己也是容器：内部元素要用 `cqw` 量**本块的宽**
     （`cqh` 只能够到 `.scr-track` 那层，量出来的是整条轨道的高度）。 */
  container-type: inline-size;

  /* 基准字号跟**泳道行高**走（`cqh` 量的是 `.scr-track`）：
     行数多 → 行高低 → 字自动缩小，三行字永远塞得下；
     换 4K 屏 → 行高翻倍 → 字跟着翻倍，不用改一行代码。
     系数 18 的来历：块里放三行（姓名 / 剩余 / 时段）加间距与内边距约合
     3.6 个基准字号，× 0.18 ≈ 65% 的块高，剩下的是呼吸空间。
     （上一版这里是 `vw` 系的一串 clamp，1080p 下算出来只有 18px ——
     263px 高的块装 18px 的字，等于把这块屏最大的优势白扔了。） */
  font-size: clamp(14px, 18cqh, 50px);
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0.12em;
  /* 底部刻意多留一档：进度条贴底画，不留缝它会压住最后一行字 */
  padding: 0.14em 0.18em 0.22em;
  overflow: hidden;
  border-radius: clamp(8px, 0.55em, 18px);
  box-shadow: 0 2px 8px rgb(0 0 0 / 35%);
  transition: filter 0.3s;
}

/* 块越窄，横向上能放的字越少，字号退一档 ——
   否则每行都被 ellipsis 吃掉一半，不如小而完整。 */
.scr-block.is-sm {
  font-size: clamp(12px, 12cqh, 32px);
}

.scr-block.is-xs {
  font-size: clamp(11px, 8cqh, 22px);
}

/* 宽块把三行铺开，把两侧的空白用掉 ——
   块宽 = 时段长度，一个三小时的预约能占到八百多像素，而三行文字本来就只占三分之一，
   不铺开就是一大片纯色。铺法是：行 1 姓名与到店标 / 时长分列两端、行 2 的提示横贯整块、
   行 3 时段居中。三行的重心仍落在同一条中轴上，远看不会散。
   窄块（sm / xs）不做这一步 —— 那点宽度本来就紧，再拉开只会把每行切得更碎。 */
.scr-block.is-md .scr-block-badge,
.scr-block.is-lg .scr-block-badge {
  align-self: stretch;
  text-align: center;
}

.scr-block.is-md .scr-block-time,
.scr-block.is-lg .scr-block-time {
  text-align: center;
}

/* 行 1：谁 */
.scr-block-top {
  display: flex;
  align-items: center;
  gap: 0.24em;
  min-width: 0;
  overflow: hidden;
}

/* 名字字号的双约束：不能超过按行高算出的基准，也不能超过块宽的 30%（约 3.3 个汉字宽）——
   块窄的时候按高度算出来的 50px 只能放下两个半字，反而比小一号、能完整看清三个字差。 */
.scr-block-who {
  min-width: 0;
  overflow: hidden;
  font-size: min(1em, 30cqw);
  font-weight: 800;
  line-height: 1.15;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 顾客首字头像：中性半透明白圈 + 继承块的字色。
   不另派生色相是故意的 —— 泳道左侧的美甲师头像已经用掉了色相区分，
   块里再来一套彩色圈，两者会被当成同一类信息。 */
.scr-block-ava {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 1.15em;
  height: 1.15em;
  font-size: 0.62em;
  font-weight: 800;
  background: rgb(255 255 255 / 32%);
  border-radius: 50%;
}

/* 到店标 / 时长：行 1 的右端。两个都靠 `margin-left: auto` 顶到最右，
   把姓名与它们之间的空白用掉 —— 这正是「填满」要做的事。
   二者在模板里互斥（到店标优先），所以不会两个一起挤在右边。 */
.scr-block-flag,
.scr-block-dur {
  flex-shrink: 0;
  margin-left: auto;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.scr-block-flag {
  padding: 0 0.26em;
  font-size: 0.6em;
  color: var(--scr-chip-fg);
  background: var(--scr-chip-bg);
  border-radius: 0.24em;
}

/* 时长是块里唯一的纯参考信息（时段本身已隐含它），所以不做成片、字号也压到比时段更低 ——
   它在行 1 的作用就是把右端补齐，不占用行 2（那是提示位）。 */
.scr-block-dur {
  font-size: min(0.62em, 13cqw);
  opacity: 0.72;
}

/* 行 2「还剩多久」：整块最该先被读到的一行，所以独占一行、给全块最大的字号。
   字号是双约束：既不超过基准的 1.15 倍，也不超过块宽的 17%（约 5.3 个字宽）——
   「还剩 25 分」正好卡在这个宽度里，不用 ellipsis 也能完整显示。 */
.scr-block-badge {
  align-self: flex-start;
  max-width: 100%;
  padding: 0.05em 0.28em;
  overflow: hidden;
  font-size: min(1.15em, 17cqw);
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  color: var(--scr-chip-fg);
  white-space: nowrap;
  background: var(--scr-chip-bg);
  border-radius: 0.24em;
}

/* 「还有 5 分钟还没做完」：在亮绿的进行中块上换红片 ——
   红与绿同时出现，比任何文字都快地被认出来。
   超时块自身的白片已是最高对比，不覆盖。 */
.scr-block.tone-active .scr-block-badge.is-danger {
  --scr-chip-bg: #b91c1c;
  --scr-chip-fg: #fff;
}

/* 行 3：几点到几点。用 `opacity` 压一档而不是换成固定灰字 ——
   块底色是逐个 tone 定的，写死灰字会在灰块（已完成）上糊成一片。
   带块宽约束：`13:15–14:30` 大约占 6 个字宽，超过块宽 16% 就会溢出。 */
.scr-block-time {
  min-width: 0;
  overflow: hidden;
  font-size: min(0.75em, 16cqw);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  opacity: 0.88;
}

/* 进度：画的是「已用时间 / 总时长」。
   用 `currentColor` 而不是白色 —— 进行中 / 超时这两类块是亮底深字，
   白线在亮绿上几乎看不出来；跟着字色走，在任何一块上都保有对比。 */
.scr-block-progress {
  position: absolute;
  bottom: 0;
  left: 0;
  height: max(3px, 0.07em);
  background: currentColor;
  opacity: 0.5;
  transition: width 0.9s linear;
}

/* 待服务：酜蓝，沉在后面，但足够亮到「今天还有这些」一眼可见 */
.scr-block.tone-upcoming {
  color: #fff;
  background: linear-gradient(180deg, #6b7af5, #4b5ada);
}

/* 即将开始：琥珀亮底深字 —— 整屏唯一一个「该准备了」的预警色 */
.scr-block.tone-soon {
  color: #2a1a00;
  background: linear-gradient(180deg, #fbbf24, #f59e0b);
  --scr-chip-bg: rgb(0 0 0 / 62%);
  --scr-chip-fg: #fff;
}

/* 进行中：全场主角，亮绿 + 光晕 + 呼吸 */
.scr-block.tone-active {
  color: #04240f;
  background: linear-gradient(180deg, #4ade80, #22c55e);
  box-shadow:
    0 0 0 2px rgb(34 197 94 / 45%),
    0 2px 12px rgb(34 197 94 / 30%);
  --scr-chip-bg: rgb(0 0 0 / 62%);
  --scr-chip-fg: #fff;
  animation: scr-breathe 2.4s ease-in-out infinite;
}

/* 超时未完成：红，闪得更急 */
.scr-block.tone-overtime {
  color: #fff;
  background: linear-gradient(180deg, #f87171, #dc2626);
  box-shadow:
    0 0 0 2px rgb(239 68 68 / 50%),
    0 2px 12px rgb(239 68 68 / 35%);
  animation: scr-breathe 1.2s ease-in-out infinite;
}

/* 已完成：降调，留在时间轴上做「今天进度」的参照。
   底色用 `#334155` 而不是更暗的色 —— 实测 `#2a3648` 在 `#070b14` 的底上会糊掉，
   「今天做过哪些」这条线索就整条消失了；它只需要比泳道底亮一档。 */
.scr-block.tone-done {
  color: #cbd5e1;
  background: #334155;
}

/* 已取消 / 爽约：不上时间轴（见 `isDeadStatus`），保留样式以备将来调试视图 */
.scr-block.tone-dead {
  color: #6b7b96;
  text-decoration: line-through;
  background: transparent;
  border: 1px dashed #3b4a63;
}

@keyframes scr-breathe {
  0%,
  100% {
    filter: brightness(1);
  }

  50% {
    filter: brightness(1.18);
  }
}

/* ---------- 现在线 ---------- */

.scr-nowline {
  position: absolute;
  top: 0;
  bottom: 0;
  left: calc(
    var(--scr-label-w) + (100% - var(--scr-label-w)) * var(--scr-now-ratio)
  );
  width: 3px;
  background: linear-gradient(180deg, var(--scr-now), #14b8a6);
  box-shadow: 0 0 12px rgb(45 212 191 / 75%);
  pointer-events: none;
  transition: left 0.9s linear;
}

/* 两端各一个朝内的三角箭头，把「此刻」夹住。
   箭头**贴边不外扩**（`top: 0` / `bottom: 0`）：泳道容器是 `overflow: hidden auto`，
   往外画的几像素会被直接裁掉，只剩一条没头没尾的线。 */
.scr-nowline::before,
.scr-nowline::after {
  content: '';
  position: absolute;
  left: 50%;
  border-right: 8px solid transparent;
  border-left: 8px solid transparent;
  transform: translateX(-50%);
}

.scr-nowline::before {
  top: 0;
  border-top: 11px solid var(--scr-now);
}

.scr-nowline::after {
  bottom: 0;
  border-bottom: 11px solid var(--scr-now);
}

/* 现在线跑到时间轴外（比如深夜看今天的屏）：淡掉，避免误导 */
.scr-nowline.is-out {
  opacity: 0.35;
  transition: none;
}

/* ---------- 空态 / 页脚 ---------- */

.scr-hint {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 0;
  color: var(--scr-dim);
}

.scr-hint-title {
  font-size: clamp(18px, 1.5vw, 34px);
  font-weight: 700;
  color: var(--scr-text);
}

.scr-hint-sub {
  font-size: clamp(12px, 0.85vw, 19px);
}

.scr-foot {
  flex-shrink: 0;
  padding: 6px clamp(14px, 1.4vw, 28px);
  font-size: clamp(11px, 0.72vw, 16px);
  color: #fca5a5;
  border-top: 1px solid var(--scr-line);
}

.spin {
  animation: scr-spin 1s linear infinite;
}

@keyframes scr-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 挂屏上不该有动画偏好干扰，但系统设了「减少动态」就照办 */
@media (prefers-reduced-motion: reduce) {
  .scr-block.tone-active,
  .scr-block.tone-overtime {
    animation: none;
  }

  .scr-nowline,
  .scr-block-progress {
    transition: none;
  }
}
</style>
