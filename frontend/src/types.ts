// 与 docs/DESIGN.md 第 5/6 节数据模型与 REST API 契约一致的 API 类型。

/** 条目状态 */
export type ItemStatus = 'open' | 'done';

/** GET /api/items 返回体（信封） */
export interface ItemsResponse {
  items: Item[];
}

/** 条目分类（LLM 四分类 + 兜底） */
export type Category = '学业' | '工作' | '个人' | '账单' | '其他';

/** 可选分类常量（编辑器与筛选共用同一份） */
export const CATEGORIES: readonly Category[] = ['学业', '工作', '个人', '账单', '其他'];

/** 条目重要度（与 due_date 无关；high 无日期也不沉底） */
export type Importance = 'high' | 'normal' | 'low';

/** 条目（items 表） */
export interface Item {
  id: number;
  /** 源邮件 id；null = 手动创建的条目（无源邮件） */
  email_id: number | null;
  /** 源邮件发送时间（ISO 8601，带 UTC 偏移）；邮件无 Date 头时为 null */
  email_sent_at: string | null;
  title: string;
  summary: string | null;
  category: Category;
  /** YYYY-MM-DD 或 null（无截止日期） */
  due_date: string | null;
  importance: Importance;
  actionable: boolean;
  status: ItemStatus;
  /** AI 生成详情，懒生成，可能为 null */
  detail_md: string | null;
  /** AI 详情生成时检索到的关联邮件（可为空数组） */
  related: RelatedEmail[];
  created_at: string;
  done_at: string | null;
}

/** 邮件（emails 表；html 为服务端 nh3 消毒后的 sanitized_html） */
export interface Email {
  id: number;
  account_id: number;
  subject: string;
  sender: string | null;
  recipients: string | null;
  sent_at: string | null;
  text_body: string | null;
  html: string | null;
}

/** AI 详情生成时检索到的关联邮件 */
export interface RelatedEmail {
  email_id: number;
  subject: string;
  sender: string | null;
  sent_at: string | null;
  reason: string;
}

/** 账户类型 */
export type AccountKind = 'gmail' | 'microsoft';

/** 账户状态 */
export type AccountStatusValue = 'ok' | 'error' | 'pending';

/** 状态页账户卡片数据（accounts 表） */
export interface AccountInfo {
  id: number;
  name: string;
  kind: AccountKind;
  email: string;
  status: AccountStatusValue;
  /** false 表示已被 CLI 停用，不再同步 */
  enabled: boolean;
  last_sync_at: string | null;
  last_error: string | null;
}

/** GET /api/status 返回体 */
export interface StatusResponse {
  accounts: AccountInfo[];
  pending_llm: number;
}

/** AI 搜索引用的一封邮件 */
export interface SearchCitation {
  email_id: number;
  subject: string;
  sent_at: string | null;
}

/** POST /api/search 返回体 */
export interface SearchResponse {
  answer_md: string;
  citations: SearchCitation[];
}

/** 手动条目可编辑字段（POST /api/items 请求体；PATCH 时各字段可选） */
export interface ItemFields {
  title: string;
  summary: string;
  category: Category;
  due_date: string | null;
}

/** GET /api/calendar、POST /api/calendar/rotate 返回体 */
export interface CalendarTokenResponse {
  token: string;
}

/** GET /api/caldav 返回体：iPhone 提醒事项经 CalDAV 同步所需的连接信息 */
export interface CaldavInfo {
  username: string;
  /** CalDAV 根路径，固定 "/caldav/" */
  path: string;
  /** 是否已生成过同步密码 */
  configured: boolean;
}

/** Phainon /me 返回体 */
export interface PhainonMe {
  app_id: string;
  user: {
    sub: string;
    email?: string;
    name?: string;
  };
}
