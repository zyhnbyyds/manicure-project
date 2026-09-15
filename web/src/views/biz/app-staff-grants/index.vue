<script setup lang="ts">
import { h, ref } from 'vue';
import { Check, X } from 'lucide-vue-next';
import {
  LewButton,
  LewMessage,
  LewModal,
  LewPagination,
  LewSelect,
  LewTable,
  LewTextarea,
} from 'lew-ui';
import type { LewTableColumn } from 'lew-ui';
import {
  approveAppStaffGrant,
  rejectAppStaffGrant,
} from '~/api/biz/app-staff-grants';
import type { AppStaffGrant, GrantStatus } from '~/api/biz/app-staff-grants';
import { useTable } from '~/composables/useTable';
import { formatDateTime } from '~/composables/useFormat';
import { confirmDanger } from '~/utils/confirm';
import { trimCell } from '~/utils/table-text';
import IconButton from '~/components/IconButton.vue';

/**
 * 美甲师工作台开通确认（施工单 §12.5 S2）。
 *
 * 开通流程的另一端在小程序：顾客用手机号发起 → 这里确认。
 * 批准不等于永久有效——后台停用美甲师档案会立刻撤权（作用域每请求复查）。
 */

const statusText: Record<AppStaffGrant['staffStatus'], string> = {
  none: '未申请',
  pending: '待确认',
  active: '已开通',
  rejected: '已驳回',
};

const statusOptions = [
  { label: '待确认', value: 'pending' },
  { label: '已开通', value: 'active' },
  { label: '已驳回', value: 'rejected' },
];

// ---------- 列表 ----------
const query = ref<{ status?: GrantStatus }>({ status: 'pending' });

const {
  items,
  loading,
  currentPage,
  pageSize,
  total,
  search,
  refresh,
  handleChange,
} = useTable<AppStaffGrant>({
  url: '/biz/app-staff-grants',
  query: () => (query.value.status ? { status: query.value.status } : {}),
});

const columns: LewTableColumn[] = [
  { title: 'ID', field: 'id', width: 70 },
  {
    title: '微信身份',
    field: 'nickname',
    width: 160,
    customRender: ({ row }) => {
      const grant = row as unknown as AppStaffGrant;
      return grant.nickname || grant.openid;
    },
  },
  {
    title: '手机号',
    field: 'phone',
    width: 130,
    customRender: ({ row }) => (row as unknown as AppStaffGrant).phone ?? '-',
  },
  {
    title: '匹配档案',
    field: 'staffName',
    width: 140,
    customRender: ({ row }) => {
      const grant = row as unknown as AppStaffGrant;
      if (!grant.staffName) return '-';
      // 档案停用/已删除时标红：批准也会被后端拒绝，提前让店长看见
      const archived = grant.staffArchivedStatus === 'active';
      return h(
        'span',
        { class: archived ? undefined : 'text-[var(--lew-color-error)]' },
        archived ? grant.staffName : `${grant.staffName}（档案不可用）`,
      );
    },
  },
  {
    title: '申请时间',
    field: 'staffRequestedAt',
    width: 165,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as AppStaffGrant).staffRequestedAt),
  },
  {
    title: '状态',
    field: 'staffStatus',
    width: 100,
    customRender: ({ row }) => {
      const status = (row as unknown as AppStaffGrant).staffStatus;
      const color =
        status === 'active'
          ? 'text-[var(--lew-color-success)]'
          : status === 'rejected'
            ? 'text-[var(--lew-color-error)]'
            : 'text-[var(--lew-color-warning)]';
      return h('span', { class: color }, statusText[status] ?? status);
    },
  },
  {
    title: '处理时间',
    field: 'staffDecidedAt',
    width: 165,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as AppStaffGrant).staffDecidedAt),
  },
  {
    title: '驳回原因',
    field: 'staffRejectReason',
    customRender: ({ row }) => {
      const text = (row as unknown as AppStaffGrant).staffRejectReason;
      return trimCell(text);
    },
  },
  { title: '操作', field: 'operation', width: 110, fixed: 'right' },
];

void search();

// ---------- 通过 ----------
function handleApprove(row: AppStaffGrant) {
  confirmDanger({
    type: 'normal',
    confirmColor: 'primary',
    confirmText: '通过',
    title: '通过开通申请',
    content:
      `确定给「${row.nickname || row.openid}」开通美甲师工作台吗？` +
      '开通后 TA 可以在小程序看到自己的预约与业绩。',
    onConfirm: async () => {
      await approveAppStaffGrant(row.id);
      LewMessage.success('已开通');
      void refresh();
    },
  });
}

// ---------- 驳回 ----------
const rejectVisible = ref(false);
const rejecting = ref<AppStaffGrant | null>(null);
const rejectReason = ref('');
const rejectSubmitting = ref(false);

function openReject(row: AppStaffGrant) {
  rejecting.value = row;
  rejectReason.value = '';
  rejectVisible.value = true;
}

async function submitReject() {
  if (rejectSubmitting.value) return;
  const reason = rejectReason.value.trim();
  if (!reason) {
    LewMessage.warning('请填写驳回原因（申请人会看到）');
    return;
  }
  const target = rejecting.value;
  if (!target) return;
  rejectSubmitting.value = true;
  try {
    await rejectAppStaffGrant(target.id, reason);
    LewMessage.success('已驳回');
    rejectVisible.value = false;
    void refresh();
  } finally {
    rejectSubmitting.value = false;
  }
}
</script>

<template>
  <div class="page-container">
    <!-- 页头 -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="page-title m-0">工作台授权</h2>
        <p class="page-subtitle mt-1 mb-0">
          小程序端用手机号发起开通申请，店长在这里确认；停用美甲师档案会立即撤权
        </p>
      </div>
      <LewButton type="light" :loading="loading" @click="search()"
        >刷新</LewButton
      >
    </div>

    <!-- 搜索栏 -->
    <div class="app-card flex flex-wrap items-center gap-3 p-4">
      <LewSelect
        v-model="query.status"
        width="160px"
        :options="statusOptions"
        placeholder="申请状态"
        clearable
      />
      <LewButton type="light" :loading="loading" @click="search()"
        >查询</LewButton
      >
      <LewButton
        type="text"
        color="gray"
        @click="
          () => {
            query = {};
            search();
          }
        "
        >重置</LewButton
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
              v-if="(row as unknown as AppStaffGrant).staffStatus !== 'active'"
              permission="biz:staff:grant"
              title="通过"
              @click="handleApprove(row as unknown as AppStaffGrant)"
            >
              <Check :size="14" />
            </IconButton>
            <IconButton
              v-if="
                (row as unknown as AppStaffGrant).staffStatus !== 'rejected'
              "
              permission="biz:staff:grant"
              title="驳回"
              @click="openReject(row as unknown as AppStaffGrant)"
            >
              <X :size="14" />
            </IconButton>
          </div>
        </template>
      </LewTable>

      <div class="flex justify-end p-3">
        <LewPagination
          :model-value="currentPage"
          :total="total"
          :page-size="pageSize"
          @change="handleChange"
        />
      </div>
    </div>

    <!-- 驳回弹窗 -->
    <!--
      注意：lew-ui 的 LewModal **只有 `close` 事件**，既没有 `@ok` 也没有 `ok-button-props`。
      之前用 `@ok="submitReject"` 的结果是：点「确定」只会关掉弹窗，驳回请求根本没发出去。
      底部按钮必须用 `footer-buttons` 声明（`request` 负责真正提交）。
    -->
    <LewModal
      v-model:visible="rejectVisible"
      title="驳回开通申请"
      width="480px"
      :footer-buttons="[
        {
          props: {
            type: 'text',
            color: 'gray',
            size: 'small',
            text: '取消',
            request: () => {
              rejectVisible = false;
            },
          },
        },
        {
          props: {
            type: 'fill',
            color: 'error',
            size: 'small',
            text: '确定驳回',
            loading: rejectSubmitting,
            request: submitReject,
          },
        },
      ]"
    >
      <div class="flex flex-col gap-3">
        <p class="m-0 text-sm text-[var(--lew-text-color-6)]">
          驳回后对方可在小程序重新申请；原因会展示给申请人。
        </p>
        <LewTextarea
          v-model="rejectReason"
          placeholder="如：手机号与档案不符"
          :rows="3"
          :max-length="200"
        />
      </div>
    </LewModal>
  </div>
</template>
