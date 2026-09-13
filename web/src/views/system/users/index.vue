<script setup lang="ts">
import { h, nextTick, reactive, ref } from 'vue';
import { Pencil, Plus, Store as StoreIcon, Trash2 } from 'lucide-vue-next';
import {
  LewButton,
  LewForm,
  LewMessage,
  LewModal,
  LewPagination,
  LewSelect,
  LewTable,
} from 'lew-ui';
import type { LewFormOption } from 'lew-ui';
import { withPassThroughRule } from '~/utils/form';
import type { LewTableColumn } from 'lew-ui';
import { createUser, deleteUser, updateUser } from '~/api/system/users';
import {
  getUserStores,
  listStores,
  setUserStores,
} from '~/api/system/stores';
import { listDepts } from '~/api/system/depts';
import { listRoles } from '~/api/system/roles';
import { useTable } from '~/composables/useTable';
import { formatDateTime } from '~/composables/useFormat';
import type { Dept, User } from '~/types/api';
import { renderStatus } from '~/utils/render';
import { confirmDanger } from '~/utils/confirm';
import { trimCell } from '~/utils/table-text';
import IconButton from '~/components/IconButton.vue';
import { openImagePreview } from '~/composables/useImagePreview';

// ---------- 列表 ----------
const statusFilters = [
  { label: '启用', value: 'active' },
  { label: '禁用', value: 'disabled' },
];
/** 部门下拉开平（带层级前缀）；lew-ui 下拉框 value 约定为字符串 */
function flattenDepts(
  list: Dept[],
  prefix = '',
): { label: string; value: string }[] {
  return list.flatMap((dept) => {
    const label = `${prefix}${dept.name}`;
    const self = { label, value: String(dept.id) };
    const children = dept.children?.length
      ? flattenDepts(dept.children, `${label} / `)
      : [];
    return [self, ...children];
  });
}
const deptFilterOptions = reactive<{ label: string; value: string }[]>([]);
const deptFormOptions = reactive<{ label: string; value: number }[]>([]);
async function loadDeptOptions() {
  const depts = await listDepts();
  const options = flattenDepts(depts);
  deptFilterOptions.splice(0, deptFilterOptions.length, ...options);
  deptFormOptions.splice(
    0,
    deptFormOptions.length,
    ...options.map((option) => ({
      label: option.label,
      value: Number(option.value),
    })),
  );
}
void loadDeptOptions();

const query = ref<{ status?: string; deptId?: string }>({});
const {
  items,
  loading,
  currentPage,
  pageSize,
  total,
  search,
  refresh,
  handleChange,
} = useTable<User>({ url: '/system/users', query: () => query.value });

const columns: LewTableColumn[] = [
  { title: 'ID', field: 'id', width: 70 },
  { title: '用户名', field: 'username', width: 130 },
  {
    title: '头像',
    field: 'avatar',
    width: 80,
    customRender: ({ row }) => {
      const user = row as unknown as User;
      const avatar = user.avatar;
      if (!avatar)
        return h('span', { class: 'text-[var(--app-text-muted)]' }, '-');
      // 头像走全局查看器（同一套缩放 / 拖拽交互，不另开新窗口）
      return h('img', {
        src: avatar,
        alt: 'avatar',
        class:
          'w-28px h-28px rounded-full object-cover cursor-zoom-in transition-transform hover:scale-110',
        title: '点击查看大图',
        onClick: () => openImagePreview([avatar], 0, user.displayName),
      });
    },
  },
  { title: '显示名称', field: 'displayName', width: 130 },
  {
    title: '部门',
    field: 'deptName',
    width: 130,
    customRender: ({ row }) => (row as unknown as User).deptName ?? '-',
  },
  {
    title: '角色',
    field: 'roleNames',
    width: 140,
    customRender: ({ row }) => {
      const names = (row as unknown as User).roleNames ?? [];
      return h(
        'span',
        { class: 'text-12.5px' },
        names.length ? names.join('、') : '-',
      );
    },
  },
  {
    /**
     * 可见门店（连锁直营）。
     *
     * 空 = 这个账号**看不到任何门店的业务数据**（预约/收款/退款/应收都会 403）。
     * 这里用红色提示而不是 `-`：`-` 会被当成「没配置」而忽略过去，
     * 而这条恰恰是「新开的店长账号为什么什么都看不到」的常见原因。
     */
    title: '可见门店',
    field: 'stores',
    width: 180,
    customRender: ({ row }) => {
      const stores = (row as unknown as User).stores ?? [];
      if (!stores.length) {
        return h(
          'span',
          { class: 'text-12.5px', style: 'color: var(--lew-color-error)' },
          '未分配（看不到业务数据）',
        );
      }
      return h(
        'span',
        { class: 'text-12.5px' },
        stores.map((store) => store.name).join('、'),
      );
    },
  },
  {
    title: '邮箱',
    field: 'email',
    width: 180,
    customRender: ({ row }) => {
      const email = (row as unknown as User).email;
      return trimCell(email);
    },
  },
  { title: '手机号', field: 'phone', width: 120 },
  {
    title: '状态',
    field: 'status',
    width: 90,
    customRender: ({ row }) => renderStatus((row as { status: string }).status),
  },
  {
    title: '创建时间',
    field: 'createdAt',
    width: 160,
    customRender: ({ row }) =>
      formatDateTime((row as unknown as User).createdAt),
  },
  {
    title: '最近登录',
    field: 'loginAt',
    width: 160,
    customRender: ({ row }) => formatDateTime((row as unknown as User).loginAt),
  },
  { title: '操作', field: 'operation', width: 100, fixed: 'right' },
];

void search();

// ---------- 角色选项 ----------
const roleOptions = reactive<{ label: string; value: number }[]>([]);
/**
 * 选项就绪 Promise：**打开弹窗要等它**。
 *
 * lew-ui 的 `LewSelect`（多选）在 `setup` 时把 `options` 快照进内部状态，
 * 「已选角色的标签」从快照渲染；选项晚于弹窗挂载到达 ⇒ 编辑时回填的角色不显示。
 */
let rolesReady: Promise<void> | null = null;
async function loadRoles() {
  const roles = await listRoles();
  roleOptions.splice(
    0,
    roleOptions.length,
    ...roles.map((r) => ({ label: r.name, value: r.id })),
  );
}
function ensureRoles(): Promise<void> {
  rolesReady ??= loadRoles().catch(() => {
    // 失败已由拦截器提示；放行让弹窗照常打开，并允许下次进入时重试
    rolesReady = null;
  });
  return rolesReady;
}
void ensureRoles();

// ---------- 新增/编辑弹窗 ----------
const modalVisible = ref(false);
const editingId = ref<number | null>(null);
const formRef = ref();
const form = ref({
  username: '',
  displayName: '',
  password: '',
  email: '',
  phone: '',
  status: true,
  deptId: undefined as number | undefined,
  roleIds: [] as number[],
});
/** 表单 key：每次打开弹窗自增，强制重建 LewForm 以回填数据 */
const formKey = ref(0);

const formOptions: LewFormOption[] = withPassThroughRule([
  {
    field: 'username',
    label: '用户名',
    as: 'input',
    rule: "Yup.string().required('不能为空')",
    props: { placeholder: '3-64 个字符', clearable: true },
  },
  {
    field: 'displayName',
    label: '显示名称',
    as: 'input',
    rule: "Yup.string().required('不能为空')",
    props: { placeholder: '请输入显示名称', clearable: true },
  },
  {
    field: 'deptId',
    label: '部门',
    as: 'select',
    props: {
      options: deptFormOptions,
      placeholder: '请选择部门',
      clearable: true,
    },
  },
  {
    field: 'password',
    label: '密码',
    as: 'input',
    rule: 'Yup.string().nullable()',
    props: {
      type: 'password',
      placeholder: '新增必填；编辑选填，不填则不修改',
      clearable: true,
      showPassword: true,
    },
  },
  {
    field: 'email',
    label: '邮箱',
    as: 'input',
    props: { placeholder: '选填', clearable: true },
  },
  {
    field: 'phone',
    label: '手机号',
    as: 'input',
    props: { placeholder: '选填', clearable: true },
  },
  {
    field: 'status',
    label: '状态',
    as: 'switch',
  },
  {
    field: 'roleIds',
    label: '角色',
    as: 'select',
    rule: 'Yup.array().nullable()',
    props: { options: roleOptions, multiple: true, placeholder: '请选择角色' },
  },
]);

async function openCreate() {
  // 先等角色选项就绪再挂载弹窗（否则多选标签刷不出来）
  await ensureRoles();
  editingId.value = null;
  formKey.value += 1;
  modalVisible.value = true;
  // LewForm 为受控组件，需在挂载后通过 setForm 填充
  void nextTick(() => {
    formRef.value?.setForm?.({
      username: '',
      displayName: '',
      password: '',
      email: '',
      phone: '',
      status: true,
      deptId: undefined,
      roleIds: [],
    });
  });
}

async function openEdit(row: User) {
  // 同 openCreate：等角色选项就绪
  await ensureRoles();
  editingId.value = row.id;
  formKey.value += 1;
  modalVisible.value = true;
  // LewForm 为受控组件，需在挂载后通过 setForm 回填现有数据
  void nextTick(() => {
    formRef.value?.setForm?.({
      username: row.username,
      displayName: row.displayName,
      password: '',
      email: row.email ?? '',
      phone: row.phone ?? '',
      status: row.status === 'active',
      deptId: row.deptId ?? undefined,
      roleIds: row.roleIds ?? [],
    });
  });
}

async function handleSubmit() {
  const valid = await formRef.value?.validate();
  if (!valid) return;
  // LewForm 为受控组件，用 getForm 读取用户真实输入
  const values = (formRef.value?.getForm?.() ??
    form.value) as typeof form.value;
  if (editingId.value === null) {
    if (!values.password) {
      LewMessage.error('请输入密码');
      return;
    }
    if (values.password.length < 12) {
      LewMessage.error('密码最少 12 位');
      return;
    }
    await createUser({
      username: values.username,
      displayName: values.displayName,
      password: values.password,
      email: values.email || undefined,
      phone: values.phone || undefined,
      deptId: values.deptId || undefined,
      roleIds: values.roleIds ?? [],
    });
    LewMessage.success('创建成功');
  } else {
    await updateUser(editingId.value, {
      displayName: values.displayName,
      email: values.email || null,
      phone: values.phone || null,
      status: values.status ? 'active' : 'disabled',
      deptId: values.deptId ?? null,
      password: values.password || undefined,
      roleIds: values.roleIds ?? [],
    });
    LewMessage.success('更新成功');
  }
  modalVisible.value = false;
  void refresh();
}

// ---------- 删除 ----------
function handleDelete(row: User) {
  confirmDanger({
    title: '删除确认',
    content: `确定删除用户「${row.displayName}」吗？此操作不可恢复。`,
    onConfirm: async () => {
      await deleteUser(row.id);
      LewMessage.success('删除成功');
      void refresh();
    },
  });
}

// ---------- 可见门店（连锁直营） ----------
/**
 * 账号绑定了几家门店就只看得到这几家的单据（预约/收款/退款/应收）。
 *
 * 门店选项**先取后开弹窗**：lew-ui 的多选组件在 `setup` 时会把 `options` 快照进内部状态，
 * 选项晚于组件挂载到达时，回填的已选项一个都不显示（关掉重开又正常）——
 * 所以等选项就绪再打开弹窗（见 web-frontend 技能「常见坑」）。
 */
const storeModalVisible = ref(false);
const storeTarget = ref<User | null>(null);
/** 下拉是字符串（`LewSelectOption.value` 只收 string，与美甲师页的账号下拉同款），提交时转 number */
const storeOptions = ref<{ label: string; value: string }[]>([]);
const selectedStoreIds = ref<string[]>([]);
const storeSaving = ref(false);

async function ensureStoreOptions() {
  if (storeOptions.value.length) return;
  const data = await listStores(1, 200);
  storeOptions.value = data.items.map((store) => ({
    label: store.isDefault ? `${store.name}（默认）` : store.name,
    value: String(store.id),
  }));
}

async function openStores(row: User) {
  await ensureStoreOptions();
  storeTarget.value = row;
  const data = await getUserStores(row.id);
  selectedStoreIds.value = data.storeIds.map(String);
  storeModalVisible.value = true;
}

async function submitStores() {
  const target = storeTarget.value;
  if (!target || storeSaving.value) return;
  storeSaving.value = true;
  try {
    await setUserStores(target.id, selectedStoreIds.value.map(Number));
    LewMessage.success(
      selectedStoreIds.value.length
        ? '门店授权已更新'
        : '已取消全部门店授权（该账号将看不到业务数据）',
    );
    storeModalVisible.value = false;
    void refresh();
  } finally {
    storeSaving.value = false;
  }
}
</script>

<template>
  <div class="page-container">
    <!-- 页头 -->    <div class="flex items-center justify-between">
      <div>
        <h2 class="page-title m-0">用户管理</h2>
        <p class="page-subtitle mt-1 mb-0">管理系统用户账号</p>
      </div>
      <LewButton
        v-permission="'system:user:create'"
        type="fill"
        @click="openCreate"
      >
        <Plus :size="15" style="margin-right: 4px" /> 新增用户
      </LewButton>
    </div>

    <!-- 搜索栏 -->
    <div class="app-card flex items-center gap-3 p-4">
      <LewSelect
        v-model="query.status"
        width="140px"
        :options="statusFilters"
        placeholder="全部状态"
        clearable
      />
      <LewSelect
        v-model="query.deptId"
        width="220px"
        :options="deptFilterOptions"
        placeholder="全部部门"
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
        :focusable="false"
        :data-source="items"
        :loading="loading"
        size="small"
      >
        <template #operation="{ row }">
          <div class="flex items-center gap-1">
            <IconButton
              permission="system:user:store"
              title="设置可见门店"
              @click="openStores(row as unknown as User)"
            >
              <StoreIcon :size="14" />
            </IconButton>
            <IconButton
              permission="system:user:update"
              title="编辑"
              @click="openEdit(row as unknown as User)"
            >
              <Pencil :size="14" />
            </IconButton>
            <IconButton
              permission="system:user:delete"
              color="error"
              title="删除"
              @click="handleDelete(row as unknown as User)"
            >
              <Trash2 :size="14" />
            </IconButton>
          </div>
        </template>
      </LewTable>

      <!-- 分页 -->
      <div class="flex justify-end p-3">
        <LewPagination
          v-model:current-page="currentPage"
          v-model:page-size="pageSize"
          :total="total"
          @change="handleChange"
        />
      </div>
    </div>

    <!-- 新增/编辑弹窗 -->
    <LewModal
      v-model:visible="modalVisible"
      :title="editingId === null ? '新增用户' : '编辑用户'"
      width="480px"
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
            text: editingId === null ? '创建' : '保存',
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
          :options="formOptions"
          label-width="72px"
        />
      </div>
    </LewModal>

    <!-- 可见门店授权（连锁直营） -->
    <LewModal
      v-model:visible="storeModalVisible"
      :title="`设置可见门店：${storeTarget?.displayName ?? ''}`"
      width="520px"
      :footer-buttons="[
        {
          props: {
            type: 'text',
            color: 'gray',
            size: 'small',
            text: '取消',
            request: () => {
              storeModalVisible = false;
            },
          },
        },
        {
          props: {
            type: 'fill',
            color: 'primary',
            size: 'small',
            text: '保存',
            loading: storeSaving,
            request: submitStores,
          },
        },
      ]"
    >
      <div class="p-5">
        <p class="hint mb-3 mt-0">
          绑定几家门店，该账号就只看得到这几家的单据（预约 / 收款 / 退款 / 应收）。
          <b>不选 = 看不到任何业务数据</b>；超管不受此限制。
        </p>
        <LewSelect
          v-model="selectedStoreIds"
          multiple
          clearable
          placeholder="选择可见门店"
          :options="storeOptions"
        />
      </div>
    </LewModal>
  </div>
</template>

<style scoped>
.hint {
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--lew-text-color-3);
}
</style>
