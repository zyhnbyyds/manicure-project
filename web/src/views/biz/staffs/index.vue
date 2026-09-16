<script setup lang="ts">
import { computed, h, nextTick, reactive, ref } from 'vue';
import { Pencil, Plus, Settings2, Trash2 } from 'lucide-vue-next';
import {
  LewButton,
  LewDrawer,
  LewForm,
  LewInput,
  LewMessage,
  LewModal,
  LewPagination,
  LewSelect,
  LewTable,
} from 'lew-ui';
import type { LewFormOption, LewTableColumn, LewUploadFileItem } from 'lew-ui';
import { withPassThroughRule } from '~/utils/form';
import {
  createStaff,
  deleteStaff,
  getStaffServiceItems,
  getStaffStores,
  setStaffServiceItems,
  setStaffStores,
  updateStaff,
} from '~/api/biz/staffs';
import type { CreateStaffBody, Staff } from '~/api/biz/staffs';
import { filePreviewUrl, uploadFile } from '~/api/files';
import { listActiveServiceItems } from '~/api/biz/service-items';
import { getMyStores } from '~/api/system/stores';
import { listUsers } from '~/api/system/users';
import { useTable } from '~/composables/useTable';
import { formatDateTime } from '~/composables/useFormat';
import type { EntityStatus } from '~/types/api';
import { useUserStore } from '~/store/user';
import { renderStatus } from '~/utils/render';
import { confirmDanger } from '~/utils/confirm';
import IconButton from '~/components/IconButton.vue';
import { openImagePreview } from '~/composables/useImagePreview';
import { useUploadImagePreview } from '~/composables/useUploadImagePreview';
import { withDisabledSelected } from '~/utils/select-options';
import type { SelectOption } from '~/utils/select-options';
import {
  toImageUrls,
  toSingleImageUrl,
  toUploadItems,
  toUploadedItem,
} from '~/utils/upload-images';
import { IMAGE_ACCEPT, MAX_UPLOAD_FILE_SIZE } from '~/utils/upload-limits';
import { trimCell } from '~/utils/table-text';

const userStore = useUserStore();

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
} = useTable<Staff>({ url: '/biz/staffs', query: () => query.value });

const columns: LewTableColumn[] = [
  { title: 'ID', field: 'id', width: 70 },
  {
    title: '头像',
    field: 'avatar',
    width: 76,
    customRender: ({ row }) => {
      const staff = row as unknown as Staff;
      const avatar = staff.avatar;
      if (!avatar)
        return h('span', { class: 'text-[var(--app-text-muted)]' }, '-');
      // 头像也走全局查看器：小图看不清五官时能放大（同一套交互，不另开新窗口）
      return h('img', {
        src: avatar,
        alt: 'avatar',
        class:
          'w-28px h-28px rounded-full object-cover cursor-zoom-in transition-transform hover:scale-110',
        title: '点击查看大图',
        onClick: () => openImagePreview([avatar], 0, staff.nickname),
      });
    },
  },
  { title: '昵称 / 艺名', field: 'nickname', width: 140 },
  {
    title: '电话',
    field: 'phone',
    width: 130,
    customRender: ({ row }) => (row as unknown as Staff).phone ?? '-',
  },
  {
    title: '简介',
    field: 'bio',
    customRender: ({ row }) => {
      const text = (row as unknown as Staff).bio;
      return trimCell(text);
    },
  },
  {
    title: '后台账号',
    field: 'userId',
    width: 110,
    customRender: ({ row }) => {
      const userId = (row as unknown as Staff).userId;
      return userId ? `#${userId}` : '未绑定';
    },
  },
  {
    title: '服务门店',
    field: 'stores',
    width: 170,
    customRender: ({ row }) => {
      const stores = (row as unknown as Staff).stores ?? [];
      // 空 = 不限门店（与「可做项目」同款约定），必须显式写出来，
      // 否则会被当成「还没配」—— 而它其实是「全店都能约」。
      if (!stores.length)
        return h('span', { class: 'text-[var(--app-text-muted)]' }, '全部门店');
      return trimCell(stores.map((store) => store.name).join('、'));
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
      formatDateTime((row as unknown as Staff).createdAt),
  },
  { title: '操作', field: 'operation', width: 130, fixed: 'right' },
];

void search();

// ---------- 后台账号下拉（无 system:user:list 权限时退化为手填 ID） ----------
const canListUsers = userStore.hasPermission('system:user:list');
const userOptions = reactive<{ label: string; value: string }[]>([]);

async function loadUserOptions() {
  if (!canListUsers) return;
  const data = await listUsers(1, 200);
  userOptions.splice(
    0,
    userOptions.length,
    ...data.items.map((user) => ({
      label: `${user.displayName}（${user.username}）`,
      value: String(user.id),
    })),
  );
}
void loadUserOptions();

// ---------- 新增 / 编辑 ----------
type FormValues = {
  nickname: string;
  /**
   * 头像：表单里存上传组件的 `LewUploadFileItem[]`（**单张**），
   * 接口收发的是 `string | null` —— 两侧互转见 `~/utils/upload-images`。
   */
  avatar: LewUploadFileItem[];
  phone: string;
  bio: string;
  /** 下拉是字符串，提交时转 number */
  userId: string;
  status: boolean;
  sort: number;
  remark: string;
};

function emptyForm(): FormValues {
  return {
    nickname: '',
    avatar: [],
    phone: '',
    bio: '',
    userId: '',
    status: true,
    sort: 0,
    remark: '',
  };
}

/**
 * 头像上传：走统一文件接口，成功后用 `toUploadedItem` 回填。
 *
 * **必须用 `toUploadedItem`**（它会做显示态归一化）——
 * 直接塞 `filePreviewUrl(id)` 的话，刚传的头像会显示成文件图标（这个坑踩过）。
 */
async function uploadAvatar(params: {
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
    // 失败原因（类型 / 体积 / 网络）已由 request 拦截器统一提示，这里只标记状态
    setFileItem({ key: fileItem.key, status: 'fail', percent: 0 });
  }
}

const modalVisible = ref(false);
const editingId = ref<number | null>(null);
const formRef = ref();
const form = ref<FormValues>(emptyForm());
/** 表单 key：每次打开弹窗自增，强制重建 LewForm 以回填数据 */
const formKey = ref(0);

/**
 * 头像缩略图 → 全局查看器。
 *
 * lew-ui 的缩略图本身不可点（2.8.2 没有图片预览实现），这里挂一层代理监听：
 * 上传完能立刻放大确认「是不是这张脸」，而不用先保存再回到列表看。
 */
const formAvatarImages = computed(() => toImageUrls(form.value.avatar));
const avatarHostRef = ref<HTMLElement>();
useUploadImagePreview(
  avatarHostRef,
  () => formAvatarImages.value,
  () => form.value.nickname,
);

const formOptions = computed<LewFormOption[]>(() =>
  withPassThroughRule([
    {
      field: 'nickname',
      label: '昵称',
      as: 'input',
      rule: "Yup.string().required('不能为空')",
      props: { placeholder: '如 小美', clearable: true },
    },
    {
      field: 'avatar',
      label: '头像',
      as: 'upload',
      tips: '选填；上传后展示为圆形头像',
      props: {
        limit: 1,
        accept: IMAGE_ACCEPT,
        viewMode: 'card',
        maxFileSize: MAX_UPLOAD_FILE_SIZE,
        uploadHelper: uploadAvatar,
      },
    },
    {
      field: 'phone',
      label: '电话',
      as: 'input',
      props: { placeholder: '选填', clearable: true },
    },
    {
      field: 'userId',
      label: '后台账号',
      as: canListUsers ? 'select' : 'input-number',
      tips: canListUsers
        ? '选填；一个账号只能绑定一位美甲师，绑定后该账号只能看自己的预约'
        : '选填，填后台用户 ID（无「用户管理」列表权限时只能手填）',
      props: canListUsers
        ? {
            options: userOptions,
            placeholder: '不绑定后台账号',
            clearable: true,
          }
        : { min: 1, placeholder: '选填，用户 ID' },
    },
    {
      field: 'bio',
      label: '简介',
      as: 'textarea',
      props: { placeholder: '选填，擅长风格', rows: 2 },
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
  ]),
);

function openCreate() {
  editingId.value = null;
  formKey.value += 1;
  modalVisible.value = true;
  void nextTick(() => {
    formRef.value?.setForm?.(emptyForm());
  });
}

function openEdit(row: Staff) {
  editingId.value = row.id;
  formKey.value += 1;
  modalVisible.value = true;
  void nextTick(() => {
    formRef.value?.setForm?.({
      nickname: row.nickname,
      // 库里是地址字符串，上传组件要的是 `LewUploadFileItem[]`
      avatar: toUploadItems(row.avatar ? [row.avatar] : []),
      phone: row.phone ?? '',
      bio: row.bio ?? '',
      userId: row.userId === null ? '' : String(row.userId),
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
  const userId = Number(values.userId);
  const body: CreateStaffBody = {
    nickname: values.nickname,
    // 上传组件的表单值 → 接口要的 `string | null`
    avatar: toSingleImageUrl(values.avatar),
    phone: values.phone || null,
    bio: values.bio || null,
    userId: Number.isInteger(userId) && userId > 0 ? userId : null,
    status: values.status ? 'active' : 'disabled',
    sort: Number(values.sort) || 0,
    remark: values.remark || null,
  };
  if (editingId.value === null) {
    await createStaff(body);
    LewMessage.success('创建成功');
  } else {
    await updateStaff(editingId.value, body);
    LewMessage.success('更新成功');
  }
  modalVisible.value = false;
  void refresh();
}

// ---------- 删除 ----------
function handleDelete(row: Staff) {
  confirmDanger({
    title: '删除确认',
    content: `确定删除美甲师「${row.nickname}」吗？存在未完成预约时会被拒绝。`,
    onConfirm: async () => {
      try {
        await deleteStaff(row.id);
        LewMessage.success('删除成功');
        void refresh();
      } catch {
        // 409 原文提示由 request 拦截器统一弹出
      }
    },
  });
}

// ---------- 详情抽屉：可做项目（§22） ----------
const drawerVisible = ref(false);
const detail = ref<Staff | null>(null);
/** 抽屉里展示的头像地址（空串表示没传过） */
const detailAvatar = computed(() => detail.value?.avatar ?? '');
const itemOptions = ref<SelectOption[]>([]);
const selectedItemIds = ref<string[]>([]);
const itemsLoading = ref(false);
/** 选项拉取失败（网络 / 权限）：不要伪装成「没有可选项目」 */
const optionsFailed = ref(false);
/**
 * 选择器的重建 key。
 *
 * ## 为什么必须等选项就绪再挂载（这个坑真踩过）
 *
 * lew-ui 的 `LewSelect` 在 `setup` 时把 `options` **快照**进内部的
 * `sourceFlattenOptions`，而多选模式下「已选项目的标签」正是从这个快照渲染的
 * （`lew-ui/dist/index.js`：`V = () => (c.sourceFlattenOptions || []).filter(...)`，
 * 再交给 `LewSelectInput` 用 `formatItems` 逐个渲染 `LewTag`）。
 * `watch(options)` 只刷新 `c.options`（下拉列表），**不刷新那个快照**。
 *
 * 抽屉体是 `v-if` 的（`LewDrawer` 里 `visible ? <div class="lew-drawer-body"> : null`），
 * 所以：先 `drawerVisible = true` 再异步取选项 ⇒ 组件带着**空**选项挂载 ⇒
 * 已配置的可做项目一个都不显示；关掉再打开（组件重建、这次选项已在）反而正常 ——
 * 用户看到的就是「第一次渲染不出来」。
 *
 * 对策：① 选项没就绪时**不渲染** `LewSelect`（见模板 `v-if`）；
 * ② 每次拿到新选项就换 `key`，保证挂载时快照就是最新的。
 */
const optionsKey = ref(0);

/* ---------------- 服务门店（连锁直营，阶段 1.9） ---------------- */

/** 门店选项：与项目选项同一个坑 —— **等就绪再挂载**（`storeOptionsKey` 同上） */
const storeOptions = ref<SelectOption[]>([]);
const storeOptionsKey = ref(0);
const selectedStoreIds = ref<string[]>([]);

async function fetchStoreOptions(): Promise<SelectOption[]> {
  /*
   * 用 `GET /stores/mine`（登录即可）而不是门店管理页的 `listStores`：
   * 后者要 `system:store:list`，而店长本来就不该有「门店档案」权限 ——
   * 但他得能把自己店的美甲师配到本店。`/stores/mine` 回的就是「我能操作的门店」。
   */
  const data = await getMyStores();
  return data.stores.map((store) => ({
    label: store.name,
    value: String(store.id),
  }));
}

async function handleSaveStores() {
  if (!detail.value) return;
  await setStaffStores(detail.value.id, selectedStoreIds.value.map(Number));
  search();
  LewMessage.success('服务门店已保存');
}

/** 清空 = 可服务全部门店（与「可做项目」的默认行为对齐） */
async function handleClearStores() {
  if (!detail.value) return;
  selectedStoreIds.value = [];
  await setStaffStores(detail.value.id, []);
  LewMessage.success('已恢复为「可服务全部门店」');
}

/** 当前配置里已停用（保存会被后端拒绝）的项目名 */
const disabledSelected = computed(() => {
  const disabled = new Set(
    itemOptions.value
      .filter((option) => option.disabled)
      .map((option) => option.value),
  );
  return selectedItemIds.value.filter((id) => disabled.has(id));
});

async function fetchItemOptions(): Promise<SelectOption[]> {
  const data = await listActiveServiceItems();
  return data.items.map((item) => ({
    label: `${item.name}（${item.durationMinutes} 分钟）`,
    value: String(item.id),
  }));
}

async function openDetail(row: Staff) {
  detail.value = row;
  drawerVisible.value = true;
  itemsLoading.value = true;
  optionsFailed.value = false;
  try {
    const [selected, options, storeOptionList, staffStores] = await Promise.all(
      [
        getStaffServiceItems(row.id),
        fetchItemOptions(),
        fetchStoreOptions(),
        getStaffStores(row.id),
      ],
    );
    // 已配置但已停用的项目：保留在选项里并标注，避免「保存后被静默丢弃」
    itemOptions.value = withDisabledSelected(options, selected);
    optionsKey.value += 1;
    selectedItemIds.value = selected.map((item) => String(item.id));
    storeOptions.value = storeOptionList;
    storeOptionsKey.value += 1;
    selectedStoreIds.value = staffStores.map((store) => String(store.id));
  } catch {
    // 失败原因由 request 拦截器统一提示；这里只保证 UI 不谎报「没有可选项目」
    optionsFailed.value = true;
  } finally {
    itemsLoading.value = false;
  }
}

function retryItemOptions() {
  if (detail.value) void openDetail(detail.value);
}

async function handleSaveItems() {
  if (!detail.value) return;
  if (disabledSelected.value.length) {
    LewMessage.error(
      '已停用的项目不能配置给美甲师，请先取消勾选或重新启用项目',
    );
    return;
  }
  await setStaffServiceItems(
    detail.value.id,
    selectedItemIds.value.map((id) => Number(id)),
  );
  LewMessage.success('可做项目已保存');
}

/** 清空 = 可做全部（§22 的默认行为） */
async function handleClearItems() {
  if (!detail.value) return;
  selectedItemIds.value = [];
  await setStaffServiceItems(detail.value.id, []);
  LewMessage.success('已恢复为「可做全部项目」');
}
</script>

<template>
  <div class="page-container">
    <!-- 页头 -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="page-title m-0">美甲师</h2>
        <p class="page-subtitle mt-1 mb-0">
          维护美甲师档案与「可做项目」；不配可做项目 = 可做全部
        </p>
      </div>
      <LewButton
        v-permission="'biz:staff:create'"
        type="fill"
        @click="openCreate"
      >
        <Plus :size="15" style="margin-right: 4px" /> 新增美甲师
      </LewButton>
    </div>

    <!-- 搜索栏 -->
    <div class="app-card flex flex-wrap items-center gap-3 p-4">
      <LewInput
        v-model="query.keyword"
        width="200px"
        placeholder="昵称 / 手机号"
        clearable
        @keyup.enter="search()"
      />
      <LewSelect
        v-model="query.status"
        width="140px"
        :options="statusOptions"
        placeholder="全部状态"
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
              permission="biz:staff:list"
              title="详情 / 可做项目"
              @click="openDetail(row as unknown as Staff)"
            >
              <Settings2 :size="14" />
            </IconButton>
            <IconButton
              permission="biz:staff:update"
              title="编辑"
              @click="openEdit(row as unknown as Staff)"
            >
              <Pencil :size="14" />
            </IconButton>
            <IconButton
              permission="biz:staff:delete"
              color="error"
              title="删除"
              @click="handleDelete(row as unknown as Staff)"
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
          show-summary
          @change="handleChange"
        />
      </div>
    </div>

    <!-- 新增 / 编辑弹窗 -->
    <LewModal
      v-model:visible="modalVisible"
      :title="editingId === null ? '新增美甲师' : '编辑美甲师'"
      width="520px"
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
        <!-- 头像缩略图由 `useUploadImagePreview` 接管 → 点击打开全局查看器 -->
        <div ref="avatarHostRef">
          <LewForm
            :key="formKey"
            ref="formRef"
            v-model="form"
            label-width="80px"
            :options="formOptions"
          />
        </div>
        <p
          v-if="formAvatarImages.length"
          class="mt-1 ml-80px text-12px text-[var(--app-text-muted)]"
        >
          点击头像缩略图可放大预览
        </p>
      </div>
    </LewModal>

    <!-- 详情抽屉：档案 + 可做项目 -->
    <LewDrawer
      v-model:visible="drawerVisible"
      :title="`美甲师详情 - ${detail?.nickname ?? ''}`"
      position="right"
      width="520px"
      :footer-buttons="[
        {
          props: {
            type: 'text',
            color: 'gray',
            size: 'small',
            text: '关闭',
            request: () => {
              drawerVisible = false;
            },
          },
        },
      ]"
    >
      <div class="flex flex-col gap-4 p-5">
        <!-- 档案摘要 -->
        <div class="app-card p-4">
          <div class="mb-3 text-14px font-600">档案</div>
          <div class="grid grid-cols-2 gap-2 text-13px">
            <div class="text-[var(--app-text-muted)]">头像</div>
            <div>
              <img
                v-if="detailAvatar"
                :src="detailAvatar"
                alt="头像"
                title="点击查看大图"
                class="h-48px w-48px cursor-zoom-in rounded-full border border-[var(--app-border)] object-cover transition-transform hover:scale-105"
                @click="
                  openImagePreview(
                    [detailAvatar],
                    0,
                    detail?.nickname ?? '美甲师头像',
                  )
                "
              />
              <span v-else class="text-[var(--app-text-muted)]">未上传</span>
            </div>
            <div class="text-[var(--app-text-muted)]">昵称</div>
            <div>{{ detail?.nickname ?? '-' }}</div>
            <div class="text-[var(--app-text-muted)]">电话</div>
            <div>{{ detail?.phone ?? '-' }}</div>
            <div class="text-[var(--app-text-muted)]">状态</div>
            <div>
              <span v-if="detail?.status === 'active'">启用</span>
              <span v-else class="text-[var(--lew-color-error)]">停用</span>
            </div>
            <div class="text-[var(--app-text-muted)]">后台账号</div>
            <div>{{ detail?.userId ? '#' + detail.userId : '未绑定' }}</div>
            <div class="text-[var(--app-text-muted)]">简介</div>
            <div>{{ detail?.bio || '-' }}</div>
          </div>
        </div>

        <!-- 可做项目（§22） -->
        <div class="app-card p-4">
          <div class="mb-2 flex items-center justify-between">
            <span class="text-14px font-600">可做项目</span>
            <LewButton
              v-permission="'biz:staff:items'"
              type="text"
              color="gray"
              size="small"
              @click="handleClearItems"
              >清空（= 可做全部）</LewButton
            >
          </div>

          <!-- 空数组 = 可做全部：必须显式提示，否则店员会误以为该美甲师什么都不会 -->
          <div
            class="mb-3 rounded-8px border border-[var(--app-border)] bg-[var(--app-bg-hover)] p-3 text-12.5px leading-5"
          >
            <div class="font-600">
              未选择任何项目 ·
              <span class="text-[var(--lew-color-primary)]"
                >空 = 可做全部项目</span
              >
            </div>
            <div class="mt-1 text-[var(--app-text-secondary)]">
              这是新建美甲师的默认行为（§22）。一旦勾选了任意项目，就变成「白名单」：
              未被勾选的项目在可约时段与下单时都会被拒绝（`reason=staff_cannot_do`）。
            </div>
          </div>

          <!--
            选择器**必须等选项就绪再挂载**：LewSelect 会在 setup 时把 options
            快照进内部状态（多选标签靠它渲染），选项后到的话标签永远刷不出来。
            详见 `optionsKey` 的注释。
          -->
          <div
            v-if="itemsLoading"
            class="rounded-8px border border-dashed border-[var(--app-border)] px-3 py-4 text-center text-12.5px text-[var(--app-text-muted)]"
          >
            正在加载可选项目…
          </div>
          <div
            v-else-if="optionsFailed"
            class="flex items-center gap-2 rounded-8px border border-[var(--lew-color-error)] px-3 py-3 text-12.5px text-[var(--lew-color-error)]"
          >
            <span>可选项目加载失败。</span>
            <LewButton
              type="text"
              color="error"
              size="small"
              @click="retryItemOptions"
              >重试</LewButton
            >
          </div>
          <div
            v-else-if="!itemOptions.length"
            class="rounded-8px border border-dashed border-[var(--app-border)] px-3 py-4 text-center text-12.5px text-[var(--app-text-muted)]"
          >
            暂无启用中的服务项目，请先到「服务项目」页新增并启用
          </div>
          <LewSelect
            v-else
            :key="optionsKey"
            v-model="selectedItemIds"
            width="100%"
            multiple
            clearable
            placeholder="不选 = 可做全部项目"
            :options="itemOptions"
          />
          <div class="mt-2 text-12.5px text-[var(--app-text-secondary)]">
            当前配置：{{
              selectedItemIds.length
                ? `限做 ${selectedItemIds.length} 个项目`
                : '可做全部项目'
            }}
          </div>
          <div
            v-if="disabledSelected.length"
            class="mt-2 text-12.5px text-[var(--lew-color-error)]"
          >
            有
            {{ disabledSelected.length }}
            个已停用项目仍在配置中，保存会被拒绝，请取消勾选。
          </div>

          <div class="mt-3 flex items-center gap-2">
            <LewButton
              v-permission="'biz:staff:items'"
              type="fill"
              size="small"
              :loading="itemsLoading"
              @click="handleSaveItems"
              >保存可做项目</LewButton
            >
            <span class="text-12.5px text-[var(--app-text-muted)]"
              >整体替换（PUT），非增量更新</span
            >
          </div>
        </div>

        <!-- 服务门店（连锁直营）：空 = 全部门店 -->
        <div class="app-card p-4">
          <div class="mb-2 flex items-center justify-between">
            <span class="text-14px font-600">服务门店</span>
            <LewButton
              v-permission="'biz:staff:stores'"
              type="text"
              color="gray"
              size="small"
              @click="handleClearStores"
              >清空（= 全部门店）</LewButton
            >
          </div>

          <!-- 空数组 = 全部门店：必须显式提示，否则会被当成「哪家店都不能约」 -->
          <div
            class="mb-3 rounded-8px border border-[var(--app-border)] bg-[var(--app-bg-hover)] p-3 text-12.5px leading-5"
          >
            <div class="font-600">
              未选择任何门店 ·
              <span class="text-[var(--lew-color-primary)]"
                >空 = 可服务全部门店</span
              >
            </div>
            <div class="mt-1 text-[var(--app-text-secondary)]">
              勾选后就变成白名单：只有这几家店能约到该美甲师（跨店支援就把他勾到那家店）。
              <span class="font-600">注意排班不区分门店</span
              >（一人一份周模板）， 「这家店今天谁在」仍由班次与预约决定。
            </div>
          </div>

          <!-- 与项目选择器同一个坑：选项就绪后再挂载（见 optionsKey 的注释） -->
          <div
            v-if="storeOptionsKey === 0"
            class="rounded-8px border border-dashed border-[var(--app-border)] px-3 py-4 text-center text-12.5px text-[var(--app-text-muted)]"
          >
            正在加载可选门店…
          </div>
          <div
            v-else-if="!storeOptions.length"
            class="rounded-8px border border-dashed border-[var(--app-border)] px-3 py-4 text-center text-12.5px text-[var(--app-text-muted)]"
          >
            没有可配置的门店（你的账号没有门店可见范围，或门店都已停用）
          </div>
          <LewSelect
            v-else
            :key="storeOptionsKey"
            v-model="selectedStoreIds"
            width="100%"
            multiple
            clearable
            placeholder="不选 = 可服务全部门店"
            :options="storeOptions"
          />
          <div class="mt-2 text-12.5px text-[var(--app-text-secondary)]">
            当前配置：{{
              selectedStoreIds.length
                ? `限服务 ${selectedStoreIds.length} 家门店`
                : '可服务全部门店'
            }}
          </div>

          <div class="mt-3 flex items-center gap-2">
            <LewButton
              v-permission="'biz:staff:stores'"
              type="fill"
              size="small"
              :loading="itemsLoading"
              @click="handleSaveStores"
              >保存服务门店</LewButton
            >
            <span class="text-12.5px text-[var(--app-text-muted)]"
              >整体替换（PUT），非增量更新</span
            >
          </div>
        </div>
      </div>
    </LewDrawer>
  </div>
</template>
