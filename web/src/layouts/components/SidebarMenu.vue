<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { LewMenu } from 'lew-ui';
import type { LewMenuOption } from 'lew-ui';
import type { SidebarItem } from '~/types/app';
import { resolveMenuIcon } from '~/utils/menu-icon';

const props = defineProps<{
  items: SidebarItem[];
  collapsed: boolean;
}>();

const route = useRoute();
const router = useRouter();

/** 当前选中菜单 value（路由路径） */
const activeValue = computed(() => route.path);

/** SidebarItem[] → LewMenuOption[]（分组标题 + 子菜单项） */
const menuOptions = computed<LewMenuOption[]>(() =>
  props.items.map((item) => ({
    label: item.label,
    children: (item.children?.length ? item.children : [item]).map((child) => ({
      label: child.label,
      value: child.path,
      icon: () => h(resolveMenuIcon(child.icon), { size: 14 }),
    })),
  })),
);

/** 折叠态：仅图标按钮列表 */
const collapsedItems = computed(() =>
  props.items.flatMap((item) =>
    item.children?.length ? item.children : [item],
  ),
);

function handleChange(item: LewMenuOption) {
  if (item.value) router.push(item.value);
}

function go(path: string) {
  router.push(path);
}
</script>

<template>
  <!-- 展开态：使用 lew-ui LewMenu 组件 -->
  <nav v-if="!collapsed" class="flex-1 overflow-y-auto p-2">
    <LewMenu
      :options="menuOptions"
      :model-value="activeValue"
      @change="handleChange"
    />
  </nav>

  <!--
    折叠态：仅图标。

    ⚠️ `shrink-0` **不能删**。nav 是 `flex flex-col`，而 flex 子项默认 `flex-shrink: 1`：
    菜单有 40 多个，每个 36px 高 + 4px gap 需要 1600px 上下，一屏装不下时浏览器会把
    每个按钮**压扁**（实测 36px 被压到 ~23px，间距只剩 ~28px），于是整条侧栏变成一条
    挤在一起、看不清的「图标条」—— 表现为「折叠菜单展示有问题」。
    加上 `shrink-0` 后按钮保持 36px，超出的部分交给 `overflow-y-auto` 滚动。
    注意 `overflow-y-auto` **不能**阻止 flex 收缩，两者解决的是不同问题。
  -->
  <nav
    v-else
    class="flex-1 overflow-y-auto p-2 flex flex-col items-center gap-1"
  >
    <button
      v-for="item in collapsedItems"
      :key="item.key"
      class="icon-btn shrink-0 !w-36px !h-36px"
      :class="{
        '!bg-[var(--lew-color-primary-light)] !text-[var(--lew-color-primary)]':
          activeValue === item.path,
      }"
      :title="item.label"
      @click="go(item.path)"
    >
      <component :is="resolveMenuIcon(item.icon)" :size="14" />
    </button>
  </nav>
</template>
