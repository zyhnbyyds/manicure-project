<script setup lang="ts">
import { nextTick, ref } from 'vue';
import { Loader2, Paperclip, Send } from 'lucide-vue-next';
import { LewMessage, LewTextarea } from 'lew-ui';
import { uploadFile } from '~/api/files';
import { MAX_UPLOAD_FILE_SIZE } from '~/utils/upload-limits';

/**
 * 底部输入区（composer）。
 *
 * 视觉：大圆角容器 + 聚焦光圈 + 渐变发送按钮 + 明确的快捷键提示。
 *
 * 「附件」的真实能力边界要说清楚：后端 `sendMessageSchema` 只收文本，
 * AI **读不了图**，所以附件走既有文件接口上传后，把文件名追加进提问文本
 * （AI 与人都能在对话记录里看到引用了哪张图）。不做假的图片理解。
 */
const props = defineProps<{
  modelValue: string;
  sending: boolean;
  disabled: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'send'): void;
}>();

const textareaRef = ref<InstanceType<typeof LewTextarea> | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const uploading = ref(false);

/** 已引用的附件数（仅用于提示条，不随输入清空而回退） */
const attachedCount = ref(0);

async function onKeydown(event: KeyboardEvent) {
  // Enter 发送，Shift+Enter 换行
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    emit('send');
  }
}

function pickFile() {
  fileInputRef.value?.click();
}

/** 上传附件：成功后把「文件名 + 下载地址」追加到提问文本 */
async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  // 同一个文件连选两次也要能触发 change
  input.value = '';
  if (!file) return;

  if (file.size > MAX_UPLOAD_FILE_SIZE) {
    LewMessage.warning('附件不能超过 10MB');
    return;
  }
  uploading.value = true;
  try {
    const uploaded = await uploadFile(file);
    const url = `${import.meta.env.VITE_API_BASE_URL}/files/${uploaded.id}/download`;
    const reference = `[附件：${file.name}](${url})`;
    const current = props.modelValue.trim();
    emit('update:modelValue', current ? `${current}\n${reference}` : reference);
    attachedCount.value += 1;
    LewMessage.success(`已引用附件「${file.name}」`);
    await nextTick();
    textareaRef.value?.focus?.();
  } catch {
    // 失败提示已由请求拦截器统一弹出（含超限 / 类型不在白名单）
  } finally {
    uploading.value = false;
  }
}
</script>

<template>
  <div class="shrink-0 px-5 pb-4 pt-1">
    <div
      class="ai-composer rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg-hover)] px-3 pt-2.5 pb-2 transition-[border-color,box-shadow]"
    >
      <div class="flex items-end gap-2">
        <!--
          输入框必须**套一层 flex-1 的 div**：lew-ui 的 `.lew-textarea-view` 把
          `width/min-width` 写成**内联样式**（`width:100%; min-width:100%`），
          CSS 覆盖不了内联（`:deep()` + `!important` 也不该用在这种地方），
          直接当 flex item 会独占整行、把发送按钮挤出圆角容器。
          套一层之后 100% 只相对这层算，`flex-1 min-w-0` 保证能收缩。
        -->
        <div class="flex-1 min-w-0">
          <LewTextarea
            ref="textareaRef"
            :model-value="modelValue"
            :rows="2"
            :max-length="2000"
            placeholder="输入你的指令，例如：查询本周未收款的订单"
            class="w-full ai-composer-input"
            @update:model-value="emit('update:modelValue', $event)"
            @keydown="onKeydown"
          />
        </div>

        <!-- 发送：渐变按钮 -->
        <button
          type="button"
          class="ai-btn-gradient flex items-center justify-center w-10 h-10 shrink-0 rounded-xl text-white border-none cursor-pointer mb-0.5"
          :disabled="disabled || sending || !modelValue.trim()"
          :title="sending ? '正在发送...' : '发送（Enter）'"
          aria-label="发送"
          @click="emit('send')"
        >
          <Loader2 v-if="sending" :size="17" class="animate-spin" />
          <Send v-else :size="17" />
        </button>
      </div>

      <!-- 工具行：附件 / 已引用数量 -->
      <div class="flex items-center gap-1 mt-1">
        <button
          type="button"
          class="flex items-center justify-center w-7 h-7 rounded-lg border-none bg-transparent cursor-pointer text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-bg-card)] hover:text-[var(--app-text-primary)]"
          :disabled="disabled || uploading"
          title="引用附件（图片 / 文档，AI 读不了图，仅作引用）"
          aria-label="引用附件"
          @click="pickFile"
        >
          <Loader2 v-if="uploading" :size="15" class="animate-spin" />
          <Paperclip v-else :size="15" />
        </button>
        <span
          v-if="attachedCount"
          class="text-11px text-[var(--app-text-muted)]"
        >
          已引用 {{ attachedCount }} 个附件
        </span>

        <span class="ml-auto text-11px text-[var(--app-text-muted)]">
          Enter 发送 · Shift+Enter 换行
        </span>
      </div>
    </div>

    <input
      ref="fileInputRef"
      type="file"
      class="hidden"
      accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
      @change="onFileChange"
    />
  </div>
</template>

<style scoped>
/* 输入区去掉 lew-ui 自带边框/底色，交给外层 composer 表达聚焦态 */
.ai-composer-input :deep(.lew-textarea-view),
.ai-composer-input :deep(.lew-textarea-view:hover),
.ai-composer-input :deep(.lew-textarea-view:focus-within) {
  border: none;
  background: transparent;
  box-shadow: none;
}

.ai-composer-input :deep(.lew-textarea) {
  padding: 0;
  font-size: 13.5px;
}

/* 拖拽改变尺寸的小三角与外层圆角冲突，隐藏掉（composer 高度由 rows 决定） */
.ai-composer-input :deep(.lew-textarea-resize-handle) {
  display: none;
}
</style>
