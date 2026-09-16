<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  ChevronsLeft,
  ChevronsRight,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-vue-next';
import { LewInput, LewTextTrim } from 'lew-ui';
import { formatDateTime } from '~/composables/useFormat';
import type { AiSession } from '~/types/api';

/**
 * 左侧会话列表。
 *
 * 结构对齐设计稿：顶部「新建对话」主按钮 + 搜索框，下面按时间分组（今天 / 昨天 /
 * 更早）渲染会话行，行 hover 出删除。**没有**「会话 / AI Operations」两个 tab ——
 * 那两套切换逻辑讲不清，统一成一条列表。
 */
const props = defineProps<{
  sessions: AiSession[];
  currentSession: AiSession | null;
  collapsed: boolean;
}>();

const emit = defineEmits<{
  (e: 'create'): void;
  (e: 'select', id: number): void;
  (e: 'toggle'): void;
  (e: 'rename', id: number, title: string): void;
  (e: 'delete', id: number): void;
}>();

/** 正在编辑标题的会话 id */
const editingId = ref<number | null>(null);
const editingTitle = ref('');

function startEdit(session: AiSession) {
  editingId.value = session.id;
  editingTitle.value = session.title;
}

function commitEdit() {
  const title = editingTitle.value.trim();
  if (editingId.value !== null && title) {
    emit('rename', editingId.value, title);
  }
  editingId.value = null;
}

function cancelEdit() {
  editingId.value = null;
}

// ---------- 搜索（本地过滤） ----------

const keyword = ref('');

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return props.sessions;
  return props.sessions.filter((s) => s.title.toLowerCase().includes(kw));
});

// ---------- 时间分组 ----------

/** 按「今天 / 昨天 / 更早」分桶（东八区，与展示口径一致） */
function groupLabel(updatedAt: string): string {
  const day = formatDateTime(updatedAt, 'YYYY-MM-DD');
  const today = formatDateTime(new Date(), 'YYYY-MM-DD');
  const yesterday = formatDateTime(
    new Date(Date.now() - 24 * 60 * 60 * 1000),
    'YYYY-MM-DD',
  );
  if (day === today) return '今天';
  if (day === yesterday) return '昨天';
  return '更早';
}

/** 分组顺序固定：今天 → 昨天 → 更早（不按出现顺序，避免「更早」跑最上面） */
const GROUP_ORDER = ['今天', '昨天', '更早'];

const groups = computed(() =>
  GROUP_ORDER.map((label) => ({
    label,
    items: filtered.value.filter((s) => groupLabel(s.updatedAt) === label),
  })).filter((group) => group.items.length > 0),
);

/** 展示用标题：后端默认标题「新会话」没有信息量，统一显示为未命名 */
function displayTitle(session: AiSession): string {
  const title = session.title.trim();
  return title === '新会话' ? '未命名对话' : title;
}
</script>

<template>
  <aside
    class="flex flex-col shrink-0 overflow-hidden transition-[width] duration-200"
    :style="{ width: collapsed ? '56px' : '252px' }"
  >
    <!-- 顶部：AI 标识 + 新建对话 -->
    <div class="shrink-0 px-3 pt-3 pb-2">
      <div
        class="flex items-center justify-between mb-2.5"
        :class="{ 'justify-center': collapsed }"
      >
        <template v-if="!collapsed">
          <div class="flex items-center gap-1.5">
            <Sparkles :size="16" class="text-[var(--ai-accent)]" />
            <span class="text-13px font-700">AI 操作助手</span>
          </div>
          <button
            type="button"
            class="flex items-center justify-center w-6 h-6 rounded-md text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-bg-hover)] hover:text-[var(--app-text-primary)]"
            title="收起会话列表"
            @click="emit('toggle')"
          >
            <ChevronsLeft :size="15" />
          </button>
        </template>
        <button
          v-else
          type="button"
          class="flex items-center justify-center w-7 h-7 rounded-md text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-bg-hover)] hover:text-[var(--app-text-primary)]"
          title="展开会话列表"
          @click="emit('toggle')"
        >
          <ChevronsRight :size="15" />
        </button>
      </div>

      <!-- 新建对话：渐变主按钮 -->
      <button
        type="button"
        class="ai-btn-gradient w-full flex items-center justify-center gap-1.5 h-9 rounded-xl text-13px font-600 text-white cursor-pointer border-none"
        :class="{ 'w-9 h-9 mx-auto': collapsed }"
        title="新建对话"
        @click="emit('create')"
      >
        <Plus :size="16" />
        <span v-if="!collapsed">新建对话</span>
      </button>
    </div>

    <template v-if="!collapsed">
      <!-- 搜索会话 -->
      <div class="shrink-0 px-3 pb-2">
        <div
          class="ai-session-search flex items-center gap-2 h-8 px-2.5 rounded-full border border-[var(--app-border)] bg-[var(--app-bg-hover)]"
        >
          <Search :size="13" class="shrink-0 text-[var(--app-text-muted)]" />
          <LewInput
            v-model="keyword"
            size="small"
            placeholder="搜索会话"
            :max-length="50"
            class="flex-1 min-w-0"
          />
        </div>
      </div>

      <!-- 分组会话列表 -->
      <div class="flex-1 overflow-y-auto px-2 pb-2">
        <div v-for="group in groups" :key="group.label" class="mb-1">
          <div
            class="px-2 py-1.5 text-11px font-600 tracking-wide text-[var(--app-text-muted)]"
          >
            {{ group.label }}
          </div>

          <div
            v-for="session in group.items"
            :key="session.id"
            class="group relative flex items-center gap-2 px-2 py-2 mb-1 rounded-xl cursor-pointer transition-colors"
            :class="
              currentSession?.id === session.id
                ? 'bg-[var(--lew-color-primary-light)]'
                : 'hover:bg-[var(--app-bg-hover)]'
            "
            @click="emit('select', session.id)"
          >
            <!--
              会话行**不带头像**：一列全是同一个机器人图标，没有区分度、
              白占 24px 宽度，选中态靠整行底色区分就够了。
            -->
            <div class="flex-1 min-w-0">
              <!-- 编辑态：输入框 -->
              <LewInput
                v-if="editingId === session.id"
                v-model="editingTitle"
                size="small"
                :max-length="200"
                autofocus
                @blur="commitEdit"
                @keydown.enter="commitEdit"
                @keydown.esc="cancelEdit"
                @click.stop
              />
              <!-- 展示态：双击标题可重命名 -->
              <div v-else @dblclick.stop="startEdit(session)">
                <LewTextTrim
                  class="text-13px font-500"
                  :text="displayTitle(session)"
                />
                <div class="text-11px mt-0.5 text-[var(--app-text-muted)]">
                  {{ formatDateTime(session.updatedAt, 'MM-DD HH:mm') }}
                </div>
              </div>
            </div>

            <!-- hover 操作：重命名 + 删除 -->
            <div
              v-if="editingId !== session.id"
              class="absolute right-1.5 top-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
            >
              <button
                type="button"
                class="flex items-center justify-center w-6 h-6 rounded-md bg-[var(--app-bg-card)] text-[var(--app-text-muted)] transition-colors hover:text-[var(--lew-color-primary)]"
                title="重命名"
                @click.stop="startEdit(session)"
              >
                <Pencil :size="12" />
              </button>
              <button
                type="button"
                class="flex items-center justify-center w-6 h-6 rounded-md bg-[var(--app-bg-card)] text-[var(--app-text-muted)] transition-colors hover:text-red-500"
                title="删除会话"
                @click.stop="emit('delete', session.id)"
              >
                <Trash2 :size="12" />
              </button>
            </div>
          </div>
        </div>

        <!-- 空态：区分「没有会话」与「搜不到」 -->
        <div
          v-if="!groups.length"
          class="text-12px text-[var(--app-text-muted)] text-center px-3 py-8 leading-relaxed"
        >
          <template v-if="keyword.trim()">
            没有匹配「{{ keyword.trim() }}」的会话
          </template>
          <template v-else> 暂无会话，点击「新建对话」开始 </template>
        </div>
      </div>
    </template>

    <!-- 折叠态：只显示会话图标 -->
    <div
      v-else
      class="flex-1 overflow-y-auto pt-2 flex flex-col items-center gap-1.5"
    >
      <button
        v-for="session in sessions.slice(0, 8)"
        :key="session.id"
        type="button"
        class="flex items-center justify-center w-9 h-9 rounded-xl cursor-pointer border-none transition-colors"
        :class="
          currentSession?.id === session.id
            ? 'ai-gradient text-white'
            : 'bg-[var(--app-bg-hover)] text-[var(--app-text-muted)] hover:text-[var(--app-text-primary)]'
        "
        :title="displayTitle(session)"
        @click="emit('select', session.id)"
      >
        <Sparkles :size="15" />
      </button>
    </div>
  </aside>
</template>

<style scoped>
/*
 * 搜索框里的 LewInput 去掉自身边框 / 底色 / 阴影，融入外层胶囊（lew-ui 的根节点是 .lew-input-view）。
 *
 * `.ai-session-search` 必须挂在外层胶囊 div（祖先）上：`:deep(x)` 编译成
 * `.祖先[data-v-xxx] x`，若把类名加在 LewInput 上（= 根节点本身），
 * 选择器要求它“是自己的后代”，永远匹配不到，覆盖就会静默失效。
 */
.ai-session-search :deep(.lew-input-view),
.ai-session-search :deep(.lew-input-view:hover),
.ai-session-search :deep(.lew-input-view:focus-within) {
  border: none;
  background: transparent;
  box-shadow: none;
}

/*
 * 外层胶囊已经给了左右内边距 / 图标间距，内层不再补。
 * 原写法 `padding: 0 var(--lew-form-input-padding-small)` 是错的：
 * 该变量本身是「2px 10px」这样的简写，混进 `padding` 后展开成 `0 2px 10px`，
 * 变成「上 0 / 左右 2px / 下 10px」—— 文字既贴左右、又整体偏上。
 */
.ai-session-search :deep(.lew-input-box) {
  padding: 0;
}

.ai-session-search :deep(input) {
  font-size: 12.5px;
}
</style>
