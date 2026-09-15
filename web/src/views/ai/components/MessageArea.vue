<script setup lang="ts">
import { computed } from 'vue';
import {
  ArrowRight,
  CalendarCheck,
  CircleAlert,
  CircleCheck,
  CircleX,
  FileBarChart,
  MessageSquareText,
  ReceiptText,
} from 'lucide-vue-next';
import type { AiApprovalRequired, AiMessage, AiToolCall } from '~/types/api';
import { approvalResultOf, isPlainOutcome } from '../utils/display';
import AiStarIcon from './AiStarIcon.vue';
import ApprovalPanel from './ApprovalPanel.vue';
import MarkdownContent from './MarkdownContent.vue';
import ToolStepCard from './ToolStepCard.vue';

const props = withDefaults(
  defineProps<{
    messages: AiMessage[];
    thinking: boolean;
    /** 当前等待确认的操作（内嵌在对应消息底部展示） */
    pendingApproval: AiApprovalRequired | null;
    /** 确认/取消按钮处理中 */
    approving: 'confirm' | 'cancel' | null;
    /** 推荐问题/快捷标签是否可点（无会话时点击会自动新建） */
    disabled?: boolean;
  }>(),
  { disabled: false },
);

const emit = defineEmits<{
  /** 确认当前待审批操作 */
  (e: 'confirm'): void;
  /** 取消当前待审批操作 */
  (e: 'cancel'): void;
  /** 点推荐问题 / 快捷标签：直接把该问题发出去 */
  (e: 'ask', text: string): void;
}>();

/** 判断消息是否为「正在生成中」 */
function isFresh(message: AiMessage): boolean {
  return !!message._fresh;
}

/** 根据 tool 调用推断步骤状态 */
function toolStatus(
  call: AiToolCall,
): 'running' | 'success' | 'approval' | 'error' | 'cancelled' {
  if (call.result === undefined) return 'running';
  const status = (call.result as { status?: string })?.status;
  if (status === 'waiting_approval') return 'approval';
  if (status === 'error') return 'error';
  if (status === 'cancelled') return 'cancelled';
  return 'success';
}

/** 消息中是否含有「等待审批」的步骤 */
function hasWaitingApproval(message: AiMessage): boolean {
  return !!message.toolCalls?.some((c) => toolStatus(c) === 'approval');
}

/** 找到携带「等待审批」步骤的消息（内嵌确认条挂载于此） */
const approvalMessageId = computed<number | null>(() => {
  const list = props.messages;
  for (let i = list.length - 1; i >= 0; i--) {
    const msg = list[i]!;
    if (
      msg.role === 'assistant' &&
      msg.toolCalls?.some(
        (c) =>
          (c.result as { status?: string } | undefined)?.status ===
          'waiting_approval',
      )
    ) {
      return msg.id;
    }
  }
  return null;
});

/** 审批结果标题文案 */
function outcomeLabel(outcome: 'success' | 'cancelled' | 'error'): string {
  if (outcome === 'success') return '操作已执行完成';
  if (outcome === 'cancelled') return '操作已取消';
  return '操作执行失败';
}

/** 审批结果消息：正文为后端兜底短句时隐藏正文（结果条标题已表达） */
function shouldShowContent(message: AiMessage): boolean {
  if (!message.content) return false;
  const meta = approvalResultOf(message);
  return !(meta && isPlainOutcome(message.content));
}

/**
 * 推荐问题：直接回答「你能问我什么」。
 *
 * 文案全部落在本系统真实可查的范围内（营收 / 排班 / 未收款 / 报表），
 * 不写「查询最近注册的用户」这类后台基座示例 —— 美甲店店员用不上，
 * 点了还会得到一份跟业务无关的答案。
 */
const RECOMMENDED = [
  { tag: '查看', text: '查看今日门店营收概况', icon: ReceiptText },
  { tag: '安排', text: '帮我安排本周美甲师排班', icon: CalendarCheck },
  { tag: '查询', text: '查询所有未收款的订单', icon: MessageSquareText },
  { tag: '生成', text: '生成上周销售报表', icon: FileBarChart },
] as const;

/** 快捷标签：覆盖高频场景，点一下即发起对话 */
const QUICK_TAGS = [
  '今日营收查询',
  '排班调整',
  '会员消费',
  '退款审批',
  '未收款订单',
  '次卡核销记录',
] as const;

function ask(text: string) {
  if (props.disabled || props.thinking) return;
  emit('ask', text);
}
</script>

<template>
  <div id="ai-messages" class="flex-1 overflow-y-auto">
    <!-- 空态：欢迎页（发光 AI 图标 + 推荐问题卡 + 快捷标签） -->
    <div
      v-if="!messages.length && !thinking"
      class="min-h-full flex flex-col justify-center px-6 py-6"
    >
      <div class="flex items-start gap-4">
        <div class="ai-glow shrink-0 mt-0.5">
          <AiStarIcon :size="80" />
        </div>
        <div class="pt-1.5">
          <h2 class="m-0 text-22px font-800 tracking--1%">AI 操作助手</h2>
          <p class="m-0 mt-1.5 text-13px text-[var(--app-text-secondary)]">
            用自然语言操作系统，试试以下
          </p>
        </div>
      </div>

      <!-- 推荐问题：2×2 -->
      <div class="mt-5 grid grid-cols-2 gap-3">
        <button
          v-for="(item, index) in RECOMMENDED"
          :key="item.text"
          type="button"
          class="ai-pick-card app-rise-in flex items-center gap-3 p-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg-card)] text-left cursor-pointer"
          :style="{ '--app-stagger': `${index * 45}ms` }"
          :disabled="disabled || thinking"
          @click="ask(item.text)"
        >
          <span
            class="flex items-center justify-center w-9 h-9 shrink-0 rounded-xl ai-gradient"
          >
            <component :is="item.icon" :size="16" color="#fff" />
          </span>
          <span class="flex-1 min-w-0">
            <span class="block text-12px text-[var(--app-text-muted)]">
              {{ item.tag }}
            </span>
            <span class="block text-13.5px font-600 mt-0.5 leading-snug">
              {{ item.text }}
            </span>
          </span>
          <ArrowRight
            :size="14"
            class="shrink-0 text-[var(--app-text-muted)]"
          />
        </button>
      </div>

      <!-- 快捷标签 -->
      <div class="flex flex-wrap gap-2 mt-4">
        <button
          v-for="tag in QUICK_TAGS"
          :key="tag"
          type="button"
          class="ai-chip h-7 px-3 rounded-full text-12.5px cursor-pointer"
          :disabled="disabled || thinking"
          @click="ask(tag)"
        >
          {{ tag }}
        </button>
      </div>
    </div>

    <!-- 消息列表 -->
    <div v-else class="p-5 space-y-4">
      <div
        v-for="message in messages"
        :key="message.id"
        class="flex"
        :class="message.role === 'user' ? 'justify-end' : 'justify-start'"
      >
        <div class="max-w-[78%] min-w-0">
          <!-- 用户消息气泡：渐变底 + 大圆角 -->
          <div
            v-if="message.role === 'user'"
            class="ai-gradient px-4 py-2.5 rounded-2xl rounded-tr-md text-14px leading-relaxed whitespace-pre-wrap text-white shadow-[0_6px_16px_rgb(79_110_247_/_22%)]"
          >
            {{ message.content }}
          </div>

          <!-- assistant 消息 -->
          <template v-else-if="message.role === 'assistant'">
            <!-- 审批结果条：图标 + 状态标题（读持久化 toolResults 元数据，刷新后一致） -->
            <div
              v-if="approvalResultOf(message)"
              class="flex items-center gap-1.5 px-3.5 pt-2.5"
              :class="
                approvalResultOf(message)?.outcome === 'success'
                  ? 'text-green-600'
                  : approvalResultOf(message)?.outcome === 'cancelled'
                    ? 'text-[var(--app-text-muted)]'
                    : 'text-red-500'
              "
            >
              <CircleCheck
                v-if="approvalResultOf(message)?.outcome === 'success'"
                :size="18"
                class="shrink-0"
              />
              <CircleX
                v-else-if="approvalResultOf(message)?.outcome === 'cancelled'"
                :size="18"
                class="shrink-0"
              />
              <CircleAlert v-else :size="18" class="shrink-0" />
              <span class="text-14px font-600">
                {{
                  outcomeLabel(approvalResultOf(message)?.outcome ?? 'success')
                }}
              </span>
            </div>

            <!-- 生成中占位：tool 步骤可能先到、文本未到时显示光标 -->
            <div
              v-if="isFresh(message) && !message.content"
              class="flex items-center gap-1.5 text-13px text-[var(--app-text-muted)] px-1 py-0.5"
            >
              <span class="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
              <span v-if="hasWaitingApproval(message)"> 等待你的确认... </span>
              <span v-else-if="message.toolCalls?.length">正在处理...</span>
              <span v-else>AI 正在分析...</span>
            </div>

            <!-- 文本内容：真流式（后端增量推送）→ 实时渲染 Markdown -->
            <div
              v-if="shouldShowContent(message)"
              class="px-3.5 py-2.5 rounded-lg text-14px leading-relaxed"
            >
              <MarkdownContent :content="message.content ?? ''" />
            </div>

            <!-- 操作步骤（tool 调用）：折叠卡片，默认闭合 -->
            <div v-if="message.toolCalls?.length" class="mt-2 space-y-1.5">
              <ToolStepCard
                v-for="(call, index) in message.toolCalls"
                :key="`${message.id}-${index}`"
                :name="call.name"
                :args="call.arguments"
                :result="call.result"
                :status="toolStatus(call)"
              />
            </div>

            <!-- 待审批操作：内嵌确认条（替代弹窗/悬浮提示），置于消息底部 -->
            <ApprovalPanel
              v-if="pendingApproval && message.id === approvalMessageId"
              :approval="pendingApproval"
              :loading="approving"
              class="mt-2"
              @confirm="$emit('confirm')"
              @cancel="$emit('cancel')"
            />
          </template>
        </div>
      </div>

      <!-- 思考中（历史无消息且正在请求时的兜底提示） -->
      <div
        v-if="thinking && !messages.some(isFresh)"
        class="flex justify-start"
      >
        <div
          class="px-3.5 py-2.5 rounded-2xl bg-[var(--app-bg-hover)] text-13px text-[var(--app-text-muted)]"
        >
          <span class="inline-flex items-center gap-1.5">
            <span class="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
            AI 正在分析...
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
