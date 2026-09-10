import request, { get } from '~/request';

/** 报表页签（对应 6 个只读接口，§9.11） */
export type ReportTabKey =
  | 'overview'
  | 'revenue'
  | 'services'
  | 'staffs'
  | 'members'
  | 'receivables';

/** 营收页签粒度（仅 `/biz/reports/revenue` 支持） */
export type ReportGranularity = 'day' | 'week' | 'month';

/** 页头统一口径提示（§10.5 硬性要求） */
export const REVENUE_CAVEAT = '营收 = 实收，已扣退款';

export const REPORT_TABS: { key: ReportTabKey; label: string }[] = [
  { key: 'overview', label: '概览' },
  { key: 'revenue', label: '营收' },
  { key: 'services', label: '项目' },
  { key: 'staffs', label: '美甲师' },
  { key: 'members', label: '会员' },
  { key: 'receivables', label: '应收' },
];

/** 各页签对应的后端路径 */
export const REPORT_ENDPOINTS: Record<ReportTabKey, string> = {
  overview: '/biz/reports/overview',
  revenue: '/biz/reports/revenue',
  services: '/biz/reports/services',
  staffs: '/biz/reports/staffs',
  members: '/biz/reports/members',
  receivables: '/biz/reports/receivables',
};

export interface ReportQuery {
  dateFrom: string;
  dateTo: string;
  /** 美甲师维度（可选） */
  staffId?: number | string;
  /** 渠道维度（可选） */
  channel?: string;
  /** 仅营收页签使用 */
  granularity?: ReportGranularity;
}

/**
 * 报表响应字段未在接口冻结文档中逐字约定（spec §20.2 只固定口径），
 * 因此用宽松类型承接，配合 `reportNumber` / `reportText` 做 camelCase / snake_case 容错读取。
 */
export type ReportPayload = Record<string, unknown> | Record<string, unknown>[];

/** 拉取某个页签的报表数据 */
export function getReport(tab: ReportTabKey, query: ReportQuery) {
  return get<ReportPayload>(REPORT_ENDPOINTS[tab], { ...query });
}

/** 从宽松响应里按多个候选键读取数字 */
export function reportNumber(
  row: Record<string, unknown>,
  ...keys: string[]
): number {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

/** 从宽松响应里按多个候选键读取文本 */
export function reportText(
  row: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = row[key];
    if (value !== null && value !== undefined && value !== '') {
      return String(value);
    }
  }
  return '-';
}

/** 把宽松响应归一成表格行：数组直接用；对象里第一个数组字段作为行集；否则整体当一行 */
export function reportRows(
  payload: ReportPayload | null,
): Record<string, unknown>[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  for (const value of Object.values(payload)) {
    if (Array.isArray(value)) return value as Record<string, unknown>[];
  }
  return [payload];
}

/** 把宽松响应归一成概览键值对：数组返回 null；对象取其中非数组/非对象的标量字段 */
export function reportScalars(
  payload: ReportPayload | null,
): Record<string, unknown> | null {
  if (!payload || Array.isArray(payload)) return null;
  const scalars: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (Array.isArray(value)) continue;
    if (value !== null && typeof value === 'object') continue;
    scalars[key] = value;
  }
  return Object.keys(scalars).length ? scalars : null;
}

/**
 * 导出报表 CSV。
 *
 * `GET /biz/reports/export` 需要一个带 Bearer token 的请求，而 `window.open` 无法附带
 * Authorization 头（会 401），因此这里走 axios（`~/request` 已注入 token）拿 blob 再本地下载。
 *
 * TODO(export-fallback): 若后端改为返回「文件 id / 下载地址」而不是文件流，可退化为
 * `window.open(downloadUrl)`；同源裸链接不带 token 会被 401 拒绝，届时需后端提供一次性
 * 签名 URL（或先调接口换 downloadToken 再拼到 URL 上）。当前实现不做无 token 的降级。
 */
export async function exportReport(query: {
  type: ReportTabKey;
  dateFrom: string;
  dateTo: string;
  format?: 'csv' | 'excel';
  staffId?: number | string;
  channel?: string;
  granularity?: ReportGranularity;
}) {
  const response = await request.get<Blob>('/biz/reports/export', {
    params: { format: 'csv', ...query },
    responseType: 'blob',
    timeout: 60000,
  });
  const disposition = String(
    (response.headers as Record<string, unknown>)['content-disposition'] ?? '',
  );
  const matched = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const fallback = `report-${query.type}-${query.dateFrom}_${query.dateTo}.csv`;
  const filename = matched?.[1] ? decodeURIComponent(matched[1]) : fallback;

  const url = URL.createObjectURL(response.data);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return filename;
}
