<script setup lang="ts">
import { computed, ref } from 'vue';
import { Bot } from 'lucide-vue-next';
import { useAiChat } from './composables/useAiChat';
import ChatInput from './components/ChatInput.vue';
import DetailPanel from './components/DetailPanel.vue';
import MessageArea from './components/MessageArea.vue';
import SessionList from './components/SessionList.vue';

/**
 * AI 操作助手页面编排：左侧会话列表 + 中间对话 + 右侧操作详情。
 *
 * 这里**没有**「会话 / AI Operations」两个 tab —— 左侧就是统一的会话列表，
 * 顶部直接是「新建对话」按钮（见 SessionList）。
 */

// ---------- 布局折叠状态 ----------
const leftCollapsed = ref(false);
/** 操作详情默认收起：主链路（问 → 答 → 确认）已经内嵌在消息里，详情是审计视图 */
const rightCollapsed = ref(true);

// ---------- 核心逻辑 ----------
const {
  sessions,
  currentSession,
  messages,
  input,
  sending,
  thinking,
  toolCalls,
  waitingApproval,
  riskLevel,
  pendingApproval,
  approving,
  currentTaskId,
  taskSteps,
  taskStatus,
  rollbacking,
  taskHistory,
  handleCreateSession,
  selectSession,
  handleRenameSession,
  handleDeleteSession,
  handleSend,
  handleApprove,
  handleReject,
  handleRollbackTask,
} = useAiChat();

/** 标题栏文案：有会话且有消息才显示标题，否则给一句弱提示 */
const headerTitle = computed(() => {
  if (currentSession.value && messages.value.length) {
    return currentSession.value.title;
  }
  return '新对话';
});

const headerDim = computed(
  () => !currentSession.value || !messages.value.length,
);

/** 删除会话：标题从会话列表实时取，不缓存（改选之后不会显示旧名字） */
function onDeleteSession(id: number) {
  const title = sessions.value.find((s) => s.id === id)?.title ?? '该会话';
  handleDeleteSession(id, title);
}
</script>

<template>
  <div class="flex h-full gap-3 p-3">
    <!-- 左侧：会话列表 -->
    <SessionList
      :sessions="sessions"
      :current-session="currentSession"
      :collapsed="leftCollapsed"
      @create="handleCreateSession"
      @select="selectSession"
      @rename="handleRenameSession"
      @delete="onDeleteSession"
      @toggle="leftCollapsed = !leftCollapsed"
    />

    <!-- 中间：对话 -->
    <section
      class="flex flex-col flex-1 min-w-0 rounded-2xl border border-[var(--app-border)] shadow-[var(--app-shadow)] bg-[var(--app-bg-card)] overflow-hidden"
    >
      <div
        class="flex items-center gap-2 h-12 shrink-0 px-4 border-b border-[var(--app-border)]"
      >
        <span
          class="flex items-center justify-center w-6 h-6 shrink-0 rounded-lg"
          :class="headerDim ? 'bg-[var(--app-bg-hover)]' : 'ai-gradient'"
        >
          <Bot
            :size="14"
            :color="headerDim ? 'var(--app-text-muted)' : '#fff'"
          />
        </span>
        <span
          class="text-14px font-600 truncate"
          :class="headerDim ? 'text-[var(--app-text-muted)]' : ''"
        >
          {{ headerTitle }}
        </span>
        <span
          v-if="sending"
          class="text-12px text-[var(--app-text-muted)] shrink-0"
        >
          正在生成…
        </span>
      </div>

      <MessageArea
        :messages="messages"
        :thinking="thinking"
        :pending-approval="pendingApproval"
        :approving="approving"
        @confirm="handleApprove"
        @cancel="handleReject"
        @ask="handleSend"
      />

      <ChatInput
        v-model="input"
        :sending="sending"
        :disabled="sending"
        @send="handleSend()"
      />
    </section>

    <!-- 右侧：操作详情 -->
    <DetailPanel
      :collapsed="rightCollapsed"
      :risk-level="riskLevel"
      :waiting-approval="waitingApproval"
      :tool-calls="toolCalls"
      :current-task-id="currentTaskId"
      :task-steps="taskSteps"
      :task-status="taskStatus"
      :rollbacking="rollbacking"
      :task-history="taskHistory"
      @toggle="rightCollapsed = !rightCollapsed"
      @rollback="handleRollbackTask"
    />
  </div>
</template>
