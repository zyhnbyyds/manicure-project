import type { Component } from 'vue';
import {
  Activity,
  Bot,
  Clock,
  Code2,
  FileText,
  FolderCog,
  Gauge,
  Home,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  Monitor,
  Settings,
  Shield,
  SlidersHorizontal,
  Tags,
  Ticket,
  UserCog,
  Users,
  Building2,
  Briefcase,
  Database,
  Server,
  LogIn,
  ScrollText,
  UserCheck,
  HardDrive,
} from 'lucide-vue-next';

/**
 * 菜单图标映射：后端菜单 icon 字段 → lucide 图标组件
 * 未匹配时返回默认图标
 */
const ICON_MAP: Record<string, Component> = {
  home: Home,
  dashboard: LayoutDashboard,
  setting: Settings,
  system: Settings,
  monitor: Monitor,
  clock: Clock,
  file: FileText,
  code: Code2,
  user: Users,
  role: Shield,
  menu: ListChecks,
  dept: Building2,
  post: Briefcase,
  dict: Tags,
  config: SlidersHorizontal,
  loginlog: LogIn,
  operlog: ScrollText,
  online: UserCheck,
  cache: Database,
  job: Clock,
  files: HardDrive,
  generator: Code2,
  profile: UserCog,
  key: KeyRound,
  gauge: Gauge,
  server: Server,
  activity: Activity,
  folder: FolderCog,
  // 下面两个是 seed/menus.ts 里实际用到、但一度漏配的图标：
  // 漏配不会报错，只会静默回落到 DEFAULT_ICON（Activity）——
  // 「优惠券模板」和 AI 入口因此跟别的菜单长得一模一样，属于很难发现的一类 bug。
  coupon: Ticket,
  bot: Bot,
};

const DEFAULT_ICON: Component = Activity;

export interface MenuIconOption {
  key: string;
  component: Component;
}

/** 菜单图标可选列表（供菜单管理页图标选择器展示），顺序即展示顺序 */
export const MENU_ICON_OPTIONS: MenuIconOption[] = Object.entries(ICON_MAP).map(
  ([key, component]) => ({ key, component }),
);

/** 根据菜单 icon 字段解析图标组件 */
export function resolveMenuIcon(icon: string | null | undefined): Component {
  if (!icon) return DEFAULT_ICON;
  return ICON_MAP[icon.toLowerCase()] ?? DEFAULT_ICON;
}
