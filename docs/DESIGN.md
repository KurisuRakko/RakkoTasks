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
  scope `https://outlook.office.com/IMAP.AccessAsUser.All`（OAuth 资源域名是 outlook.office.com，与 IMAP 主机名 outlook.office365.com 不同；msal 自动附带 offline_access）。
  client_id 每账户可配，默认 `9e5f94bc-e8a4-4e73-b8be-63364c29d753`（Mozilla
  Thunderbird 注册的公共客户端，第三方应用，可用于 IMAP）。不要改回 Microsoft Office
  的 `d3590ed6-52b3-4102-aeff-aad2292ab01c`：那是第一方应用，访问第一方资源
  Exchange Online 必须经预授权，会报 `AADSTS65002`，拿不到 IMAP token。UNSW 官方
  文档里用到 d3590ed6 的是 Evolution 一节，配的是 EWS 而非 IMAP；其 Thunderbird
  一节用的正是它内置的客户端 ID。msal 的 SerializableTokenCache 按账户序列化存入 DB。
- 首次登录：CLI 触发 device code flow，终端打印 URL + 代码，人工在任意浏览器完成 MFA。
- refresh token 失效：账户状态置 error，页面状态区显示，等待人工重跑 CLI。不做主动通知。
- 账户由 CLI 管理：`add` / `connect` / `list` / `remove`，每个账户归属某个用户
  （`--user <sub|邮箱>`）。Gmail 应用专用密码在 CLI 交互式录入（getpass，不回显、
  不进 shell history），明文存库、永不经 API 返回；不再走环境变量。
- 过滤规则调整后重跑历史邮件：`reclassify --user <sub|邮箱> [--account <邮箱>] [--last N] [--yes]`
  删除目标邮件关联的任务并把 LLM 状态重置为 pending，worker 下一轮同步按新规则重新分类；
  加 `--last N` 时每个账户只处理最近 N 封邮件（按发送时间倒序，无发送时间的排最后），其余不动。
- 详情逻辑调整后重跑历史条目：`regen-details --user <sub|邮箱> [--account <邮箱>] [--yes]`
  把目标条目（可限账户）的 `detail_md` 与 `related_json` 置 NULL，worker 下一轮按最新详情逻辑重新生成。

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
 "due_date": "2026-08-30 或 null", "actionable": true,
 "importance": "high|normal|low"}
```

- 统一判定原则：这封邮件是否要求收件人在未来做一件**具体的、非可选**的事？是则建任务，否则过滤。
- 判定顺序：先判是否属于下面的「必须保留」情形，再判是否属于「必须过滤」四类，避免误伤。
- `filtered=true`（必须过滤）的四类：
  1. **回执/确认类**：告知「你做过的某件事已完成或已记录」，无任何后续动作。
     分辨依据：该回执是否构成**有后果的事**（成绩、金钱、身份/资格、法律责任）的凭证——
     构成凭证的按保留处理（见下），不构成凭证的过滤（图书馆座位/自习室预订确认、
     问卷/表单提交成功、验证码/安全提醒、欢迎邮件/账号创建成功、课程论坛/公告板的群发回复通知
     （如「某人回复了某帖」，只是告知有新动态、不含结论）、往来中纯流程性的回信
     （仅表示「已收到」「正在处理」「已转交」而没有结论））；
  2. **可选活动推广**：参加全凭自愿、不参加无后果（PASS 复习课/help session、编程竞赛、
     讲座/workshop、社团活动、招聘宣讲、问卷调查），即使学校官方发出、即使带报名截止日期仍算推广；
  3. 纯广告/营销/newsletter；
  4. 标题党：标题声称紧急而正文无实际待办。
- `filtered=false`（必须保留）的情形——即使带「确认」字样也保留：有硬性截止的学业/工作事项
  （作业、测验、考试、缴费、选课、账单）；明确要求动作或决定（「请确认并转发」「需补充材料」）；
  申请有结果需跟进（如 ELP 已批准）；与具体某人的预约/会面；仍有待办动作的订单
  （待取件/待付款/待收货）。**构成「有后果的事」的凭证的回执**也保留：作业与考试的提交凭证
  （Turnitin digital receipt、作业提交成功、考试报名成功）、缴费与付款凭证、正式申请的受理编号、
  合同或协议的签署确认——这类按「知悉即可」处理（actionable=false），importance 按后果轻重评定
  （学业提交凭证通常 normal）。已完成消费的收据（餐饮消费回执、已交付订单确认）不构成凭证，
  属于回执类，过滤。
   **回信带实质结论**也保留：对方针对收件人本人的具体询问、申诉或申请，回信中给出了实质说明或
   处理结论（如解释某项成绩为何如此、告知申诉/复核结果、给出具体处理办法或裁定）。
   判断依据：这封回信是否包含收件人此前不知道的**结论性信息**？是则保留，按「知悉即可」处理
   （actionable=false），importance 按后果轻重评定。注意：不以标题 `Re:` 前缀为判断依据——
   带 `Re:` 不必然保留也不必然过滤，看正文里有没有结论性内容。
- 被过滤邮件不生成条目，但邮件本体仍入库、仍可被 AI 搜索读到。
- 保留条目中 `actionable=false` 只用于「需知悉但无需动手」的通知（课程结课通知、政策变更告知），
  不用来兜底表达「可能没用」；不可行动的通知类邮件仍生成条目（actionable=false，无截止日期），
  便于「看过就勾掉」。
- `importance`（high|normal|low）与 `actionable` **相互独立**：`actionable` 表示「是否需要动手」，
  `importance` 表示「不做的后果有多大」，两者不互相替代。
  - **high**：涉及学业/工作成绩或资格的关键事项，即使邮件里没写日期也必须尽快处理——考试与补考安排、
    成绩发布与成绩申诉、课程注册与退课、签证/身份/缴费相关、明确要求本人确认或提交材料的官方流程
    （如 ELP 确认并转发）、导师或上级直接点名要求回应的事；
  - **low**：知悉即可、不处理也无损失的通知（课程结课告知、政策变更通报）；
  - **normal**：其余。不写日期的邮件由 LLM 如实返回 `due_date=null`，**不得推测日期**；
    重要度由 `importance` 承担，避免推测日期出错让人错过真正截止时间。
- LLM 返回非法 JSON 时重试一次，仍失败则该邮件标记 `llm_error`，下轮重试，不阻塞队列。

### 4.2 详情（agentic：先检索关联邮件再写详情；worker 预生成 + 点开兜底）

基于邮件全文写中文详情，剔除客套话、签名档、免责声明、无关信息，
保留关键事实/时间/链接/要求的动作。生成前先走 agentic 循环（上限 8 轮，工具与
AI 搜索同一套 `search_emails` / `read_emails`）：若邮件涉及来历不明的金额或退款、
状态变化、异常标记（如成绩「未知」）、或是对之前某次通知的跟进，先翻阅该用户
的其他邮件查清来龙去脉，只关联确实解释了本邮件的邮件；查到背景时在详情里写
「## 背景」一节并点明结论来源邮件（主题 + 日期）。输出 JSON
`{"detail_md": "...", "related": [{"email_id": int, "reason": "一句话原因"}]}`；
`related` 不含当前邮件自身、只保留本人账户、去重且最多 10 条、reason ≤ 200 字，
与 `detail_md` 一并落库（`related_json`，JSON 文本列）。历史任务不回填。

生成时机：worker 每轮分类落库后，对 `detail_md` 为空的条目（本轮新建 + 历史回填）
按新→旧逐条生成并提交；单条失败跳过，留待下轮重试；一条详情可能是多轮 LLM 调用。
用户点开尚未生成的条目时，`POST /api/items/{id}/detail` 仍现场生成作为兜底。
详情/关联逻辑调整后，`regen-details --user <sub|邮箱> [--account <邮箱>] [--yes]`
可手动把该用户（可限账户）所有条目的详情与关联邮件置空，由 worker 下轮重新生成。

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
users(sub, email, name, calendar_token|null（订阅密钥，见下）, caldav_password_hash|null（CalDAV 应用密码 sha256，见第 11 节）, created_at, last_seen_at)
accounts(id, user_sub→users, name, kind gmail|microsoft, email, ms_client_id,
         app_password, enabled, token_cache, uidvalidity, last_uid,
         last_sync_at, last_error, status ok|error|pending)
         user_sub 建索引（按用户过滤/级联）
emails(id, account_id→accounts, message_id, subject, sender, recipients, sent_at,
       text_body, html_body, attachments_json, fetched_at,
       filtered bool, filter_reason, llm_state pending|done|error)
       UNIQUE(account_id, message_id)；FTS5 虚表 emails_fts(subject, sender, text_body) 由触发器同步
items(id, email_id→emails UNIQUE|null（null=手动条目，无源邮件）, user_sub→users,
      title, summary, category, due_date date|null,
      importance high|normal|low, actionable bool, status open|done, detail_md|null,
      related_json|null（关联邮件 JSON 数组 [{"email_id": int, "reason": str}]）,
      created_at, done_at|null,
      caldav_uid|null（32 位大写 hex UID）, caldav_name|null（客户端文件名 ≠ UID 时才非空）,
      caldav_ics|null（客户端最近一次 PUT 的原始 VCALENDAR 文本，透传载体）,
      updated_at|null（ORM onupdate 维护，内容 ETag 的时间来源））
      user_sub 建索引（手动条目没有邮件链，归属直接落在条目上）
```

- CalDAV 资源名 = `coalesce(caldav_name, caldav_uid)`：iPhone 侧寻址、ctag 排序都
  用它；`updated_at` 由 ORM `onupdate` 在每次变更时自动刷新，是内容 ETag 的时间来源
  （见第 11.7 节）。

- `items.importance` 等后续新增列通过 `init_db` 的**就地 ALTER 迁移**：`create_all` 不会给已存在的
  表加列，启动时 `_ensure_columns` 用 `PRAGMA table_info` 检查缺失列并
  `ALTER TABLE ADD COLUMN`（幂等，每次启动执行、已存在即跳过），**不再需要删库重建**——
  生产库存着四个邮箱的 OAuth token cache，删库意味着用户要重新授权四遍。
- `items` 支持手动条目（`email_id` 为 null）那次是**整表重建迁移**（`_migrate_items_manual`）：
  SQLite 的 ALTER 不能去掉既有列的 NOT NULL，而 items 上没有 FTS 触发器、也没有表引用它，
  所以可以 `RENAME → 按模型建新表 → 搬行 → 计数核对 → DROP` 整表重建；旧行的归属在迁移里
  经邮件链推导回填进 `user_sub`，邮件链断裂的行宁可启动失败（回滚）也不静默丢弃。
- `users`：登录 Phainon 的用户，首次访问自动创建（准入见第 6 节）。
- `users.calendar_token`：日历订阅密钥（`/api/calendar/{token}.ics`），链接即凭据；
  旧库由 `_ensure_columns` 补普通列（ADD COLUMN 加不了 UNIQUE，新建库才有 UNIQUE 约束），
  泄露即用 rotate 换新。
- `users.caldav_password_hash`：CalDAV Basic 鉴权的应用密码 sha256 hex，NULL = 未开通；
  明文只在开通/轮换的响应里出现一次（见第 11.3 节）。旧库同样由 `_ensure_columns`
  就地补普通列。
- `items.caldav_uid / caldav_name / caldav_ics / updated_at`：CalDAV 身份与透传列，
  与 `users.caldav_password_hash` 一并由 `init_db` 迁移补齐；新列对既有行全为 NULL，
  由 `_backfill_caldav_identity` 两条幂等 UPDATE 回填（只碰仍为 NULL 的行，重复启动
  安全；`_migrate_items_manual` 重建表后新列也靠它）：
  `UPDATE items SET caldav_uid = upper(hex(randomblob(16))) WHERE caldav_uid IS NULL`
  与 `UPDATE items SET updated_at = created_at WHERE updated_at IS NULL`。
- `accounts.app_password`：Gmail 应用专用密码，明文存库，任何 API 都不会返回它。
- `accounts.enabled`：软删除标记，CLI `accounts remove` 置 false（停用并清除凭据、
  不再同步），已抓取的邮件与已生成的任务保留。
- 多用户隔离：items 直接持有 `user_sub`（手动条目无邮件可推导）；emails 仍经
  `emails.account_id → accounts.user_sub` 推导，所有查询都以当前登录者 sub 过滤。

## 6. REST API（鉴权：除 /api/health 与 /api/calendar/{token}.ics 外，/api/* 全部走 Bearer；
CalDAV 路径 /caldav/* 与 /.well-known/caldav 不在其列——走 HTTP Basic + 应用密码，见第 11 节）

```
GET  /api/health                    公开存活探针
GET  /api/items?status=&category=   条目列表（默认 open；每项含 related 关联邮件）
POST /api/items                     新建手动条目（email_id=null）：{"title","summary","category","due_date"}，
                                    校验失败 400 bad_title|bad_summary|bad_category|bad_due_date；成功 201
PATCH /api/items/{id}               {"status"} 任何条目可改；{"title","summary","category","due_date"}
                                    只对手动条目（email_id=null）开放，邮件条目改这四个字段 400 not_editable；
                                    空请求体 400 bad_request；成功 200
DELETE /api/items/{id}              手动条目 → 204；邮件条目 → 400 not_editable
GET  /api/items/{id}                含 detail_md（可能为 null）与 related
POST /api/items/{id}/detail         生成并缓存详情与关联邮件（agentic，多轮 LLM），
                                    返回 detail_md + related；手动条目 → 400 no_email（不调 LLM）
GET  /api/items/{id}/export         导出条目 Markdown 纯文本（AI 见解 + 当前邮件全文
                                    + 关联邮件全文）；手动条目输出标题 + 「## 详情」（summary 原文），
                                    无当前邮件/关联邮件段；纯读、无 LLM 调用、不限流
GET  /api/emails/{id}               元数据 + text_body + sanitized_html
POST /api/search                    {"question"} → {"answer_md", "citations":[{email_id, subject, sent_at}]}
GET  /api/status                    各账户健康（含 enabled 停用标记）+ 上次同步时间 + LLM 待处理数
GET  /api/calendar                  → {"token"}；尚无令牌时生成并落库（鉴权）
POST /api/calendar/rotate           无条件生成新令牌并覆盖（鉴权）；旧订阅链接立即失效
GET  /api/caldav                    CalDAV 接入信息（鉴权）：→ {"username": 邮箱或 sub,
                                    "path": "/caldav/", "configured": bool}。GET 不生成应用密码——
                                    密码明文只显示一次，只能由下面这个 POST 显式产生
POST /api/caldav/password           无条件重新生成 CalDAV 应用密码并覆盖，旧密码立即失效
                                    （鉴权）：→ {"password"}，明文只在本次响应出现一次，
                                    之后库里只存 sha256 hex
GET  /api/calendar/{token}.ics      公开（令牌即凭据，不需要 Bearer）：该用户 status=open 且
                                    due_date 非空（含手动条目）的全部条目 → 全天事件 iCalendar，
                                    每条带当天 10:00 提醒（TRIGGER;RELATED=START:PT10H，相对触发，
                                    不做服务端时区假设）；令牌无效 404
```

- **多用户隔离**：所有端点只返回当前登录者自己的邮箱账户、邮件与任务；访问他人
  资源的越权请求一律返回 404 而非 403，不暴露资源 id 是否存在。手动条目没有邮件链，
  `user_sub` 直接挂在条目上；`/api/calendar/{token}.ics` 按令牌对应用户的 sub 过滤条目。
- `/api/status` 的账户对象新增 `enabled: boolean`（CLI 停用后为 false，账户仍返回）；
  任何 API 响应都不含 `app_password` / `token_cache`。
- 手动条目对象：`email_id: null`（前端据此区分手动/邮件条目），`email_subject` /
  `email_sender` / `email_sent_at` 为 null，`detail_md` 恒为 null、`related` 恒为 []。

鉴权中间件：取 Bearer → `GET {PHAINON_API_BASE}/auth/priestess/oidc/me`
（转发同一 Bearer，附 `Origin: {FRONTEND_ORIGIN}`）→ 200 且 `app_id == PHAINON_APP_ID`
即放行（无白名单）；首次访问自动创建用户记录；对 token 哈希做 60s 内存缓存；否则 401。

CalDAV 例外：`/caldav/*` 与 `/.well-known/caldav` 不走上述 Bearer 中间件——iOS 提醒事项
不会发 Bearer，走 HTTP Basic + 应用密码（用户名 = 邮箱或 sub，密码由
`POST /api/caldav/password` 生成），鉴权细节见第 11 节；`/api/caldav` 与
`/api/caldav/password` 本身属 REST，仍走 Bearer。

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
- 主页：AppBar + 分类筛选 Chip（全部/学业/工作/个人/账单/其他）+ 分组列表：
  **今天**（含逾期，逾期红色高亮）/ **本周** / **重要**（无近期日期但 importance=high，
  不沉底）/ **无期限**（其余无日期或超出本周，带日期 Chip）。
  high 条目带「重要」Chip 标记。条目 Checkbox 勾选完成；「已完成」在底部折叠区。
- 条目详情（全屏 Dialog）：AI 详情（通常已预生成；未生成时首开现场生成，加载态）→ 底部「显示原邮件」展开 sandbox iframe
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

## 11. CalDAV（iPhone 提醒事项同步）

### 11.1 目标与客户端接入

服务端实现最小 CalDAV 日历服务器（RFC 4918 / RFC 4791），只服务 VTODO，让 iOS
「提醒事项」把本系统清单当作一个 CalDAV 账户直接读写：在任意 iPhone 上新建任务、
勾选完成、删除（划掉）、改标题/日期/重要度都会同步回服务端；反之网页端的改动也会
在 iPhone 下一轮同步时出现。服务器侧由 `backend/app/caldav/` 实现
（router.py / store.py / vtodo.py / auth.py / errors.py / xmlio.py），路由挂在 FastAPI
主应用上，复用同一 SQLite 与数据模型。

开通与接入路径：

- 网页「设置」页：`GET /api/caldav` 返回 `username`（邮箱或 sub）与 `path`
  （`/caldav/`）；`POST /api/caldav/password` 生成应用密码（明文只显示这一次，11.3 节）。
- iPhone：设置 → 日历/提醒事项 → 账户 → 添加账户 → 其他 → 添加 CalDAV 账户，
  服务器填 `https://<主机>/caldav/`，用户名/密码用上一步的值。该账户只含一个
  VTODO 集合，因此在 iPhone 上以「RakkoTasks」列表出现在提醒事项里。
- 同步频率不由服务器决定：CalDAV 没有推送，iPhone 按自身的「获取新数据」调度
  轮询服务器（见 11.11 已知行为）。

### 11.2 URL 布局与路由挂载

五个 DAV 资源（常量 `ROOT_HREF` / `PRINCIPAL_HREF` / `HOME_HREF` / `COLLECTION_HREF`
+ 对象模式），外加一个发现入口：

```
/.well-known/caldav                    发现入口 → 301 到 /caldav/
/caldav/                                ROOT（支持集/根集合）
/caldav/principals/me/                  PRINCIPAL（当前用户主体）
/caldav/calendars/me/                   HOME（日历主集）
/caldav/calendars/me/tasks/             COLLECTION：唯一 VTODO 集合「RakkoTasks」
/caldav/calendars/me/tasks/{stem}.ics   OBJECT：单个任务（寻址见 11.4）
```

- 用户段固定为字面量 `me`：身份完全由 Basic 鉴权决定（11.3 节），不放进 URL、
  也就不会进访问日志；跨用户的资源查询一律 404（与 REST 侧 IDOR 策略一致）。
- 路径按段精确匹配（`resolve`）：尾斜杠可有可无，其它形状一律 404。
- 挂载时机：`register_caldav` 在 SPA fallback 之前注册 catch-all 路由，否则 GET
  会被兜底吞成 index.html、其它方法被吞成 405；这些路由 `include_in_schema=False`，
  不进 OpenAPI 文档。
- 错误通道：本路径下一切错误经 `DavError` 输出纯文本或 XML，**永不出现 JSON**——
  iOS 会把 JSON 响应判成「服务器错误」，整个账户同步失败。

### 11.3 鉴权：HTTP Basic + 应用密码

- iOS 提醒事项不做 Bearer，鉴权走 Basic：`Authorization: Basic base64(user:pass)`。
  `auth.py` 严格 base64 解码、按首个冒号切分（密码可含冒号）、用户名按 sub 或邮箱
  精确找用户（`find_user_by_spec`，邮箱对应多行时拒绝，避免歧义）。
- 失败回 401，带质询头 `WWW-Authenticate: Basic realm="RakkoTasks", charset="UTF-8"`
  （`REALM_HEADER`）——iOS 靠它学会携带凭据重试。
- 应用密码：`secrets.token_urlsafe(24)` 生成的 32 字符高熵令牌（`generate_app_password`），
  库里只存单轮 sha256 hex（`users.caldav_password_hash`），不存明文、任何日志/异常
  路径都不打印密码。为什么单轮 sha256 而非慢哈希：强度来自随机令牌的熵本身（不是
  用户自选弱口令），且 iPhone 每轮同步会对每个资源反复发请求，鉴权必须廉价。
- 生成与轮换：明文只在 `POST /api/caldav/password` 的响应里出现一次；无条件重新
  POST 即轮换——覆盖 hash、旧密码立即失效（旧订阅的 iOS 账户需重输一次密码）。
  `GET /api/caldav` 只读不生成。
- 失败限流：鉴权失败按来源计数（`client_key`：CF-Connecting-IP → X-Forwarded-For
  首段 → 直连地址 → unknown），`RateLimiter(30, 60.0)` 即每来源每分钟最多 30 次
  失败尝试；超限回 429 + `Retry-After: 60`，阻止对应用密码的在线爆破。

### 11.4 资源模型：单集合、保留窗口与寻址

- 单集合、单所有者：每个用户只有一个固定集合「RakkoTasks」
  （`/caldav/calendars/me/tasks/`），不支持新建/改名列表（见 11.10）。
- 成员枚举（`store.list_members`）：`status=open` 的全部 + `status=done` 且
  `done_at` 落在最近 `caldav_done_retention_days`（默认 30）天内的；`done_at` 为
  NULL 的已完成行按「久远」排除。保留窗口只作用于枚举（PROPFIND Depth:1、
  calendar-query、ctag）；按名寻址单个对象不受窗口限制——完成超过 30 天的条目
  只要网页端还在，按 URL 仍可取。
- 寻址：对象资源名 stem = 客户端 PUT 时起的文件名（`caldav_name`），客户端没另起
  文件名时就是 UID（`caldav_uid`）。落库唯一寻址规则 `coalesce(caldav_name,
  caldav_uid) = stem`（`find_by_stem`）；PUT 解析出的 UID 命中另一文件名下的已有
  条目时按 `find_by_uid` 转挂（同一对象换了文件名/重复 PUT 旧名）。
- iPhone 新建的任务没有分类信息可依（单列表），固定归入「个人」、importance=normal、
  actionable=true，且无源邮件（`email_id` 为 null，等同手动条目）。

### 11.5 字段映射：VTODO ↔ items

序列化方向 `serialize`（库 → 客户端）；解析方向 `read_fields`（客户端 → 库）：

| 库字段 | 序列化 → VTODO | 解析 ← VTODO |
|---|---|---|
| title | `SUMMARY`（escape 后覆盖） | `SUMMARY` → `normalize_title` |
| summary | `DESCRIPTION`（空则不输出） | `DESCRIPTION` → `normalize_summary` |
| due_date | `DUE;VALUE=DATE`（YYYYMMDD，见下） | `DUE` → 日期（见下） |
| status | `STATUS:NEEDS-ACTION` / `STATUS:COMPLETED`；完成另输出 `PERCENT-COMPLETE:100`，`done_at` 非空再输出 `COMPLETED` | `STATUS ∈ {COMPLETED, CANCELLED}` 或 `PERCENT-COMPLETE == 100` 或存在 `COMPLETED` 即算完成；`COMPLETED` 值作 `done_at`（畸形则丢弃时刻） |
| importance | `PRIORITY:1`（high）/ `PRIORITY:9`（low）；normal 不输出 | `PRIORITY` 1–4 → high、6–9 → low、0/5/缺失/非法 → normal |
| category | `CATEGORIES`（服务端单写） | `CATEGORIES` 一律忽略——服务端分类来自 REST/规则侧，不被客户端覆盖 |
| caldav_uid | `UID` | `UID` → `caldav_uid`（客户端给了 UID 就用客户端的） |

`DUE` 四种形态（`_due_from_value`，解析与透传比较共用同一规则、同一时区）：

1. `VALUE=DATE` 或裸 8 位数字 `YYYYMMDD`：字面日期；
2. DATE-TIME 不带 Z（浮动时间或带 TZID）：取字面日期——那是客户端的本地时间，
   时区由客户端负责，服务端不换算；
3. 以 `Z` 结尾的 UTC 时刻：经 `Settings.local_timezone`（默认 Australia/Sydney）换算
   成当地日期——服务端以此确定「客户端当时所在的那个本地日」；
4. 其它形态：载荷非法 → 拒收（403 valid-calendar-data）。

时区为什么必须用配置项而不是 UTC：读取 PUT 与比较透传体用的是同一套反算规则、
同一时区；若两侧时区不一致，同一个 Z 时刻会算出两个日期，导致客户端设的截止时刻
与闹钟在每轮同步被误删（见 11.6 时间簇）。

### 11.6 PUT/DELETE 语义、可编辑规则与透传体

- 可编辑规则（`store.apply_put`）：**邮件条目（`email_id` 非空）只接受状态**——
  标题/摘要/截止日/重要度的改动被静默忽略；**手动条目接受标题/摘要/截止日/重要度/状态**
  全部五个字段。两者都会更新 CalDAV 身份列（`caldav_uid`/`caldav_name`）与透传体。
- 被忽略的字段不报错：请求正常完成（新建 201 / 更新 204），被忽略的字段名记入
  日志——客户端下一轮同步会看到服务端值「还原」，这比 4xx 让那条提醒永远同步失败
  要好。网页端 REST 仍是邮件条目修改的唯一入口（PATCH 400 not_editable 策略不变）。
- DELETE 语义（`store.apply_delete`）：手动条目真删（行删除）；邮件条目按产品决策
  **视为完成**（`set_status done`）——iPhone 上把一条来自邮件的提醒划掉/删除 = 做完了，
  邮件原文与历史仍保留在网页端。DELETE/PUT 都先做 If-Match/If-None-Match 校验
  （RFC 7232），不符回 412。
- 透传体（`items.caldav_ics`）：每次 PUT 把客户端正文原样存下；有透传体时
  `serialize` 不改写客户端的布局与折行，只做两件事：
  1. 服务端「拥有」的属性（`_OWNED_NAMES`：UID/DTSTAMP/CREATED/LAST-MODIFIED/SUMMARY/
     DESCRIPTION/STATUS/PERCENT-COMPLETE/COMPLETED/PRIORITY/CATEGORIES）在主 VTODO
     里原位替换或插入；
  2. 其余属性行（VALARM、X-APPLE-*、LOCATION、URL、VTIMEZONE……）按原始 raw 行
     逐行原样输出。
  为什么保留客户端原文：闹钟、附加字段这类客户端私有数据不进数据模型，服务端一旦
  用自己的知识重写，就会在每轮同步把它们删掉；只有「覆盖服务端拥有的、透传其余的」
  才能双向不丢数据。
- 时间簇（`_CLUSTER_NAMES`：DTSTART/DUE/DURATION/RRULE/RDATE/EXDATE）：`DUE` 与
  语义上绑定的整组日期/重复行作为一个整体处理。透传体 `DUE` 按 11.5 规则算出的日期
  等于库内 `due_date` → 整簇原样保留；不相等（例如网页端改了手动条目的日期）→
  删除整簇（含顶层带 `RECURRENCE-ID` 的重复实例组件），再按 `due_date` 只写一行
  `DUE;VALUE=DATE`。为什么整簇处理：只改 DUE 会留下仍锚在旧 DTSTART 上的闹钟与
  重复规则，产生自相矛盾的载荷；整簇替换是最小的一致解。副作用见 11.11。

### 11.7 ETag / ctag 与「序列化不许 now()」约束

- 内容 ETag（`vtodo.etag_for`）：`'"' + sha256(body) 前 32 位 hex + '"'`。字节相同
  → ETag 相同，与客户端是否改过无关。
- 对象 `getetag` = 该内容 ETag；`getlastmodified`、序列化里的 DTSTAMP/CREATED/
  LAST-MODIFIED 都派生自库内时间戳（`updated_at` → `created_at`），`updated_at` 由
  ORM `onupdate` 每次变更自动刷新。
- **硬约束：`serialize()` 任何位置不允许出现 `datetime.now()`**——DTSTAMP 一变内容
  就变、ETag 就变，iPhone 会误以为有更新而无限重下。条目不变 → 字节不变 → ETag
  不变。
- ctag（集合变更标记，`store.ctag`）：成员按资源名排序后对 `(stem, etag)` 表取
  sha256、截前 32 位 hex。增删改任一成员都会变、纯读不变；iPhone 凭它决定是否要
  重新拉全量。

### 11.8 方法契约

| 方法 | 行为 |
|---|---|
| OPTIONS | 200；`DAV: 1, 3, access-control, calendar-access`；`Allow` 只列真正实现的八个方法（OPTIONS, GET, HEAD, PROPFIND, REPORT, PUT, DELETE, PROPPATCH） |
| PROPFIND | 五种资源皆可；Depth 0/1（infinity → 403 `<d:propfind-finite-depth/>`）；207 multistatus；集合 Depth:1 枚举成员对象；HOME Depth:1 附带集合本体 |
| REPORT | 仅限集合（其它目标 → 403 `<d:supported-report/>`）；`calendar-query`（comp-filter=VTODO → 枚举成员）与 `calendar-multiget`（按 href 逐个 `find_by_stem`，不存在的项单列 404）；其余报告类型 → 403 |
| GET / HEAD | 仅限对象（其它目标 405）；`text/calendar` 体 + ETag 头，HEAD 空体 |
| PUT | 仅限对象；解析失败 → 403 `<c:valid-calendar-data/>`；先按 stem、再按解析出的 UID 找既有条目（改名/重复 PUT）；成功后 201（新建）/ 204（更新）+ ETag |
| DELETE | 仅限对象；手动真删 / 邮件条目置完成（11.6）；204 |
| PROPPATCH | 207，所有属性一律 forbidden（属性表服务端单写，客户端改不动） |
| MKCALENDAR / MKCOL | 403「不支持新建日历集合：列表集合是固定的」 |
| 其余（MOVE/COPY/LOCK/UNLOCK/ACL/POST/PATCH…） | 405 + `Allow` 头 |

### 11.9 请求体上限

`XML_BODY_LIMIT = 1 MiB`：PUT 之外所有请求体上限（Content-Length 声明值与实收
长度都查）；`PUT_BODY_LIMIT = 256 KiB`：PUT 专用。超限回 413 payload too large。

### 11.10 非目标

- 不做 sync-collection（多设备离线修改的合并/冲突仲裁）；
- 不支持 RRULE/重复任务（只处理主 VTODO；带 RECURRENCE-ID 的实例只随时间簇整体
  保留或删除，不解析不生成）；
- 不支持子任务、在 iPhone 上新建列表/分类（集合固定、新任务归「个人」）；
- 不做 scheduling（无 ATTENDEE/邀请往来）；CalDAV 被当作本清单的只读镜像加回写
  通道，不做日历事件、不做闹钟的服务端存储（闹钟随客户端原文透传）。

### 11.11 已知行为

- reclassify 会删除目标邮件关联的条目并在下一轮按新规则重建，重建条目带新的
  `caldav_uid` 与资源名：iPhone 上该提醒表现为先消失、随后以新身份重新出现
  （列表短暂抖动）。属预期，不丢数据。
- 网页端改手动条目的日期会清掉手机上设的闹钟：due_date 变化 → 透传体时间簇被
  整体重写（11.6），以旧 DTSTART/DUE 为锚的客户端闹钟随之失效。这是时间簇规则的
  正确副作用，不是 bug。
- 同步不是实时的：iPhone 按「获取新数据」调度轮询（含手动下拉刷新），网页端改动
  不会立即推送到达手机；手机端到网页端的延迟同理。
