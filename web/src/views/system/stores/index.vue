<script setup lang="ts">
import { computed, h, nextTick, ref } from 'vue';
import { MapPin, Pencil, Plus, Star, Trash2 } from 'lucide-vue-next';
import {
  LewButton,
  LewForm,
  LewMessage,
  LewModal,
  LewPagination,
  LewTable,
  LewTag,
} from 'lew-ui';
import type { LewTableColumn, LewUploadFileItem } from 'lew-ui';
import { numberProps, withPassThroughRule } from '~/utils/form';
import { filePreviewUrl, uploadFile } from '~/api/files';
import {
  toImageUrls,
  toUploadItems,
  toUploadedItem,
} from '~/utils/upload-images';
import { stripDisplayImageUrl } from '~/utils/image-url';
import { useUploadImagePreview } from '~/composables/useUploadImagePreview';
import { openImagePreview } from '~/composables/useImagePreview';
import { IMAGE_ACCEPT, MAX_UPLOAD_FILE_SIZE } from '~/utils/upload-limits';
import {
  createStore,
  deleteStore,
  setDefaultStore,
  updateStore,
} from '~/api/system/stores';
import { useTable } from '~/composables/useTable';
import { formatDateTime } from '~/composables/useFormat';
import type { Store, StoreBody } from '~/types/api';
import { renderStatus } from '~/utils/render';
import { confirmDanger } from '~/utils/confirm';
import IconButton from '~/components/IconButton.vue';

/**
 * 门店管理（连锁直营 · 阶段 0/1）。
 *
 * 门店是**经营主体**：单据（预约/收款/退款/应收）按门店隔离，会员资产全店通兑。
 * 「默认门店」= 没指定门店时的兜底（小程序门店页、单据写入都用它），
 * 所以后端不允许删默认门店 —— 前端把这条原因原样展示，不自己编文案。
 */
const {
  items,
  loading,
  currentPage,
  pageSize,
  total,
  search,
  refresh,
  handleChange,
} = useTable<Store>({ url: '/stores' });

const columns: LewTableColumn[] = [
  { title: 'ID', field: 'id', width: 70 },
  {
    title: '门店',
    field: 'name',
    width: 220,
    customRender: ({ row }) => {
      const store = row as unknown as Store;
      return store.nameEn ? `${store.name}（${store.nameEn}）` : store.name;
    },
  },
  { title: '编码', field: 'code', width: 110 },
  {
    title: '图片',
    field: 'images',
    width: 96,
    customRender: ({ row }) => {
      const store = row as unknown as Store;
      const urls = store.images ?? [];
      const cover = urls[0];
      if (!cover)
        return h('span', { class: 'text-[var(--app-text-muted)]' }, '-');
      // 点开**全局查看器**（可切换 / 滚轮缩放），不跳新标签页
      return h(
        'div',
        {
          class: 'inline-flex cursor-zoom-in items-center gap-1',
          title: '点击预览（可切换 / 滚轮缩放）',
          onClick: () => openImagePreview(urls, 0, store.name),
        },
        [
          h('img', {
            src: cover,
            alt: '门店图片',
            class:
              'h-28px w-28px rounded-4px border border-[var(--app-border)] object-cover',
          }),
          urls.length > 1
            ? h(
                'span',
                { class: 'text-11.5px text-[var(--app-text-muted)]' },
                `+${urls.length - 1}`,
              )
            : null,
        ],
      );
    },
  },
  { title: '电话', field: 'phone', width: 140 },
  { title: '营业时间', field: 'hours', width: 130 },
  { title: '地址', field: 'address' },
  { title: '排序', field: 'sort', width: 70 },
  {
    title: '状态',
    field: 'status',
    width: 120,
    customRender: ({ row }) => renderStatus((row as { status: string }).status),
  },
  {
    title: '默认',
    field: 'isDefault',
    width: 90,
    customRender: ({ row }) =>
      (row as unknown as Store).isDefault
        ? h(
            LewTag,
            { type: 'light', size: 'small', color: 'primary' },
            () => '默认',
          )
        : '',
  },
  {
    title: '创建时间',
    field: 'createdAt',
    width: 170,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as Store).createdAt),
  },
  { title: '操作', field: 'operation', width: 150, fixed: 'right' },
];

void search();

// ---------- 新增 / 编辑 ----------
type FormValues = {
  code: string;
  name: string;
  nameEn: string;
  phone: string;
  address: string;
  hours: string;
  latitude: number | null;
  longitude: number | null;
  notice: string;
  /** 上传组件的内部形态；提交时经 `toImageUrls` 转成 url 数组 */
  images: LewUploadFileItem[];
  sort: number;
  status: boolean;
};

/** 门店图集上限：与后端 `MAX_STORE_IMAGES` / zod `.max(5)` 同源 */
const MAX_STORE_IMAGES = 5;

/** 上传回调：`as: 'upload'` 调它；成功后必须用 `toUploadedItem` 回填显示态 */
async function uploadImage(params: {
  fileItem: LewUploadFileItem;
  setFileItem: (patch: Partial<LewUploadFileItem>) => void;
}) {
  const { fileItem, setFileItem } = params;
  const file = fileItem.file;
  if (!file) return;
  try {
    const uploaded = await uploadFile(file);
    setFileItem(
      toUploadedItem(fileItem.key, filePreviewUrl(uploaded.id), fileItem.name),
    );
  } catch {
    setFileItem({ key: fileItem.key, status: 'fail', percent: 0 });
  }
}

const modalVisible = ref(false);
const editingId = ref<number | null>(null);
const formRef = ref();
const form = ref<FormValues>(emptyForm());
/** 每次打开弹窗自增，强制重建 LewForm 以回填数据 */
const formKey = ref(0);

// ---------- 图集（上传区缩略图 → 全局查看器） ----------
/** 表单里当前已上传 / 已保存的图片（顺序 = 上传区顺序） */
const formImages = computed(() =>
  (form.value.images ?? [])
    .filter((item) => item.status === 'complete' || item.status === 'success')
    .map((item) => stripDisplayImageUrl(item.url ?? ''))
    .filter((url): url is string => Boolean(url)),
);

/**
 * 上传区缩略图 → 全局查看器。
 *
 * lew-ui 2.8.2 的缩略图**本身不可点**（库里没实现图片预览），所以这里挂一层代理监听；
 * 点缩略图打开的是**同一套**查看器，页面里不再另摆「大图预览」入口。
 */
const uploadHostRef = ref<HTMLElement>();
useUploadImagePreview(
  uploadHostRef,
  () => formImages.value,
  () => form.value.name,
);

function emptyForm(): FormValues {
  return {
    code: '',
    name: '',
    nameEn: '',
    phone: '',
    address: '',
    hours: '10:00 - 20:00',
    latitude: null,
    longitude: null,
    notice: '',
    images: [],
    sort: 0,
    status: true,
  };
}

function openCreate() {
  editingId.value = null;
  formKey.value += 1;
  modalVisible.value = true;
  void nextTick(() => {
    formRef.value?.setForm?.(emptyForm());
  });
}

function openEdit(row: Store) {
  editingId.value = row.id;
  formKey.value += 1;
  modalVisible.value = true;
  void nextTick(() => {
    formRef.value?.setForm?.({
      code: row.code,
      name: row.name,
      nameEn: row.nameEn ?? '',
      phone: row.phone ?? '',
      address: row.address ?? '',
      hours: row.hours ?? '',
      latitude: row.latitude,
      longitude: row.longitude,
      notice: row.notice ?? '',
      images: toUploadItems(row.images),
      sort: row.sort,
      status: row.status === 'active',
    });
  });
}

async function handleSubmit() {
  const valid = await formRef.value?.validate();
  if (!valid) return;
  const values = (formRef.value?.getForm?.() ?? form.value) as FormValues;
  const body: StoreBody = {
    code: values.code.trim(),
    name: values.name.trim(),
    nameEn: values.nameEn.trim() || null,
    phone: values.phone.trim() || null,
    address: values.address.trim() || null,
    hours: values.hours.trim() || null,
    latitude: values.latitude,
    longitude: values.longitude,
    notice: values.notice.trim() || null,
    // 只交可用图片（失败/上传中不交），顺序即展示顺序
    images: toImageUrls(values.images),
    sort: values.sort,
    status: values.status ? 'active' : 'disabled',
  };
  if (editingId.value === null) {
    await createStore(body);
    LewMessage.success('门店已创建');
  } else {
    await updateStore(editingId.value, body);
    LewMessage.success('门店已更新');
  }
  modalVisible.value = false;
  void refresh();
}

// ---------- 设为默认 / 删除 ----------
function handleSetDefault(row: Store) {
  if (row.isDefault) return;
  confirmDanger({
    title: '设为默认门店',
    content: `把「${row.name}」设为默认门店？未指定门店时的单据与小程序门店页都会用它。`,
    confirmText: '设为默认',
    onConfirm: async () => {
      await setDefaultStore(row.id);
      LewMessage.success('已设为默认门店');
      void refresh();
    },
  });
}

function handleDelete(row: Store) {
  confirmDanger({
    title: '删除门店',
    content: `确定删除门店「${row.name}」吗？`,
    onConfirm: async () => {
      await deleteStore(row.id);
      LewMessage.success('删除成功');
      void refresh();
    },
  });
}
</script>

<template>
  <div class="page-container">
    <div class="flex items-center justify-between">
      <div>
        <h2 class="page-title m-0">门店管理</h2>
        <p class="page-subtitle mt-1 mb-0">
          单据（预约 / 收款 / 退款 / 应收）按门店隔离，会员资产全店通兑；
          默认门店是「未指定门店」时的兜底，不可删除
        </p>
      </div>
      <LewButton
        v-permission="'system:store:create'"
        type="fill"
        @click="openCreate"
      >
        <Plus :size="15" style="margin-right: 4px" /> 新增门店
      </LewButton>
    </div>

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
              v-if="!(row as unknown as Store).isDefault"
              permission="system:store:update"
              title="设为默认"
              @click="handleSetDefault(row as unknown as Store)"
            >
              <Star :size="14" />
            </IconButton>
            <IconButton
              permission="system:store:update"
              title="编辑"
              @click="openEdit(row as unknown as Store)"
            >
              <Pencil :size="14" />
            </IconButton>
            <IconButton
              permission="system:store:delete"
              color="error"
              title="删除"
              @click="handleDelete(row as unknown as Store)"
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

    <LewModal
      v-model:visible="modalVisible"
      :title="editingId === null ? '新增门店' : '编辑门店'"
      width="560px"
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
      <div ref="uploadHostRef" class="p-5">
        <LewForm
          :key="formKey"
          ref="formRef"
          v-model="form"
          label-width="88px"
          :options="
            withPassThroughRule([
              {
                field: 'name',
                label: '门店名称',
                as: 'input',
                rule: `Yup.string().required('不能为空')`,
                props: { placeholder: '如：南京西路店', clearable: true },
              },
              {
                field: 'code',
                label: '门店编码',
                as: 'input',
                rule: `Yup.string().required('不能为空')`,
                props: { placeholder: '唯一，如 MAIN / XJH', clearable: true },
              },
              {
                field: 'nameEn',
                label: '英文副标题',
                as: 'input',
                props: {
                  placeholder: '选填，如 BEAUTY NAILS',
                  clearable: true,
                },
              },
              {
                field: 'phone',
                label: '门店电话',
                as: 'input',
                props: { placeholder: '选填', clearable: true },
              },
              {
                field: 'hours',
                label: '营业时间',
                as: 'input',
                props: { placeholder: '如 10:00 - 20:00', clearable: true },
              },
              {
                field: 'address',
                label: '门店地址',
                as: 'input',
                props: {
                  placeholder: '选填，小程序门店页展示',
                  clearable: true,
                },
              },
              {
                field: 'latitude',
                label: '纬度',
                as: 'input-number',
                props: numberProps({ min: -90, max: 90, decimals: 6 }),
              },
              {
                field: 'longitude',
                label: '经度',
                as: 'input-number',
                props: numberProps({ min: -180, max: 180, decimals: 6 }),
              },
              {
                field: 'notice',
                label: '公告',
                as: 'textarea',
                props: { placeholder: '选填，如「本周三店休」', rows: 2 },
              },
              {
                field: 'images',
                label: '门店图片',
                as: 'upload',
                props: {
                  multiple: true,
                  limit: MAX_STORE_IMAGES,
                  accept: IMAGE_ACCEPT,
                  viewMode: 'card',
                  maxFileSize: MAX_UPLOAD_FILE_SIZE,
                  uploadHelper: uploadImage,
                },
              },
              {
                field: 'sort',
                label: '排序',
                as: 'input-number',
                props: { min: 0 },
              },
              { field: 'status', label: '启用', as: 'switch' },
            ])
          "
        />
        <p class="hint mt-3 mb-0">
          <MapPin :size="13" style="display: inline; vertical-align: -2px" />
          经纬度用于小程序「导航到店」，可先留空；门店图片最多 5
          张（第一张当封面，小程序门店页展示）； 默认门店请在列表里点星标设置。
        </p>
      </div>
    </LewModal>
  </div>
</template>

<style scoped>
.hint {
  font-size: 12px;
  color: var(--lew-text-color-3);
}
</style>
