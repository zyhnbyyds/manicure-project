<script setup lang="ts">
import { h, nextTick, ref } from 'vue';
import { Pencil, Plus, Trash2 } from 'lucide-vue-next';
import {
  LewButton,
  LewForm,
  LewInput,
  LewMessage,
  LewModal,
  LewPagination,
  LewSelect,
  LewTable,
} from 'lew-ui';
import type {
  LewFormOption,
  LewTableColumn,
  LewUploadFileItem,
} from 'lew-ui';
import {
  createServiceItem,
  deleteServiceItem,
  updateServiceItem,
} from '~/api/biz/service-items';
import { filePreviewUrl, uploadFile } from '~/api/files';
import type {
  CreateServiceItemBody,
  ServiceItem,
} from '~/api/biz/service-items';
import { useTable } from '~/composables/useTable';
import { formatDateTime } from '~/composables/useFormat';
import type { EntityStatus } from '~/types/api';
import { renderStatus } from '~/utils/render';
import { withPassThroughRule } from '~/utils/form';
import { confirmDanger } from '~/utils/confirm';
import IconButton from '~/components/IconButton.vue';

/** 金额口径：接口是「分」，展示 / 表单是「元」（保留两位） */
function centsToYuan(cents: number | null | undefined): number {
  return Number(((cents ?? 0) / 100).toFixed(2));
}

function yuanToCents(yuan: number | null | undefined): number {
  return Math.round((yuan ?? 0) * 100);
}

function renderMoney(cents: number | null | undefined) {
  return h(
    'span',
    { class: 'tabular-nums' },
    `¥ ${((cents ?? 0) / 100).toFixed(2)}`,
  );
}

// ---------- 图集上传 ----------
/** 图集张数上限：与后端 zod 的 `.max(9)`、`normalizeImages` 的截断保持一致 */
const MAX_IMAGES = 9;
/** 单张图片大小上限：与后端 `MAX_FILE_SIZE` 对齐 */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/**
 * 表单里存的是上传组件的 `LewUploadFileItem[]`，接口收发的是 url 数组，
 * 这两个函数负责两侧互转；**不要**把 `LewUploadFileItem` 透传给接口。
 */
function toUploadItems(urls: string[] | null | undefined): LewUploadFileItem[] {
  return (urls ?? []).map((url, index) => ({
    key: `saved-${index}-${url}`,
    name: `图片 ${index + 1}`,
    url,
    status: 'complete' as const,
    percent: 100,
  }));
}

/** 只取上传成功的那些：`pending` / `fail` / `wrong_*` 不该进库 */
function toImageUrls(items: LewUploadFileItem[] | null | undefined): string[] {
  return (items ?? [])
    .filter((item) => item.status === 'complete' || item.status === 'success')
    .map((item) => item.url)
    .filter((url): url is string => Boolean(url));
}

/** 交给 LewUpload 的上传实现：走统一文件接口，成功后回填可直接预览的地址 */
async function uploadImage(params: {
  fileItem: LewUploadFileItem;
  setFileItem: (patch: Partial<LewUploadFileItem>) => void;
}) {
  const { fileItem, setFileItem } = params;
  const file = fileItem.file;
  if (!file) return;
  try {
    const uploaded = await uploadFile(file);
    setFileItem({
      key: fileItem.key,
      status: 'complete',
      percent: 100,
      url: filePreviewUrl(uploaded.id),
    });
  } catch {
    // 失败原因（类型 / 体积 / 网络）已由 request 拦截器统一提示，这里只标记状态
    setFileItem({ key: fileItem.key, status: 'fail', percent: 0 });
  }
}

// ---------- 列表 ----------
const statusOptions = [
  { label: '启用', value: 'active' },
  { label: '停用', value: 'disabled' },
];

const query = ref<{ keyword?: string; status?: EntityStatus }>({});

const {
  items,
  loading,
  currentPage,
  pageSize,
  total,
  search,
  refresh,
  handleChange,
} = useTable<ServiceItem>({
  url: '/biz/service-items',
  query: () => query.value,
});

const columns: LewTableColumn[] = [
  { title: 'ID', field: 'id', width: 70 },
  { title: '项目名称', field: 'name', width: 160 },
  {
    title: '分类',
    field: 'category',
    width: 100,
    customRender: ({ row }) => (row as unknown as ServiceItem).category ?? '-',
  },
  {
    title: '时长(分钟)',
    field: 'durationMinutes',
    width: 100,
    customRender: ({ row }) =>
      (row as unknown as ServiceItem).durationMinutes ?? '-',
  },
  {
    title: '缓冲(分钟)',
    field: 'bufferMinutes',
    width: 100,
    customRender: ({ row }) =>
      (row as unknown as ServiceItem).bufferMinutes ?? 0,
  },
  {
    title: '价格',
    field: 'price',
    width: 110,
    customRender: ({ row }) =>
      renderMoney((row as unknown as ServiceItem).price),
  },
  {
    title: '图片',
    field: 'images',
    width: 96,
    customRender: ({ row }) => {
      const urls = (row as unknown as ServiceItem).images ?? [];
      const cover = urls[0];
      if (!cover)
        return h('span', { class: 'text-[var(--app-text-muted)]' }, '-');
      // 新窗口打开即预览（下载地址带 inline=1，不会触发下载）
      return h(
        'a',
        {
          href: cover,
          target: '_blank',
          rel: 'noopener noreferrer',
          class: 'inline-flex items-center gap-1',
          title: '点击预览',
        },
        [
          h('img', {
            src: cover,
            alt: '封面',
            class: 'w-32px h-32px rounded object-cover border border-[var(--app-border)]',
          }),
          urls.length > 1
            ? h(
                'span',
                { class: 'text-[var(--app-text-muted)] text-xs' },
                `+${urls.length - 1}`,
              )
            : null,
        ],
      );
    },
  },
  {
    title: '说明',
    field: 'description',
    customRender: ({ row }) => {
      const text = (row as unknown as ServiceItem).description;
      if (!text) return '-';
      return h(
        'span',
        { class: 'block w-full truncate align-middle', title: text },
        text,
      );
    },
  },
  { title: '排序', field: 'sort', width: 70 },
  {
    title: '状态',
    field: 'status',
    width: 80,
    customRender: ({ row }) => renderStatus((row as { status: string }).status),
  },
  {
    title: '创建时间',
    field: 'createdAt',
    width: 160,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as ServiceItem).createdAt),
  },
  { title: '操作', field: 'operation', width: 100, fixed: 'right' },
];

void search();

// ---------- 新增 / 编辑 ----------
type FormValues = {
  name: string;
  category: string;
  durationMinutes: number;
  bufferMinutes: number;
  /** 表单是「元」，提交前转「分」 */
  priceYuan: number;
  description: string;
  /** 上传组件的内部形态；提交时经 `toImageUrls` 转成 url 数组 */
  images: LewUploadFileItem[];
  status: boolean;
  sort: number;
  remark: string;
};

const modalVisible = ref(false);
const editingId = ref<number | null>(null);
const formRef = ref();
const form = ref<FormValues>(emptyForm());
/** 表单 key：每次打开弹窗自增，强制重建 LewForm 以回填数据 */
const formKey = ref(0);

function emptyForm(): FormValues {
  return {
    name: '',
    category: '',
    durationMinutes: 60,
    bufferMinutes: 0,
    priceYuan: 0,
    description: '',
    images: [],
    status: true,
    sort: 0,
    remark: '',
  };
}

const formOptions: LewFormOption[] = withPassThroughRule([
  {
    field: 'name',
    label: '项目名称',
    as: 'input',
    rule: "Yup.string().required('不能为空')",
    props: { placeholder: '如 基础美甲', clearable: true },
  },
  {
    field: 'category',
    label: '分类',
    as: 'input',
    props: { placeholder: '选填，如 基础 / 进阶', clearable: true },
  },
  {
    field: 'durationMinutes',
    label: '时长',
    as: 'input-number',
    rule: "Yup.number().typeError('请输入数字').required('不能为空').min(1, '至少 1 分钟')",
    tips: '分钟；参与可约时段计算',
    props: { min: 1, max: 1440, step: 15 },
  },
  {
    field: 'bufferMinutes',
    label: '缓冲',
    as: 'input-number',
    tips: '分钟；与下一单之间的最小间隔',
    props: { min: 0, max: 240, step: 5 },
  },
  {
    field: 'priceYuan',
    label: '价格',
    as: 'input-number',
    rule: "Yup.number().typeError('请输入数字').min(0, '不能为负')",
    tips: '单位：元（提交时自动换算为分）',
    props: { min: 0, step: 1, align: 'left' },
  },
  {
    field: 'images',
    label: '图片',
    as: 'upload',
    tips: '第一张作为封面',
    props: {
      multiple: true,
      limit: MAX_IMAGES,
      accept: 'image/*',
      viewMode: 'card',
      maxFileSize: MAX_IMAGE_SIZE,
      uploadHelper: uploadImage,
    },
  },
  {
    field: 'description',
    label: '说明',
    as: 'textarea',
    props: { placeholder: '选填，含哪些步骤', rows: 2 },
  },
  { field: 'status', label: '状态', as: 'switch' },
  {
    field: 'sort',
    label: '排序',
    as: 'input-number',
    props: { min: 0 },
  },
  {
    field: 'remark',
    label: '备注',
    as: 'textarea',
    props: { placeholder: '选填', rows: 2 },
  },
]);

function openCreate() {
  editingId.value = null;
  formKey.value += 1;
  modalVisible.value = true;
  void nextTick(() => {
    formRef.value?.setForm?.(emptyForm());
  });
}

function openEdit(row: ServiceItem) {
  editingId.value = row.id;
  formKey.value += 1;
  modalVisible.value = true;
  void nextTick(() => {
    formRef.value?.setForm?.({
      name: row.name,
      category: row.category ?? '',
      durationMinutes: row.durationMinutes,
      bufferMinutes: row.bufferMinutes,
      priceYuan: centsToYuan(row.price),
      description: row.description ?? '',
      images: toUploadItems(row.images),
      status: row.status === 'active',
      sort: row.sort,
      remark: row.remark ?? '',
    });
  });
}

async function handleSubmit() {
  const valid = await formRef.value?.validate();
  if (!valid) return;
  const values = (formRef.value?.getForm?.() ?? form.value) as FormValues;
  const body: CreateServiceItemBody = {
    name: values.name,
    category: values.category || null,
    durationMinutes: Number(values.durationMinutes) || 0,
    bufferMinutes: Number(values.bufferMinutes) || 0,
    // 表单「元」→ 接口「分」
    price: yuanToCents(Number(values.priceYuan)),
    description: values.description || null,
    // 上传组件的内部结构不能直接进接口，只挑上传成功的 url
    images: toImageUrls(values.images),
    status: values.status ? 'active' : 'disabled',
    sort: Number(values.sort) || 0,
    remark: values.remark || null,
  };
  if (editingId.value === null) {
    await createServiceItem(body);
    LewMessage.success('创建成功');
  } else {
    await updateServiceItem(editingId.value, body);
    LewMessage.success('更新成功');
  }
  modalVisible.value = false;
  void refresh();
}

// ---------- 删除 ----------
function handleDelete(row: ServiceItem) {
  confirmDanger({
    title: '删除确认',
    content: `确定删除服务项目「${row.name}」吗？被未完成预约引用时会被拒绝。`,
    onConfirm: async () => {
      try {
        await deleteServiceItem(row.id);
        LewMessage.success('删除成功');
        void refresh();
      } catch {
        // 409 的原文提示（含被哪些单号引用）由 request 拦截器统一弹出，这里不重复提示
      }
    },
  });
}

// ---------- 批量刷新入口（列表刷新按钮） ----------
function handleSearch() {
  void search();
}

function handleReset() {
  query.value = {};
  void search();
}
</script>

<template>
  <div class="page-container">
    <!-- 页头 -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="page-title m-0">服务项目</h2>
        <p class="page-subtitle mt-1 mb-0">
          维护可预约的项目、时长与缓冲；时长与缓冲决定可约时段
        </p>
      </div>
      <LewButton
        v-permission="'biz:serviceitem:create'"
        type="fill"
        @click="openCreate"
      >
        <Plus :size="15" style="margin-right: 4px" /> 新增项目
      </LewButton>
    </div>

    <!-- 搜索栏 -->
    <div class="app-card flex flex-wrap items-center gap-3 p-4">
      <LewInput
        v-model="query.keyword"
        width="200px"
        placeholder="项目名称"
        clearable
        @keyup.enter="handleSearch"
      />
      <LewSelect
        v-model="query.status"
        width="140px"
        :options="statusOptions"
        placeholder="全部状态"
        clearable
      />
      <LewButton type="light" :loading="loading" @click="handleSearch"
        >查询</LewButton
      >
      <LewButton type="text" color="gray" @click="handleReset">重置</LewButton>
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
              permission="biz:serviceitem:update"
              title="编辑"
              @click="openEdit(row as unknown as ServiceItem)"
            >
              <Pencil :size="14" />
            </IconButton>
            <IconButton
              permission="biz:serviceitem:delete"
              color="error"
              title="删除"
              @click="handleDelete(row as unknown as ServiceItem)"
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
      :title="editingId === null ? '新增服务项目' : '编辑服务项目'"
      width="640px"
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
      <div class="p-5">
        <LewForm
          :key="formKey"
          ref="formRef"
          v-model="form"
          label-width="80px"
          :options="formOptions"
        />
      </div>
    </LewModal>
  </div>
</template>
