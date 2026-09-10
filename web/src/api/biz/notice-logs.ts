import type { PageResult } from '~/types/api';
import { get, post } from '~/request';

/** 实际发送渠道（sms 短信 / site 站内） */
export type NoticeLogChannel = 'sms' | 'site';
export type NoticeLogStatus = 'pending' | 'success' | 'failed' | 'skipped';
export type NoticeRecipientType = 'customer' | 'user';

/** 通知发送日志（`sys_notice_log`，只追加；保存渲染后的最终内容） */
export interface NoticeLog {
  id: number;
  templateCode: string;
  channel: NoticeLogChannel;
  recipientType: NoticeRecipientType;
  recipientId: number;
  phone: string | null;
  title: string | null;
  /** 渲染后的最终内容 */
  content: string;
  status: NoticeLogStatus;
  provider: string | null;
  providerMsgId: string | null;
  error: string | null;
  retryCount: number;
  sentAt: string | null;
  readAt: string | null;
  bookingId: number | null;
  createdAt: string;
}

/** 列表查询（用 type 而非 interface：对象字面量类型才能满足 request 的 Record 约束） */
export type NoticeLogListQuery = {
  channel?: NoticeLogChannel | '';
  status?: NoticeLogStatus | '';
  templateCode?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
};

/** 发送记录列表（分页） */
export function listNoticeLogs(params: NoticeLogListQuery = {}) {
  return get<PageResult<NoticeLog>>('/biz/notice-logs', params);
}

/** 发送记录详情（渲染后内容 + 供应商消息号 + 错误） */
export function getNoticeLog(id: number) {
  return get<NoticeLog>(`/biz/notice-logs/${id}`);
}

/** 重发单条（权限 biz:notice:send） */
export function resendNoticeLog(id: number) {
  return post<void>(`/biz/notice-logs/${id}/resend`);
}
