# RakkoTasks 设计文档

邮件驱动的个人 To-Do 系统：定时从四个邮箱增量拉取邮件，由 LLM 过滤噪音、生成中文摘要任务，
手机网页查看、勾选、AI 全库问答检索。本文档是唯一权威设计，执行任务书从这里引用决策。

## 1. 总体架构

```
┌ Debian 12 服务器（Docker Compose）─────────────────────────┐
│  worker    每 15 分钟：IMAP 增量拉取 → LLM 过滤/摘要 → SQLite │
│  web       FastAPI：REST API + 托管前端静态文件               │
│  cloudflared  Tunnel → https://tasks.rakko.cn（DNS 暂不配）   │
│  volume    ./data/rakkotasks.db（SQLite, WAL）               │
└─────────────────────────────────────────────────────────────┘
鉴权：Phainon（api.rakko.cn）。前端走 SPA login_code 流程；
后端对每个 Bearer token 调 /auth/priestess/oidc/me introspect（60s 缓存）。
```

单体仓库布局：

```
backend/    Python 3.12 + FastAPI + SQLAlchemy 2 + SQLite
frontend/   React 19 + TypeScript + Vite + MUI（MD2 风格）+ PWA
deploy/     Dockerfile、docker-compose.yml、cloudflared 说明、.env.example
docs/       本文档等
```

## 2. 邮箱接入（四个账户）

| 账户 | 协议 | 认证 |
|---|---|---|
| UNSW 学校邮箱 | IMAP `outlook.office365.com:993` | OAuth2 device code + XOAUTH2 |
| 个人 Outlook | 同上 | 同上（微软已关闭个人账户密码式 IMAP） |
| 公司 Outlook | 同上 | 同上 |
| Gmail | IMAP `imap.gmail.com:993` | 应用专用密码（存库，CLI 交互式录入） |

- Microsoft OAuth：msal `PublicClientApplication`，authority `https://login.microsoftonline.com/common`，
  scope `https://outlook.office365.com/IMAP.AccessAsUser.All`（msal 自动附带 offline_access）。
  client_id 每账户可配，默认 `d3590ed6-52b3-4102-aeff-aad2292ab01c`（微软 Office 官方公共客户端，
  UNSW 官方文档认可）。msal 的 SerializableTokenCache 按账户序列化存入 DB。
- 首次登录：CLI 触发 device code flow，终端打印 URL + 代码，人工在任意浏览器完成 MFA。
- refresh token 失效：账户状态置 error，页面状态区显示，等待人工重跑 CLI。不做主动通知。
- 账户由 CLI 管理：`add` / `connect` / `list` / `remove`，每个账户归属某个用户
  （`--user <sub|邮箱>`）。Gmail 应用专用密码在 CLI 交互式录入（getpass，不回显、
  不进 shell history），明文存库、永不经 API 返回；不再走环境变量。

## 3. 同步策略

- worker 常驻进程，每 `SYNC_INTERVAL_MINUTES`（默认 15）跑一轮，账户串行处理，单账户异常不影响其余。
- 只同步 INBOX。增量游标：每账户存 `uidvalidity` + `last_uid`；UIDVALIDITY 变化则重置游标全量回补。
- 首次回补 `INITIAL_BACKFILL_DAYS`（默认 180）天。
- 去重键 `(account_id, message_id)`；无 Message-ID 的邮件用内容哈希替代。
- 解析：标准库 `email`，取 subject/from/to/date、text/plain 与 text/html 正文；附件只记文件名列表，不存内容。

## 4. LLM 管线（OpenAI-compatible）

env：`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_REASONING_EFFORT`（DeepSeek 官方 API，openai SDK 调用）。
所有面向用户的输出一律中文。

### 4.1 入库处理（每封新邮件一次调用）

输出 JSON：

```json
{"filtered": false, "filter_reason": null,
 "title": "≤30字任务标题", "summary": "1-2句摘要",
 "category": "学业|工作|个人|账单|其他",
 "due_date": "2026-08-30 或 null", "actionable": true}
```

- `filtered=true` 的情形：纯广告/营销/newsletter；标题党（如标题喊 critical alert 而正文无实事）。
  被过滤邮件不生成条目，但邮件本体仍入库、仍可被 AI 搜索读到。
- 不可行动的通知类邮件也生成条目（actionable=false，无截止日期），便于「看过就勾掉」。
- LLM 返回非法 JSON 时重试一次，仍失败则该邮件标记 `llm_error`，下轮重试，不阻塞队列。

### 4.2 详情（懒生成）

用户首次点开条目时生成：基于邮件全文写中文详情，剔除客套话、签名档、免责声明、无关信息，
保留关键事实/时间/链接/要求的动作。生成后缓存于 DB，再次打开直接读缓存。

### 4.3 AI 搜索（全库问答）

`POST /api/search {question}` → agentic 循环（上限 15 轮工具调用，总超时 180s）：

- 系统提示（中文）：给出今天日期、账户列表，要求回答引用邮件。
- 首条消息附「邮件索引」：最近 `SEARCH_INDEX_DAYS`（默认 90）天所有邮件的
  `id / 日期 / 发件人 / 主题` 紧凑列表（不吝惜 token，用户明确要求喂足）。
- 工具：`search_emails(keywords, sender, date_from, date_to, account, limit)`（FTS5 全文检索，
  跨全部历史，不限 90 天）；`read_emails(ids)`（返回全文，单次上限 20 封）。
- 最终输出 JSON `{"answer_md": "...", "citations": [email_id, ...]}`。
  前端把 citations 渲染为可点击邮件引用。

## 5. 数据模型（SQLite，WAL）

```
users(sub, email, name, created_at, last_seen_at)
accounts(id, user_sub→users, name, kind gmail|microsoft, email, ms_client_id,
         app_password, enabled, token_cache, uidvalidity, last_uid,
         last_sync_at, last_error, status ok|error|pending)
         user_sub 建索引（按用户过滤/级联）
emails(id, account_id→accounts, message_id, subject, sender, recipients, sent_at,
       text_body, html_body, attachments_json, fetched_at,
       filtered bool, filter_reason, llm_state pending|done|error)
       UNIQUE(account_id, message_id)；FTS5 虚表 emails_fts(subject, sender, text_body) 由触发器同步
items(id, email_id→emails UNIQUE, title, summary, category, due_date date|null,
      actionable bool, status open|done, detail_md|null, created_at, done_at|null)
```

- `users`：登录 Phainon 的用户，首次访问自动创建（准入见第 6 节）。
- `accounts.app_password`：Gmail 应用专用密码，明文存库，任何 API 都不会返回它。
- `accounts.enabled`：软删除标记，CLI `accounts remove` 置 false（停用并清除凭据、
  不再同步），已抓取的邮件与已生成的任务保留。
- 多用户隔离：emails/items 的归属通过 `emails.account_id → accounts.user_sub` 推导，
  所有查询都以当前登录者 sub 过滤。

## 6. REST API（/api/*，除 /api/health 外全部 Bearer 鉴权）

```
GET  /api/health                    公开存活探针
GET  /api/items?status=&category=   条目列表（默认 open）
PATCH /api/items/{id}               {"status": "done"|"open"}
GET  /api/items/{id}                含 detail_md（可能为 null）
POST /api/items/{id}/detail         生成并缓存详情，返回 detail_md
GET  /api/emails/{id}               元数据 + text_body + sanitized_html
POST /api/search                    {"question"} → {"answer_md", "citations":[{email_id, subject, sent_at}]}
GET  /api/status                    各账户健康（含 enabled 停用标记）+ 上次同步时间 + LLM 待处理数
```

- **多用户隔离**：所有端点只返回当前登录者自己的邮箱账户、邮件与任务；访问他人
  资源的越权请求一律返回 404 而非 403，不暴露资源 id 是否存在。
- `/api/status` 的账户对象新增 `enabled: boolean`（CLI 停用后为 false，账户仍返回）；
  任何 API 响应都不含 `app_password` / `token_cache`。

鉴权中间件：取 Bearer → `GET {PHAINON_API_BASE}/auth/priestess/oidc/me`
（转发同一 Bearer，附 `Origin: {FRONTEND_ORIGIN}`）→ 200 且 `app_id == PHAINON_APP_ID`
即放行（无白名单）；首次访问自动创建用户记录；对 token 哈希做 60s 内存缓存；否则 401。

## 7. 原邮件展示（安全红线）

- 服务端 `nh3` 白名单消毒 HTML：允许结构/表格/图文标签与 style 属性；剥掉
  script/iframe/form/事件属性/javascript: URL。
- 前端 `<iframe sandbox="" referrerpolicy="no-referrer" srcdoc={...}>`——不加任何 allow-*。
- 消毒文档头部注入 CSP meta：默认 `default-src 'none'; style-src 'unsafe-inline'; img-src data: cid:`
  ——远程图片（追踪像素）默认全部拦截；用户点「显示远程图片」后以
  `img-src data: cid: https:` 变体重渲染。
- 无 HTML 正文时显示纯文本（`<pre>`）。

## 8. 前端（React 19 + MUI，MD2 风格，全中文）

- 登录：Phainon SPA 集成（`docs/integration.md` 范式），`APP_ID=rakkotasks`，
  `API_BASE=https://api.rakko.cn`；回跳域 `https://tasks.rakko.cn`。
- 主页：AppBar + 分类筛选 Chip（全部/学业/工作/个人/账单/其他）+ 按截止日期分组的列表：
  **今天**（含逾期，逾期红色高亮）/ **本周** / **无期限**（无日期或超出本周，带日期 Chip）。
  条目 Checkbox 勾选完成；「已完成」在底部折叠区。
- 条目详情（全屏 Dialog）：AI 详情（首开时生成，加载态）→ 底部「显示原邮件」展开 sandbox iframe
  → iframe 内「显示远程图片」开关。
- 搜索页：问题输入 → 回答（Markdown 渲染）+ 引用邮件列表，点击打开邮件查看器。
- 状态页：账户健康、上次同步、错误信息。
- PWA：vite-plugin-pwa，manifest 名称 RakkoTasks，可添加到主屏幕。
- 移动优先；MUI 默认主题即可，8dp 间距体系。

## 9. 部署

- 单一 Dockerfile 多阶段：node 构建 frontend → python 镜像装 backend 并携带 `frontend/dist`，
  FastAPI StaticFiles 托管（SPA fallback 到 index.html）。
- compose 服务：`web`（uvicorn :8000）、`worker`（`python -m app.worker`，同镜像）、
  `cloudflared`（`TUNNEL_TOKEN` env；DNS 与隧道由使用者后配）。`./data` 挂载给 web 与 worker。
- 全部配置走 env，提供 `.env.example`。邮箱凭据与用户白名单不再走 env：
  `GMAIL_APP_PASSWORD` / `ALLOWED_SUBS` 已删除，Gmail 应用专用密码由 CLI
  交互式录入存库，任何用户都可直接使用（无白名单）。

## 10. 非目标（v1 明确不做）

英文界面；手动添加/编辑任务；发件人静音规则；勾选回写邮箱已读；除 INBOX 外的文件夹；
附件下载；推送通知；网页端管理邮箱账户（只走 CLI）；用户审批流程。
