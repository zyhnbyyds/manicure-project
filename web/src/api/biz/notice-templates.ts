import type { PageResult } from '~/types/api';
import { del, get, patch, post } from '~/request';

/** 模板渠道：sms 短信 / site 站内 / both 两者 */
export type NoticeChannel = 'sms' | 'site' | 'both';
export type NoticeTemplateStatus = 'active' | 'disabled';

/** 通知模板（`sys_notice_template`）：content 支持 `{变量}`，保存时校验变量都已声明 */
export interface NoticeTemplate {
  id: number;
  code: string;
  name: string;
  channel: NoticeChannel;
  title: string | null;
  content: string;
  /** 已声明的变量清单（json 字符串数组，不含花括号） */
  variables: string[] | null;
  status: NoticeTemplateStatus;
  remark: string | null;
  createdAt: string;
}

/** 列表查询（用 type 而非 interface：对象字面量类型才能满足 request 的 Record 约束） */
export type NoticeTemplateListQuery = {
  keyword?: string;
  channel?: NoticeChannel | '';
  status?: NoticeTemplateStatus | '';
  page?: number;
  pageSize?: number;
};

export interface NoticeTemplateBody {
  code: string;
  name: string;
  channel: NoticeChannel;
  title?: string | null;
  content: string;
  /** 声明变量（不含花括号） */
  variables: string[];
  status: NoticeTemplateStatus;
  remark?: string | null;
}

/** 模板列表（分页） */
export function listNoticeTemplates(params: NoticeTemplateListQuery = {}) {
  return get<PageResult<NoticeTemplate>>('/biz/notice-templates', params);
}

/** 新增模板（后端同样校验变量声明） */
export function createNoticeTemplate(body: NoticeTemplateBody) {
  return post<{ id: number }>('/biz/notice-templates', body);
}

/** 修改模板 */
export function updateNoticeTemplate(
  id: number,
  body: Partial<NoticeTemplateBody>,
) {
  return patch<void>(`/biz/notice-templates/${id}`, body);
}

/** 软删（历史日志保留） */
export function deleteNoticeTemplate(id: number) {
  return del<void>(`/biz/notice-templates/${id}`);
}

/* ---------------- 变量工具（页面校验与「插入变量」共用） ---------------- */

/** 「插入变量」按钮提供的常用变量 */
export const NOTICE_VARIABLE_PRESETS: { value: string; label: string }[] = [
  { value: 'customerName', label: '顾客姓名' },
  { value: 'customerPhone', label: '顾客手机号' },
  { value: 'bookingNo', label: '预约单号' },
  { value: 'bookingTime', label: '预约时间' },
  { value: 'staffName', label: '美甲师' },
  { value: 'serviceItems', label: '服务项目' },
  { value: 'amount', label: '金额' },
  { value: 'points', label: '积分' },
  { value: 'cardName', label: '次卡名称' },
  { value: 'expireDate', label: '到期日' },
  { value: 'dueDate', label: '应收到期日' },
  { value: 'receivableNo', label: '应收单号' },
  { value: 'shopName', label: '门店名称' },
  { value: 'shopPhone', label: '门店电话' },
];

const VARIABLE_PATTERN = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

/** 抽取文本里用到的 `{变量}` 名（去重，保持出现顺序） */
export function extractTemplateVariables(
  ...texts: (string | null | undefined)[]
) {
  const found: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    VARIABLE_PATTERN.lastIndex = 0;
    let matched = VARIABLE_PATTERN.exec(text);
    while (matched) {
      const name = matched[1];
      if (name && !found.includes(name)) found.push(name);
      matched = VARIABLE_PATTERN.exec(text);
    }
  }
  return found;
}

/** 内容里用到但清单里未声明的变量（非空即阻止提交） */
export function findUndeclaredVariables(
  declared: string[],
  ...texts: (string | null | undefined)[]
) {
  const used = extractTemplateVariables(...texts);
  return used.filter((name) => !declared.includes(name));
}

/** 把内容里的 `{var}` 渲染成示例值（模板预览用，不参与提交） */
export function renderTemplatePreview(
  text: string | null | undefined,
  variables: string[],
) {
  if (!text) return '';
  return text.replace(VARIABLE_PATTERN, (raw, name: string) =>
    variables.includes(name) ? `【${name}】` : raw,
  );
}
