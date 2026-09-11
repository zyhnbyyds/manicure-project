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
import type { LewFormOption, LewTableColumn } from 'lew-ui';
import { withPassThroughRule } from '~/utils/form';
import {
  createStaff,
  deleteStaff,
  getStaffServiceItems,
  setStaffServiceItems,
  updateStaff,
} from '~/api/biz/staffs';
import type { CreateStaffBody, Staff } from '~/api/biz/staffs';
import { listActiveServiceItems } from '~/api/biz/service-items';
import { listUsers } from '~/api/system/users';
import { useTable } from '~/composables/useTable';
import { formatDateTime } from '~/composables/useFormat';
import type { EntityStatus } from '~/types/api';
import { useUserStore } from '~/store/user';
import { renderStatus } from '~/utils/render';
import { confirmDanger } from '~/utils/confirm';
import IconButton from '~/components/IconButton.vue';

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
      const avatar = (row as unknown as Staff).avatar;
      if (!avatar)
        return h('span', { class: 'text-[var(--app-text-muted)]' }, '-');
      return h('img', {
        src: avatar,
        alt: 'avatar',
        class: 'w-28px h-28px rounded-full object-cover',
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
      if (!text) return '-';
      return h(
        'span',
        { class: 'block w-full truncate align-middle', title: text },
        text,
      );
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
  avatar: string;
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
    avatar: '',
    phone: '',
    bio: '',
    userId: '',
    status: true,
    sort: 0,
    remark: '',
  };
}

const modalVisible = ref(false);
const editingId = ref<number | null>(null);
const formRef = ref();
const form = ref<FormValues>(emptyForm());
/** 表单 key：每次打开弹窗自增，强制重建 LewForm 以回填数据 */
const formKey = ref(0);

const formOptions = computed<LewFormOption[]>(() => withPassThroughRule([
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
    as: 'input',
    props: { placeholder: '选填，图片地址', clearable: true },
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
]));

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
      avatar: row.avatar ?? '',
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
    avatar: values.avatar || null,
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
const itemOptions = ref<{ label: string; value: string; disabled?: boolean }[]>(
  [],
);
const selectedItemIds = ref<string[]>([]);
const itemsLoading = ref(false);
/** 当前配置里已停用（保存会被后端拒绝）的项目名 */
const disabledSelected = computed(() => {
  const disabled = new Set(
    itemOptions.value
      .filter((option) => option.disabled)
      .map((option) => option.value),
  );
  return selectedItemIds.value.filter((id) => disabled.has(id));
});

async function loadServiceItemOptions() {
  const data = await listActiveServiceItems(200);
  itemOptions.value = data.items.map((item) => ({
    label: `${item.name}（${item.durationMinutes} 分钟）`,
    value: String(item.id),
  }));
}

async function openDetail(row: Staff) {
  detail.value = row;
  drawerVisible.value = true;
  itemsLoading.value = true;
  try {
    const [selected] = await Promise.all([
      getStaffServiceItems(row.id),
      loadServiceItemOptions(),
    ]);
    const known = new Map(
      itemOptions.value.map((option) => [option.value, option]),
    );
    // 已配置但已停用的项目：保留在选项里并标注，避免「保存后被静默丢弃」
    for (const ref0 of selected) {
      const key = String(ref0.id);
      if (!known.has(key)) {
        itemOptions.value = [
          ...itemOptions.value,
          { label: `${ref0.name}（已停用）`, value: key, disabled: true },
        ];
      }
    }
    selectedItemIds.value = selected.map((item) => String(item.id));
  } finally {
    itemsLoading.value = false;
  }
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
        <LewForm
          :key="formKey"
          ref="formRef"
          v-model="form"
          label-width="80px"
          :options="formOptions"
        />
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

          <LewSelect
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
      </div>
    </LewDrawer>
  </div>
</template>
