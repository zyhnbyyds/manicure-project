<script setup lang="ts">
import { h, reactive, ref } from 'vue';
import { Eye, RotateCcw } from 'lucide-vue-next';
import {
  LewButton,
  LewDatePicker,
  LewInput,
  LewMessage,
  LewModal,
  LewPagination,
  LewSelect,
  LewTable,
} from 'lew-ui';
import type { LewTableColumn } from 'lew-ui';
import { getNoticeLog, resendNoticeLog } from '~/api/biz/notice-logs';
import type { NoticeLog, NoticeLogStatus } from '~/api/biz/notice-logs';
import { listNoticeTemplates } from '~/api/biz/notice-templates';
import { useTable } from '~/composables/useTable';
import { formatDateTime } from '~/composables/useFormat';
import { confirmDanger } from '~/utils/confirm';
import { trimCell } from '~/utils/table-text';
import IconButton from '~/components/IconButton.vue';

const CHANNEL_OPTIONS = [
  { label: '短信', value: 'sms' },
  { label: '站内', value: 'site' },
];
const STATUS_OPTIONS = [
  { label: '待发送', value: 'pending' },
  { label: '成功', value: 'success' },
  { label: '失败', value: 'failed' },
  { label: '已跳过（未配置）', value: 'skipped' },
];
const STATUS_LABELS: Record<NoticeLogStatus, string> = {
  pending: '待发送',
  success: '成功',
  failed: '失败',
  skipped: '已跳过',
};
const STATUS_CLASS: Record<NoticeLogStatus, string> = {
  pending: 'text-[var(--lew-color-warning)]',
  success: 'text-[var(--lew-color-success)]',
  failed: 'text-[var(--lew-color-error)] font-600',
  skipped: 'text-[var(--app-text-muted)]',
};

// ---------- 模板编码下拉（无模板权限时降级为手工输入） ----------
const templateOptions = reactive<{ label: string; value: string }[]>([]);
const templateSelectable = ref(true);
async function loadTemplateOptions() {
  try {
    // 200 条足够覆盖全部模板，且正好等于后端 MAX_PAGE_SIZE，不会被夹也不会 400
    const data = await listNoticeTemplates({ page: 1, pageSize: 200 });
    templateOptions.splice(
      0,
      templateOptions.length,
      ...data.items.map((template) => ({
        label: `${template.name}（${template.code}）`,
        value: template.code,
      })),
    );
  } catch (error) {
    // 只有「无权限」才是预期内的降级（走手输模板编码）；
    // 其它错误（网络抖动 / 500）绝不能伪装成"你没权限"，否则问题会被长期掩盖
    const status =
      (error as { response?: { status?: number } } | undefined)?.response
        ?.status ?? 0;
    if (status !== 403) {
      console.warn('[notice-logs] 通知模板下拉加载失败：', error);
    }
    templateSelectable.value = false;
  }
}
void loadTemplateOptions();

// ---------- 列表 ----------
const query = ref<{
  channel?: string;
  status?: string;
  templateCode?: string;
  dateFrom?: string;
  dateTo?: string;
}>({});
const {
  items,
  loading,
  currentPage,
  pageSize,
  total,
  search,
  refresh,
  handleChange,
} = useTable<NoticeLog>({
  url: '/biz/notice-logs',
  query: () => query.value,
});

const columns: LewTableColumn[] = [
  { title: 'ID', field: 'id', width: 70 },
  { title: '模板编码', field: 'templateCode', width: 160 },
  {
    title: '渠道',
    field: 'channel',
    width: 80,
    customRender: ({ row }) =>
      (row as unknown as NoticeLog).channel === 'sms' ? '短信' : '站内',
  },
  {
    title: '接收人',
    field: 'recipientId',
    width: 160,
    customRender: ({ row }) => {
      const log = row as unknown as NoticeLog;
      const type = log.recipientType === 'customer' ? '顾客' : '后台用户';
      return `${type} #${log.recipientId}${log.phone ? ` · ${log.phone}` : ''}`;
    },
  },
  {
    title: '标题',
    field: 'title',
    width: 150,
    customRender: ({ row }) => (row as unknown as NoticeLog).title ?? '-',
  },
  {
    title: '渲染后内容',
    field: 'content',
    customRender: ({ row }) => {
      const content = (row as unknown as NoticeLog).content;
      return trimCell(content);
    },
  },
  {
    title: '状态',
    field: 'status',
    width: 110,
    customRender: ({ row }) => {
      const status = (row as unknown as NoticeLog).status;
      return h('span', { class: STATUS_CLASS[status] }, STATUS_LABELS[status]);
    },
  },
  {
    title: '重试次数',
    field: 'retryCount',
    width: 90,
    customRender: ({ row }) => {
      const count = (row as unknown as NoticeLog).retryCount;
      return count >= 3
        ? h(
            'span',
            { class: 'text-[var(--lew-color-error)]' },
            `${count}（已达上限）`,
          )
        : String(count);
    },
  },
  {
    title: '发送时间',
    field: 'sentAt',
    width: 165,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as NoticeLog).sentAt),
  },
  {
    title: '创建时间',
    field: 'createdAt',
    width: 165,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as NoticeLog).createdAt),
  },
  { title: '操作', field: 'operation', width: 90, fixed: 'right' },
];

void search();

// ---------- 详情 ----------
const detailVisible = ref(false);
const detail = ref<NoticeLog | null>(null);
const detailLoading = ref(false);

async function openDetail(row: NoticeLog) {
  detail.value = row;
  detailVisible.value = true;
  detailLoading.value = true;
  try {
    detail.value = await getNoticeLog(row.id);
  } finally {
    detailLoading.value = false;
  }
}

// ---------- 单条重发 ----------
function handleResend(row: NoticeLog) {
  confirmDanger({
    type: 'normal',
    title: '重发确认',
    content: `确定重发该条通知吗？\n模板：${row.templateCode}\n接收人：#${row.recipientId}${row.phone ? `（${row.phone}）` : ''}\n渠道：${row.channel === 'sms' ? '短信' : '站内'}`,
    confirmText: '重发',
    confirmColor: 'primary',
    onConfirm: async () => {
      await resendNoticeLog(row.id);
      LewMessage.success('已重新发送');
      await refresh();
      if (detail.value?.id === row.id) await openDetail(row);
    },
  });
}

/** 详情行（键值表） */
function detailRows(log: NoticeLog) {
  return [
    { label: '模板编码', value: log.templateCode },
    {
      label: '渠道',
      value: log.channel === 'sms' ? '短信' : '站内',
    },
    {
      label: '接收人',
      value: `${log.recipientType === 'customer' ? '顾客' : '后台用户'} #${log.recipientId}`,
    },
    { label: '手机号', value: log.phone ?? '-' },
    { label: '标题', value: log.title ?? '-' },
    { label: '状态', value: STATUS_LABELS[log.status] },
    { label: '供应商', value: log.provider ?? '-' },
    { label: '供应商消息号', value: log.providerMsgId ?? '-' },
    { label: '重试次数', value: String(log.retryCount) },
    { label: '错误信息', value: log.error ?? '-' },
    { label: '发送时间', value: formatDateTime(log.sentAt) },
    { label: '阅读时间', value: formatDateTime(log.readAt) },
    { label: '关联预约', value: log.bookingId ? `#${log.bookingId}` : '-' },
    { label: '创建时间', value: formatDateTime(log.createdAt) },
  ];
}
</script>

<template>
  <div class="page-container">
    <!-- 页头 -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="page-title m-0">通知记录</h2>
        <p class="page-subtitle mt-1 mb-0">
          日志保存渲染后的最终内容，模板改版后仍可举证；失败可单条重发
        </p>
      </div>
    </div>

    <!-- 筛选 -->
    <div class="app-card flex flex-wrap items-center gap-3 p-4">
      <LewSelect
        v-model="query.channel"
        width="120px"
        :options="CHANNEL_OPTIONS"
        placeholder="全部渠道"
        clearable
      />
      <LewSelect
        v-model="query.status"
        width="170px"
        :options="STATUS_OPTIONS"
        placeholder="全部状态"
        clearable
      />
      <LewSelect
        v-if="templateSelectable"
        v-model="query.templateCode"
        width="230px"
        :options="templateOptions"
        placeholder="全部模板"
        clearable
      />
      <LewInput
        v-else
        v-model="query.templateCode"
        width="200px"
        placeholder="模板编码"
        clearable
        @enter="search()"
      />
      <LewDatePicker
        v-model="query.dateFrom"
        width="150px"
        value-format="YYYY-MM-DD"
        placeholder="发送日期从"
        clearable
      />
      <span class="text-[var(--app-text-muted)]">~</span>
      <LewDatePicker
        v-model="query.dateTo"
        width="150px"
        value-format="YYYY-MM-DD"
        placeholder="发送日期至"
        clearable
      />
      <LewButton type="light" :loading="loading" @click="search()"
        >查询</LewButton
      >
    </div>

    <!-- 表格 -->
    <div class="app-card overflow-hidden">
      <LewTable
        :columns="columns"
        :data-source="items"
        :loading="loading"
        :focusable="false"
        size="small"
      >
        <template #operation="{ row }">
          <div class="flex items-center gap-1">
            <IconButton
              title="详情"
              @click="openDetail(row as unknown as NoticeLog)"
            >
              <Eye :size="14" />
            </IconButton>
            <IconButton
              permission="biz:notice:send"
              color="error"
              title="重发"
              @click="handleResend(row as unknown as NoticeLog)"
            >
              <RotateCcw :size="14" />
            </IconButton>
          </div>
        </template>
      </LewTable>

      <div class="flex justify-end p-3">
        <LewPagination
          v-model:current-page="currentPage"
          v-model:page-size="pageSize"
          :total="total"
          @change="handleChange"
        />
      </div>
    </div>

    <!-- 详情弹窗 -->
    <LewModal
      v-model:visible="detailVisible"
      title="通知详情"
      width="680px"
      :hide-footer="true"
    >
      <div v-if="detail" class="flex flex-col gap-3 p-5">
        <table class="table-base">
          <tbody>
            <tr v-for="item in detailRows(detail)" :key="item.label">
              <td class="table-td w-140px text-[var(--app-text-muted)]">
                {{ item.label }}
              </td>
              <td class="table-td break-all">{{ item.value }}</td>
            </tr>
          </tbody>
        </table>

        <div>
          <div class="mb-1 text-13px font-600">渲染后内容</div>
          <div
            class="whitespace-pre-wrap rounded-8px bg-[var(--app-bg-hover)] p-3 text-13px"
          >
            {{ detail.content }}
          </div>
        </div>

        <div
          v-if="detail.error"
          class="rounded-8px border border-[var(--lew-color-error)] bg-[var(--lew-color-error-light)] p-2.5 text-12.5px text-[var(--lew-color-error)]"
        >
          <div class="font-600">
            错误信息（重试 {{ detail.retryCount }} 次）
          </div>
          <div class="break-all">{{ detail.error }}</div>
        </div>

        <div class="flex justify-end gap-2">
          <LewButton
            v-permission="'biz:notice:send'"
            type="light"
            @click="handleResend(detail)"
            >重发</LewButton
          >
          <LewButton type="fill" @click="detailVisible = false">关闭</LewButton>
        </div>
      </div>
      <div v-else class="table-empty p-5">
        {{ detailLoading ? '加载中…' : '暂无数据' }}
      </div>
    </LewModal>
  </div>
</template>
