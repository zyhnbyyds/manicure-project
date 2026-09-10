<script setup lang="ts">
import { h, nextTick, reactive, ref } from 'vue';
import { Eye, EyeOff, MessageSquare, Plus, Trash2 } from 'lucide-vue-next';
import {
  LewButton,
  LewDatePicker,
  LewForm,
  LewMessage,
  LewModal,
  LewPagination,
  LewSelect,
  LewTable,
  LewTextarea,
} from 'lew-ui';
import type { LewFormOption, LewTableColumn } from 'lew-ui';
import {
  createReview,
  deleteReview,
  listCompletedBookings,
  listStaffOptions,
  replyReview,
  updateReview,
} from '~/api/biz/reviews';
import type { Review } from '~/api/biz/reviews';
import { useTable } from '~/composables/useTable';
import { formatDateTime } from '~/composables/useFormat';
import { confirmDanger } from '~/utils/confirm';
import IconButton from '~/components/IconButton.vue';

const STATUS_OPTIONS = [
  { label: '已发布', value: 'published' },
  { label: '已隐藏', value: 'hidden' },
];
const SCORE_OPTIONS = [5, 4, 3, 2, 1].map((score) => ({
  label: `${score} 分`,
  value: String(score),
}));

/** 星级展示 */
function renderScore(score: number) {
  return h('span', { title: `${score} 分` }, [
    h(
      'span',
      { class: 'text-[var(--lew-color-warning)]' },
      '★'.repeat(Math.max(0, Math.min(5, score))),
    ),
    h(
      'span',
      { class: 'text-[var(--app-text-muted)]' },
      '★'.repeat(Math.max(0, 5 - score)),
    ),
  ]);
}

// ---------- 美甲师下拉 ----------
const staffOptions = reactive<{ label: string; value: string }[]>([]);
async function loadStaffs() {
  const data = await listStaffOptions();
  staffOptions.splice(
    0,
    staffOptions.length,
    ...data.items.map((staff) => ({
      label: staff.nickname,
      value: String(staff.id),
    })),
  );
}
void loadStaffs();

// ---------- 代录：已完成预约下拉 ----------
const bookingOptions = reactive<{ label: string; value: number }[]>([]);
async function loadBookings() {
  const data = await listCompletedBookings();
  bookingOptions.splice(
    0,
    bookingOptions.length,
    ...data.items.map((booking) => ({
      label: `${booking.bookingNo} · ${booking.customerName} · ${formatDateTime(booking.startAt, 'MM-DD HH:mm')}`,
      value: booking.id,
    })),
  );
}

// ---------- 列表 ----------
const query = ref<{
  staffId?: string;
  score?: string;
  status?: string;
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
} = useTable<Review>({ url: '/biz/reviews', query: () => query.value });

const columns: LewTableColumn[] = [
  { title: 'ID', field: 'id', width: 70 },
  {
    title: '预约单号',
    field: 'bookingNo',
    width: 155,
    customRender: ({ row }) => (row as unknown as Review).bookingNo ?? '-',
  },
  {
    title: '顾客',
    field: 'customerName',
    width: 110,
    customRender: ({ row }) => (row as unknown as Review).customerName ?? '-',
  },
  {
    title: '美甲师',
    field: 'staffName',
    width: 100,
    customRender: ({ row }) => (row as unknown as Review).staffName ?? '-',
  },
  {
    title: '评分',
    field: 'score',
    width: 110,
    customRender: ({ row }) => renderScore((row as unknown as Review).score),
  },
  {
    title: '评价内容',
    field: 'content',
    customRender: ({ row }) => {
      const content = (row as unknown as Review).content;
      if (!content) return '-';
      return h(
        'span',
        { class: 'block w-full truncate cursor-default', title: content },
        content,
      );
    },
  },
  {
    title: '公开',
    field: 'isPublic',
    width: 80,
    customRender: ({ row }) =>
      (row as unknown as Review).isPublic
        ? h('span', { class: 'text-[var(--lew-color-success)]' }, '公开')
        : h('span', { class: 'text-[var(--app-text-muted)]' }, '不公开'),
  },
  {
    title: '店家回复',
    field: 'reply',
    width: 160,
    customRender: ({ row }) => {
      const reply = (row as unknown as Review).reply;
      if (!reply)
        return h('span', { class: 'text-[var(--app-text-muted)]' }, '未回复');
      return h(
        'span',
        { class: 'block w-full truncate cursor-default', title: reply },
        reply,
      );
    },
  },
  {
    title: '状态',
    field: 'status',
    width: 85,
    customRender: ({ row }) =>
      (row as unknown as Review).status === 'published'
        ? h('span', { class: 'text-[var(--lew-color-success)]' }, '已发布')
        : h('span', { class: 'text-[var(--lew-color-error)]' }, '已隐藏'),
  },
  {
    title: '评价时间',
    field: 'createdAt',
    width: 165,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as Review).createdAt),
  },
  { title: '操作', field: 'operation', width: 120, fixed: 'right' },
];

void search();

// ---------- 回复 ----------
const replyVisible = ref(false);
const replyTarget = ref<Review | null>(null);
const replyText = ref('');

function openReply(row: Review) {
  replyTarget.value = row;
  replyText.value = row.reply ?? '';
  replyVisible.value = true;
}

async function handleReply() {
  const target = replyTarget.value;
  if (!target) return;
  if (!replyText.value.trim()) {
    LewMessage.error('请填写回复内容');
    return;
  }
  await replyReview(target.id, replyText.value.trim());
  LewMessage.success('回复成功');
  replyVisible.value = false;
  await refresh();
}

// ---------- 隐藏 / 公开 ----------
function handleToggleStatus(row: Review) {
  const next = row.status === 'published' ? 'hidden' : 'published';
  const label = next === 'hidden' ? '隐藏' : '公开';
  confirmDanger({
    type: 'normal',
    title: `${label}确认`,
    content:
      next === 'hidden'
        ? `确定隐藏该评价吗？隐藏后顾客侧不再展示。`
        : `确定公开该评价吗？公开后将展示给顾客。`,
    confirmText: label,
    confirmColor: 'primary',
    onConfirm: async () => {
      await updateReview(row.id, { status: next });
      LewMessage.success(`已${label}`);
      await refresh();
    },
  });
}

// ---------- 删除 ----------
function handleDelete(row: Review) {
  confirmDanger({
    title: '删除确认',
    content: '确定删除该评价吗？软删保留数据，列表不再展示。',
    onConfirm: async () => {
      await deleteReview(row.id);
      LewMessage.success('删除成功');
      await refresh();
    },
  });
}

// ---------- 后台代录 ----------
const createVisible = ref(false);
const formRef = ref();
const form = ref({
  bookingId: undefined as number | undefined,
  score: '5',
  content: '',
});
/** 表单 key：每次打开弹窗自增，强制重建 LewForm 以回填数据 */
const formKey = ref(0);

const formOptions: LewFormOption[] = [
  {
    field: 'bookingId',
    label: '已完成预约',
    as: 'select',
    rule: "Yup.number().required('不能为空').typeError('请选择预约')",
    tips: '一单一评，已被评价过的预约提交会被拒绝',
    props: { options: bookingOptions, placeholder: '请选择已完成预约' },
  },
  {
    field: 'score',
    label: '评分',
    as: 'select',
    rule: "Yup.string().required('不能为空')",
    props: { options: SCORE_OPTIONS },
  },
  {
    field: 'content',
    label: '评价内容',
    as: 'textarea',
    props: { placeholder: '顾客当面口述的内容', rows: 3 },
  },
];

async function openCreate() {
  await loadBookings();
  formKey.value += 1;
  createVisible.value = true;
  void nextTick(() => {
    formRef.value?.setForm?.({ bookingId: undefined, score: '5', content: '' });
  });
}

async function handleCreate() {
  const valid = await formRef.value?.validate();
  if (!valid) return;
  const values = (formRef.value?.getForm?.() ??
    form.value) as typeof form.value;
  if (!values.bookingId) {
    LewMessage.error('请选择已完成预约');
    return;
  }
  await createReview({
    bookingId: values.bookingId,
    score: Number(values.score),
    content: values.content || undefined,
  });
  LewMessage.success('代录成功');
  createVisible.value = false;
  await refresh();
}
</script>

<template>
  <div class="page-container">
    <!-- 页头 -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="page-title m-0">评价管理</h2>
        <p class="page-subtitle mt-1 mb-0">
          一单一评；可回复、可隐藏（处理恶意评价）、可代录
        </p>
      </div>
      <LewButton
        v-permission="'biz:review:create'"
        type="fill"
        @click="openCreate"
      >
        <Plus :size="15" style="margin-right: 4px" /> 代录评价
      </LewButton>
    </div>

    <!-- 筛选 -->
    <div class="app-card flex flex-wrap items-center gap-3 p-4">
      <LewSelect
        v-model="query.staffId"
        width="160px"
        :options="staffOptions"
        placeholder="全部美甲师"
        clearable
      />
      <LewSelect
        v-model="query.score"
        width="120px"
        :options="SCORE_OPTIONS"
        placeholder="全部评分"
        clearable
      />
      <LewSelect
        v-model="query.status"
        width="130px"
        :options="STATUS_OPTIONS"
        placeholder="全部状态"
        clearable
      />
      <LewDatePicker
        v-model="query.dateFrom"
        width="150px"
        value-format="YYYY-MM-DD"
        placeholder="评价日期从"
        clearable
      />
      <span class="text-[var(--app-text-muted)]">~</span>
      <LewDatePicker
        v-model="query.dateTo"
        width="150px"
        value-format="YYYY-MM-DD"
        placeholder="评价日期至"
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
              permission="biz:review:reply"
              title="回复"
              @click="openReply(row as unknown as Review)"
            >
              <MessageSquare :size="14" />
            </IconButton>
            <IconButton
              permission="biz:review:hide"
              :title="
                (row as unknown as Review).status === 'published'
                  ? '隐藏'
                  : '公开'
              "
              @click="handleToggleStatus(row as unknown as Review)"
            >
              <EyeOff
                v-if="(row as unknown as Review).status === 'published'"
                :size="14"
              />
              <Eye v-else :size="14" />
            </IconButton>
            <IconButton
              permission="biz:review:delete"
              color="error"
              title="删除"
              @click="handleDelete(row as unknown as Review)"
            >
              <Trash2 :size="14" />
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

    <!-- 回复弹窗 -->
    <LewModal v-model:visible="replyVisible" title="回复评价" width="520px">
      <div class="flex flex-col gap-3 p-5">
        <div class="rounded-8px bg-[var(--app-bg-hover)] p-3 text-13px">
          <div class="mb-1">
            <span class="text-[var(--app-text-muted)]">顾客评价：</span>
            <span>{{ replyTarget?.content || '（未填写内容）' }}</span>
          </div>
          <div>
            <span class="text-[var(--app-text-muted)]">评分：</span>
            <span
              v-for="index in 5"
              :key="index"
              :class="
                index <= (replyTarget?.score ?? 0)
                  ? 'text-[var(--lew-color-warning)]'
                  : 'text-[var(--app-text-muted)]'
              "
              >★</span
            >
          </div>
        </div>
        <LewTextarea
          v-model="replyText"
          min-height="100px"
          placeholder="请输入店家回复（公开可见）"
        />
        <div class="flex justify-end gap-2">
          <LewButton type="text" color="gray" @click="replyVisible = false"
            >取消</LewButton
          >
          <LewButton
            v-permission="'biz:review:reply'"
            type="fill"
            @click="handleReply"
            >提交回复</LewButton
          >
        </div>
      </div>
    </LewModal>

    <!-- 代录弹窗 -->
    <LewModal
      v-model:visible="createVisible"
      title="代录评价"
      width="520px"
      :footer-buttons="[
        {
          props: {
            type: 'text',
            color: 'gray',
            size: 'small',
            text: '取消',
            request: () => {
              createVisible = false;
            },
          },
        },
        {
          props: {
            type: 'fill',
            color: 'primary',
            size: 'small',
            text: '保存',
            request: handleCreate,
          },
        },
      ]"
    >
      <div class="p-5">
        <LewForm
          :key="formKey"
          ref="formRef"
          v-model="form"
          :options="formOptions"
          label-width="96px"
        />
      </div>
    </LewModal>
  </div>
</template>
