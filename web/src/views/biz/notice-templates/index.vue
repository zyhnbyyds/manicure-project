<script setup lang="ts">
import { computed, h, nextTick, ref } from 'vue';
import { Pencil, Plus, Trash2 } from 'lucide-vue-next';
import {
  LewButton,
  LewForm,
  LewMessage,
  LewModal,
  LewPagination,
  LewTable,
} from 'lew-ui';
import type { LewFormOption, LewTableColumn } from 'lew-ui';
import { withPassThroughRule } from '~/utils/form';
import {
  NOTICE_VARIABLE_PRESETS,
  createNoticeTemplate,
  deleteNoticeTemplate,
  findUndeclaredVariables,
  renderTemplatePreview,
  updateNoticeTemplate,
} from '~/api/biz/notice-templates';
import type {
  NoticeChannel,
  NoticeTemplate,
  NoticeTemplateBody,
} from '~/api/biz/notice-templates';
import { useTable } from '~/composables/useTable';
import { formatDateTime } from '~/composables/useFormat';
import { confirmDanger } from '~/utils/confirm';
import { trimCell } from '~/utils/table-text';
import IconButton from '~/components/IconButton.vue';

const CHANNEL_OPTIONS = [
  { label: '短信', value: 'sms' },
  { label: '站内', value: 'site' },
  { label: '短信 + 站内', value: 'both' },
];
const CHANNEL_LABELS: Record<NoticeChannel, string> = {
  sms: '短信',
  site: '站内',
  both: '短信 + 站内',
};
const STATUS_OPTIONS = [
  { label: '启用', value: 'active' },
  { label: '禁用', value: 'disabled' },
];

// ---------- 列表 ----------
const query = ref<{ keyword?: string; channel?: string; status?: string }>({});
const {
  items,
  loading,
  currentPage,
  pageSize,
  total,
  search,
  refresh,
  handleChange,
} = useTable<NoticeTemplate>({
  url: '/biz/notice-templates',
  query: () => query.value,
});

const columns: LewTableColumn[] = [
  { title: 'ID', field: 'id', width: 70 },
  { title: '模板编码', field: 'code', width: 160 },
  { title: '模板名称', field: 'name', width: 150 },
  {
    title: '渠道',
    field: 'channel',
    width: 110,
    customRender: ({ row }) =>
      CHANNEL_LABELS[(row as unknown as NoticeTemplate).channel] ?? '-',
  },
  {
    title: '标题',
    field: 'title',
    width: 160,
    customRender: ({ row }) => (row as unknown as NoticeTemplate).title ?? '-',
  },
  {
    title: '内容',
    field: 'content',
    customRender: ({ row }) => {
      const content = (row as unknown as NoticeTemplate).content;
      return trimCell(content);
    },
  },
  {
    title: '已声明变量',
    field: 'variables',
    width: 210,
    customRender: ({ row }) => {
      const variables = (row as unknown as NoticeTemplate).variables ?? [];
      if (!variables.length) {
        return h('span', { class: 'text-[var(--app-text-muted)]' }, '无');
      }
      return h(
        'span',
        { class: 'flex flex-wrap gap-1' },
        variables.map((name) =>
          h(
            'span',
            {
              class:
                'rounded-4px bg-[var(--app-bg-hover)] px-1.5 py-0.5 text-11.5px',
            },
            `{${name}}`,
          ),
        ),
      );
    },
  },
  {
    title: '状态',
    field: 'status',
    width: 80,
    customRender: ({ row }) =>
      (row as unknown as NoticeTemplate).status === 'active'
        ? h('span', { class: 'text-[var(--lew-color-success)]' }, '启用')
        : h('span', { class: 'text-[var(--lew-color-error)]' }, '禁用'),
  },
  {
    title: '创建时间',
    field: 'createdAt',
    width: 165,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as NoticeTemplate).createdAt),
  },
  { title: '操作', field: 'operation', width: 100, fixed: 'right' },
];

void search();

// ---------- 新增 / 编辑 ----------
const modalVisible = ref(false);
const editingId = ref<number | null>(null);
const formRef = ref();
const form = ref({
  code: '',
  name: '',
  channel: 'both' as NoticeChannel,
  title: '',
  content: '',
  variables: [] as string[],
  status: true,
  remark: '',
});
/** 表单 key：每次打开弹窗自增，强制重建 LewForm 以回填数据 */
const formKey = ref(0);

/** LewForm `@change` 回吐的实时值，用于变量实时校验与内容预览 */
const live = ref<Record<string, unknown>>({});
function onFormChange(value: unknown) {
  if (value && typeof value === 'object') {
    live.value = { ...(value as Record<string, unknown>) };
  }
}

const declaredVariables = computed<string[]>(() =>
  Array.isArray(live.value.variables) ? (live.value.variables as string[]) : [],
);
/** 内容 / 标题里用到但未声明的变量（非空即阻止提交） */
const undeclaredVariables = computed(() =>
  findUndeclaredVariables(
    declaredVariables.value,
    String(live.value.title ?? ''),
    String(live.value.content ?? ''),
  ),
);
const contentPreview = computed(() =>
  renderTemplatePreview(
    String(live.value.content ?? ''),
    declaredVariables.value,
  ),
);

const formOptions: LewFormOption[] = withPassThroughRule([
  {
    field: 'code',
    label: '模板编码',
    as: 'input',
    rule: "Yup.string().required('不能为空')",
    tips: '唯一，如 booking_created',
    props: { placeholder: '小写字母/数字/下划线', clearable: true },
  },
  {
    field: 'name',
    label: '模板名称',
    as: 'input',
    rule: "Yup.string().required('不能为空')",
    props: { placeholder: '如 预约创建通知', clearable: true },
  },
  {
    field: 'channel',
    label: '渠道',
    as: 'select',
    rule: "Yup.string().required('不能为空')",
    props: { options: CHANNEL_OPTIONS },
  },
  {
    field: 'title',
    label: '标题',
    as: 'input',
    tips: '站内消息标题；短信可留空',
    props: { placeholder: '选填', clearable: true },
  },
  {
    field: 'content',
    label: '内容',
    as: 'textarea',
    rule: "Yup.string().required('不能为空')",
    tips: '用 {变量} 占位，变量必须已在「变量清单」中声明',
    props: {
      placeholder: '如 {customerName} 您好，您的预约时间为 {bookingTime}',
      rows: 4,
    },
  },
  {
    field: 'variables',
    label: '变量清单',
    as: 'input-tag',
    tips: '回车添加自定义变量（不含花括号）；用「插入变量」会自动声明',
    props: { placeholder: '如 customerName' },
  },
  { field: 'status', label: '状态', as: 'switch' },
  {
    field: 'remark',
    label: '备注',
    as: 'textarea',
    props: { placeholder: '选填', rows: 2 },
  },
]);

function currentValues() {
  return (formRef.value?.getForm?.() ?? form.value) as typeof form.value;
}

function openCreate() {
  editingId.value = null;
  formKey.value += 1;
  modalVisible.value = true;
  const payload = {
    code: '',
    name: '',
    channel: 'both' as NoticeChannel,
    title: '',
    content: '',
    variables: [] as string[],
    status: true,
    remark: '',
  };
  live.value = { ...payload };
  void nextTick(() => {
    formRef.value?.setForm?.(payload);
  });
}

function openEdit(row: NoticeTemplate) {
  editingId.value = row.id;
  formKey.value += 1;
  modalVisible.value = true;
  const payload = {
    code: row.code,
    name: row.name,
    channel: row.channel,
    title: row.title ?? '',
    content: row.content,
    variables: row.variables ?? [],
    status: row.status === 'active',
    remark: row.remark ?? '',
  };
  live.value = { ...payload };
  void nextTick(() => {
    formRef.value?.setForm?.(payload);
  });
}

/** 插入变量：追加到内容末尾，并自动写入变量清单 */
function insertVariable(name: string) {
  const values = currentValues();
  const content = `${values.content ?? ''}{${name}}`;
  const variables = [...new Set([...(values.variables ?? []), name])];
  formRef.value?.setForm?.({ ...values, content, variables });
  live.value = { ...values, content, variables };
}

async function handleSubmit() {
  const valid = await formRef.value?.validate();
  if (!valid) return;
  const values = currentValues();
  const variables = values.variables ?? [];
  const missing = findUndeclaredVariables(
    variables,
    values.title ?? '',
    values.content ?? '',
  );
  if (missing.length) {
    LewMessage.error(
      `以下变量未在变量清单中声明：${missing.map((name) => `{${name}}`).join('、')}`,
    );
    return;
  }
  const body: NoticeTemplateBody = {
    code: values.code,
    name: values.name,
    channel: values.channel,
    title: values.title || null,
    content: values.content,
    variables,
    status: values.status ? 'active' : 'disabled',
    remark: values.remark || null,
  };
  if (editingId.value === null) {
    await createNoticeTemplate(body);
    LewMessage.success('创建成功');
  } else {
    await updateNoticeTemplate(editingId.value, body);
    LewMessage.success('更新成功');
  }
  modalVisible.value = false;
  await refresh();
}

function handleDelete(row: NoticeTemplate) {
  confirmDanger({
    title: '删除确认',
    content: `确定删除模板「${row.name}」吗？历史发送日志会保留。`,
    onConfirm: async () => {
      await deleteNoticeTemplate(row.id);
      LewMessage.success('删除成功');
      await refresh();
    },
  });
}
</script>

<template>
  <div class="page-container">
    <!-- 页头 -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="page-title m-0">通知模板</h2>
        <p class="page-subtitle mt-1 mb-0">
          内容里的 {变量} 必须先在变量清单中声明；未声明会阻止保存
        </p>
      </div>
      <LewButton
        v-permission="'biz:notice:template'"
        type="fill"
        @click="openCreate"
      >
        <Plus :size="15" style="margin-right: 4px" /> 新增模板
      </LewButton>
    </div>

    <!-- 筛选 -->
    <div class="app-card flex flex-wrap items-center gap-3 p-4">
      <LewInput
        v-model="query.keyword"
        width="200px"
        placeholder="编码 / 名称"
        clearable
        @enter="search()"
      />
      <LewSelect
        v-model="query.channel"
        width="150px"
        :options="CHANNEL_OPTIONS"
        placeholder="全部渠道"
        clearable
      />
      <LewSelect
        v-model="query.status"
        width="130px"
        :options="STATUS_OPTIONS"
        placeholder="全部状态"
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
              permission="biz:notice:template"
              title="编辑"
              @click="openEdit(row as unknown as NoticeTemplate)"
            >
              <Pencil :size="14" />
            </IconButton>
            <IconButton
              permission="biz:notice:template"
              color="error"
              title="删除"
              @click="handleDelete(row as unknown as NoticeTemplate)"
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

    <!-- 新增 / 编辑弹窗 -->
    <LewModal
      v-model:visible="modalVisible"
      :title="editingId === null ? '新增通知模板' : '编辑通知模板'"
      width="680px"
      :footer-buttons="[
        {
          props: {
            type: 'text',
            color: 'gray',
            size: 'small',
            text: '取消',
            request: () => {
              modalVisible = false;
            },
          },
        },
        {
          props: {
            type: 'fill',
            color: 'primary',
            size: 'small',
            text: '保存',
            request: handleSubmit,
          },
        },
      ]"
    >
      <div class="flex flex-col gap-3 p-5">
        <!-- 插入变量 -->
        <div
          class="flex flex-wrap items-center gap-1.5 rounded-8px bg-[var(--app-bg-hover)] p-2.5"
        >
          <span class="text-12.5px text-[var(--app-text-secondary)]"
            >插入变量：</span
          >
          <button
            v-for="preset in NOTICE_VARIABLE_PRESETS"
            :key="preset.value"
            type="button"
            class="cursor-pointer rounded-6px border border-[var(--app-border)] bg-[var(--app-bg-card)] px-2 py-0.5 text-11.5px hover:border-[var(--lew-color-primary)] hover:text-[var(--lew-color-primary)]"
            :title="preset.label"
            @click="insertVariable(preset.value)"
          >
            {{ '{' + preset.value + '}' }}
          </button>
        </div>

        <LewForm
          :key="formKey"
          ref="formRef"
          v-model="form"
          :options="formOptions"
          label-width="92px"
          @change="onFormChange"
        />

        <!-- 实时变量校验 -->
        <div
          v-if="undeclaredVariables.length"
          class="rounded-8px border border-[var(--lew-color-error)] bg-[var(--lew-color-error-light)] p-2.5 text-12.5px text-[var(--lew-color-error)]"
        >
          以下变量未在变量清单中声明，无法保存：
          {{ undeclaredVariables.map((name) => '{' + name + '}').join('、') }}
          <button
            v-for="name in undeclaredVariables"
            :key="name"
            type="button"
            class="ml-1 cursor-pointer rounded-4px border border-current px-1.5 text-11.5px"
            @click="insertVariable(name)"
          >
            声明 {{ '{' + name + '}' }}
          </button>
        </div>
        <div
          v-else-if="declaredVariables.length"
          class="rounded-8px border border-[var(--app-border)] p-2.5 text-12.5px"
        >
          <div class="mb-1 text-[var(--app-text-muted)]">
            内容预览（变量以【】标出）
          </div>
          <div>{{ contentPreview || '（内容为空）' }}</div>
        </div>
      </div>
    </LewModal>
  </div>
</template>
