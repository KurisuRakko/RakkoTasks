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

/** 单个提醒时刻（reminders 表一行） */
export interface Reminder {
  id: number;
  /** ISO 8601 带 UTC 偏移（后端存 naive UTC，序列化时补 +00:00）；渲染按浏览器本地时区 */
  remind_at: string;
}

/** 每个条目最多几个提醒（与后端 itemrules.REMINDERS_MAX 一致） */
export const REMINDERS_MAX = 5;

/** 没指定时刻时的默认提醒小时（本地时间，与后端 DEFAULT_REMIND_HOUR 一致） */
export const DEFAULT_REMIND_HOUR = 10;

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
  /** 提醒时刻，按时间升序；与 due_date 是两件事（截止 vs 敲人） */
  reminders: Reminder[];
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

/** 账户卡片数据（/api/status 与 /api/accounts* 共用同一序列化，accounts 表） */
export interface AccountInfo {
  id: number;
  name: string;
  kind: AccountKind;
  email: string;
  status: AccountStatusValue;
  /** false 表示已停用，不再同步 */
  enabled: boolean;
  /** Gmail 已存应用专用密码 / 微软已拿到 token：响应永远不含凭据本体，只有这个布尔 */
  has_credentials: boolean;
  /** 微软账户的自定义 OAuth client_id（默认 Thunderbird 公共客户端时为 null） */
  ms_client_id: string | null;
  last_sync_at: string | null;
  last_error: string | null;
}

/** POST /api/accounts 请求体：kind=gmail 时 app_password 必填，microsoft 忽略该字段 */
export interface AccountCreate {
  name: string;
  kind: AccountKind;
  email: string;
  app_password?: string;
  ms_client_id?: string;
}

/** PATCH /api/accounts/{id} 请求体：app_password 只对 gmail 开放 */
export interface AccountPatch {
  name?: string;
  app_password?: string;
  enabled?: boolean;
}

/** 微软授权失败细分（POST auth-code 的 auth_failed 附带的 kind） */
export type AuthFailedKind = 'expired' | 'declined' | 'admin_required' | 'other';

/** GET /api/accounts 返回体（信封） */
export interface AccountsResponse {
  accounts: AccountInfo[];
}

/** GET /api/status 返回体 */
export interface StatusResponse {
  accounts: AccountInfo[];
  pending_llm: number;
}

/** 同步轮次的触发来源：manual = 用户点刷新，scheduled = 后台定时 */
export type SyncTrigger = 'manual' | 'scheduled';

/** 轮次 / 阶段的进行状态 */
export type SyncState = 'running' | 'done' | 'failed';

/** 阶段状态；pending = 前一阶段还没轮到它 */
export type SyncStageState = 'pending' | 'running' | 'done' | 'failed';

/** 单个邮箱在拉取阶段的状态；skipped = 账户没凭据，本轮跳过 */
export type SyncAccountState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/** 拉取阶段里每个邮箱的进度 */
export interface SyncAccountProgress {
  email: string;
  state: SyncAccountState;
  /** 本轮该邮箱新入库的邮件数 */
  new_count: number;
  error: string | null;
}

/** 阶段通用部分：state + 一句话错误（单封失败不中断阶段，只在收尾时汇总进 error） */
export interface SyncStage {
  state: SyncStageState;
  error: string | null;
}

/** 一轮同步的三个阶段（后端 Run 的 stages 字段） */
export interface SyncStages {
  fetch: SyncStage & { accounts: SyncAccountProgress[] };
  classify: SyncStage & { total: number; done: number; created: number };
  detail: SyncStage & { total: number; done: number };
}

/** 一轮同步（Run）；error 只在整轮自身抛异常时非空 */
export interface SyncRun {
  id: number;
  trigger: SyncTrigger;
  state: SyncState;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  stages: SyncStages;
}

/** GET /api/sync/status 返回体：current = 进行中，last = 最近一轮已结束（都没有为 null） */
export interface SyncStatus {
  current: SyncRun | null;
  last: SyncRun | null;
  /** 已有唤醒请求但 worker 尚未开始（点了刷新、worker 还没醒） */
  pending_request: boolean;
}

/** POST /api/sync/trigger 返回体；已有一轮在跑时不重复写请求，already_running 为 true */
export interface SyncTriggerResponse {
  accepted: boolean;
  already_running: boolean;
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
  /**
   * AI 解析出的重要度；省略时后端落 normal。界面上没有编辑控件，
   * 只用于把 AI 的判断从预览阶段透传到保存请求，避免两种模式行为不一致。
   */
  importance?: Importance;
  /** AI 解析出的「是否要亲自动手」；省略时后端落 true。同样只透传不编辑。 */
  actionable?: boolean;
  /**
   * 提醒时刻，**带 UTC 偏移的完整 ISO 8601**（如 "2026-09-08T10:00:00+10:00"）。
   * 后端拒收不带偏移的串——没有偏移它就不知道你在哪个时区。省略 = 不改；
   * 传 [] = 清空全部提醒。
   */
  reminders?: string[];
}

/**
 * POST /api/items/parse 的**单条**解析结果。一段话可能说了好几件事，
 * 端点返回的是 ParseResponse（tasks 数组），这里是数组里的一项。
 * 字段语义与 ItemFields 一致，但这里全部必填——它是 AI 的完整判断，
 * 由前端决定是原样保存还是让用户改过再存。
 */
export interface ParsedTask {
  title: string;
  summary: string;
  category: Category;
  /** YYYY-MM-DD 或 null（AI 判定用户没提时间，不替他猜） */
  due_date: string | null;
  importance: Importance;
  actionable: boolean;
  /**
   * AI 解析出的提醒时刻，带 UTC 偏移的 ISO 8601。模型产出的是本地墙上时刻
   * （它不知道偏移），后端用请求里的 tz 换算好才返回，所以前端拿到的已是绝对时刻，
   * 可以直接塞进 ItemFields.reminders。
   */
  reminders: string[];
}

/**
 * POST /api/items/parse 返回体。信封而不是裸数组，与 GET /api/items 的
 * `{items:[...]}` 同款；只说了一件事时也是一元数组。
 */
export interface ParseResponse {
  tasks: ParsedTask[];
}

/** POST /api/items/quick 返回体：解析并落库；解析失败时后端用原文兜底建条目 */
export interface QuickAddResponse {
  /** 一段话说了几件事就有几条；兜底路径固定一条 */
  items: Item[];
  /** false = AI 解析失败，items 是按原文兜底建出来的那一条 */
  ai_parsed: boolean;
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
