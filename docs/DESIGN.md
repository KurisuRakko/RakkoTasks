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
| Gmail | IMAP `imap.gmail.com:993` | 应用专用密码（网页设置页录入后存库；CLI 兜底） |

- Microsoft OAuth：msal `PublicClientApplication`，authority `https://login.microsoftonline.com/common`，
  scope `https://outlook.office.com/IMAP.AccessAsUser.All`（OAuth 资源域名是 outlook.office.com，与 IMAP 主机名 outlook.office365.com 不同；msal 自动附带 offline_access）。
  client_id 每账户可配，默认 `9e5f94bc-e8a4-4e73-b8be-63364c29d753`（Mozilla
  Thunderbird 注册的公共客户端，第三方应用，可用于 IMAP）。不要改回 Microsoft Office
  的 `d3590ed6-52b3-4102-aeff-aad2292ab01c`：那是第一方应用，访问第一方资源
  Exchange Online 必须经预授权，会报 `AADSTS65002`，拿不到 IMAP token。UNSW 官方
  文档里用到 d3590ed6 的是 Evolution 一节，配的是 EWS 而非 IMAP；其 Thunderbird
  一节用的正是它内置的客户端 ID。msal 的 SerializableTokenCache 按账户序列化存入 DB。
- **账户由用户在网页设置页自助管理**（2026-09-06 起；CLI 保留为运维兜底）：添加 /
  重命名 / 改 Gmail 应用专用密码 / 重新授权微软 / 停用·启用 / 彻底删除，全部经
  `/api/accounts*`（见第 6 节），按当前登录者隔离。Gmail 应用专用密码经 HTTPS 提交后
  明文存库、永不经任何 API 返回；响应里只有 `has_credentials` 布尔。
- 微软授权（网页）：授权码 + PKCE 流程，复用 `app/imap/mstoken.py` 的
  `initiate_auth_code_flow` / `complete_auth_code_flow`。默认 client_id 是 Thunderbird 公共
  客户端，其注册的重定向地址不是本站，所以**无法回跳到本站**，只能走「引导式两步」：
  ① 服务端生成授权链接，用户在新标签页登录并完成 MFA；② 浏览器停在空白页
  `login.microsoftonline.com/common/oauth2/nativeclient`，用户把地址栏完整 URL（或页面上的
  授权码）粘贴回向导，服务端换 token 落库。flow 文件仍落在数据库同目录（web 容器挂有 /data）。
  设备码流程只保留给 CLI（UNSW 等租户已禁用，网页不提供）。
- 刚添加但尚未拿到凭据的账户（微软未完成授权）`status=pending`、`has_credentials=false`，
  worker 跳过它不同步、也不把它改成 error；拿到凭据后下一轮开始首轮回补
  （默认 `INITIAL_BACKFILL_DAYS=7`）。不做「授权完成立即同步」。
- refresh token 失效：账户状态置 error，设置页显示错误并提供「重新授权」；不做主动通知。
- 停用（enabled=0）：清空凭据、status 置 pending，保留邮件与任务，可重新启用（需重新设凭据）。
  彻底删除：删除账户行、其全部邮件与由其邮件生成的任务（手动条目不受影响），不可恢复。
- CLI（`python -m app.cli accounts add/connect/auth-url/auth-code/set-password/list/remove`，
  `--user <sub|邮箱>`）与网页共用 `app/accounts.py` 服务层，语义一致。
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

### 4.4 自然语言快速记事（一句话 → 条目）

用户在「+」打开的对话框里说一句话（手机上直接用 iOS 键盘听写），LLM 解析成结构化
条目。系统提示 `PARSE_TASK_SYSTEM` 在 `backend/app/llm.py`，单轮调用走已有的
`_chat_json`（`json_object` 模式 + `temperature=0.2`），非法 JSON 追加纠错消息重试
一次——与 4.1 邮件分类完全同一套机制，**不走 agent.py 的工具循环**（这里不需要检索）。

输出 JSON（经 `llm.normalize_parsed_task` 归一化后才交给调用方）：

```json
{"title": "≤60字任务标题", "summary": "补充信息或空字符串",
 "category": "学业|工作|个人|账单|其他", "due_date": "2026-09-08 或 null",
 "actionable": true, "importance": "high|normal|low"}
```

字段口径：

- `title` 要提炼出那件事、剥掉「提醒我」「记一下」这类元语言
  （「明天提醒我去把空调修了」→「修空调」）；
- `summary` 只在原话里有标题装不下的信息（地点、联系人、金额、具体要求）时才写，
  **不许把标题换个说法复述一遍**——否则每条都是标题的回声；
- `actionable=false` 用于「记下一件将会发生、本人无需动手的事」（维修工要上门、
  快递会到），与 4.1 的语义一致；
- 模糊区间（「这两天」「最近」「这周内」）取区间里**最早**的一天，不跨多天、
  不拆成多条——数据模型只有单个 `due_date`，拆多条会让同一件事占好几行。

**与 4.1 刻意相反的一点：这里必须解析相对日期。** 4.1 明令「不得推测日期」，因为
邮件没写日期就是真没写，猜了会造出用户没承诺的截止日；而这里用户说「明天」就是
明确指定，不换算成绝对日期的话记下来就是张废纸。这条分歧是刻意的，`llm.py` 的
常量上方有同样的注释，不要有人来「统一」它。

**「今天」的来源与时区**：请求体里前端传的浏览器本地日期（`todayIso()`，按本地
年/月/日分量手拼，不用 `toISOString()`）优先；缺省或非法则回落到
`ZoneInfo(settings.local_timezone)` 的今天，该时区配错（空串/查无此区/绝对路径）
时再退一步用 UTC。**这条链上任何一环都不许用 `date.today()`**：容器 `TZ=UTC` 而
`local_timezone` 默认悉尼，悉尼上午 10 点前 `date.today()` 还是「昨天」，解析
「明天」会直接差一天。（`detail.py` 与 `search.py` 现有的 `date.today()` 是既有隐患，
它们只把日期喂给检索类提示，错一天不产生错误数据，暂不改。）

**提示注入**：用户输入照样过 `wrap_untrusted`（第 7 节）。用户自己敲的字属可信输入，
但他可能把一段邮件正文粘进输入框；哨兵的代价接近零，堵住这条路。输出只落成结构化
字段、不渲染 Markdown，所以不经 `strip_markdown_media`。

**两种模式**（前端，第 8 节）：对话框右上角「速记」开关（默认关，存 localStorage）。
关时走 `POST /api/items/parse` 拿字段填进预览编辑器、用户确认后才 `POST /api/items`；
开时点「确定」立刻关窗，`POST /api/items/quick` 在后台解析并落库，结果回来弹
Snackbar（带「查看」按钮）。`/quick` 的兜底放在服务端而非前端：请求一旦到达就会
跑完，用户点完确定立刻关掉 PWA，条目照样入库。

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
reminders(id, item_id→items ON DELETE CASCADE, remind_at datetime（naive UTC）, created_at)
      item_id 建索引；UNIQUE(item_id, remind_at)
      与 items.due_date 是两件事：due_date = 何时到期（全天、无时刻），
      remind_at = 何时敲用户（有时刻）。每条目最多 REMINDERS_MAX=5 个
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
- `reminders` 是**新表**，不需要就地 ALTER 迁移：`init_db` 里 `Base.metadata.create_all`
  跑在最前面，缺表直接建出来。删条目时提醒跟着走，两道都要：关系上
  `cascade="all, delete-orphan"`（三处删条目——`api.py` / `cli.py` / `caldav/store.py`
  ——走的都是 ORM `session.delete`，靠它生效），FK 上 `ondelete="CASCADE"`
  （兜住将来可能出现的批量 DELETE，`db.py` 已开 `PRAGMA foreign_keys=ON`）。
- ⚠ `reminders` 引用 items，把 `_migrate_items_manual` docstring 里原来那句
  「没有别的表引用 items」作废了。现代 SQLite 的 `ALTER TABLE ... RENAME` 会顺手把
  引用方的外键定义改指向新名（`items_old`），随后 `DROP TABLE items_old` 就留下悬空
  外键。该迁移已加 `PRAGMA legacy_alter_table=ON` 把 RENAME 退回纯改名语义。
  （该路径在 2026-08-30 之后的库上因幂等检查永不执行，但更老的库上是活的——
  `create_all` 跑在它前面，`reminders` 会先被建出来。）
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
POST /api/items                     新建手动条目（email_id=null）：{"title","summary","category","due_date",
                                    "importance"?,"actionable"?,"reminders"?}
                                    reminders 是**带 UTC 偏移的 ISO 8601** 串数组
                                    （"2026-09-08T10:00:00+10:00"）；不带偏移一律 400
                                    bad_reminders——没偏移就是歧义时刻，不替用户猜。
                                    省略 = 无提醒，[] = 清空。超过 5 个 → 400
                                    too_many_reminders。后两个省略时落 normal / true
                                    （AI 快速添加的预览阶段用它们透传 AI 判断，界面上无编辑控件）；
                                    校验失败 400 bad_title|bad_summary|bad_category|bad_due_date|bad_importance；成功 201
POST /api/items/parse               一句自然语言 → 条目字段，**不落库**（限流 20/60s）：
                                    {"text"（≤2000 字）, "today"?（YYYY-MM-DD，用户本地日期）,
                                     "tz"?（IANA 时区名，如 "Australia/Sydney"）}
                                    → 200 {"title","summary","category","due_date","importance",
                                           "actionable","reminders"}
                                    reminders 已由服务端用 tz 把模型输出的本地墙上时刻
                                    换算成带偏移的绝对时刻，前端可直接回填进 POST /api/items
                                    LLM 失败 → 502 parse_error；超长 text → 422
POST /api/items/quick               解析并落库，速记模式用（限流与 /parse 共用同一个 20/60s 计数）：
                                    请求体同 /parse → 201 {"item": {...}, "ai_parsed": bool}
                                    解析失败不报错：用原文兜底落库（title=原文截 128、category="其他"、
                                    due_date=null、importance=normal、actionable=true），仍 201 且 ai_parsed=false。
                                    兜底放在服务端而非前端：请求一旦到达就会跑完（同步 def 端点在
                                    starlette 线程池里，客户端断连不杀线程），所以用户点完确定
                                    立刻关掉 PWA，条目照样入库
PATCH /api/items/{id}               {"status"} 任何条目可改；{"title","summary","category","due_date",
                                    "importance","actionable"} 任何条目都可改（含邮件条目）——与手动
                                    条目一视同仁（决策变更见 11.6）；importance 取值 high|normal|low，
                                    非法值 400 bad_importance；actionable 为布尔；{"reminders"} 任何条目
                                    都可改（含邮件条目）——提醒是用户自己挂上去的东西，与条目内容归谁
                                    无关；传入即整体替换（不是增量），[] 清空；空请求体 400 bad_request；成功 200
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
GET  /api/accounts                  → {"accounts":[AccountInfo]}，当前用户全部账户（含已停用），按 id 升序
POST /api/accounts                  {"name","kind","email","app_password"?,"ms_client_id"?} → 201 AccountInfo
                                    kind ∈ gmail|microsoft 否则 400 bad_kind；name 去空白后 1..128 否则 400 bad_name；
                                    email 去空白后须含 @ 且 ≤256 否则 400 bad_email；kind=gmail 必须带非空
                                    app_password 否则 400 password_required（microsoft 忽略该字段）；
                                    同一用户下 (email, kind) 已存在（含已停用）→ 409 account_exists
PATCH /api/accounts/{id}            {"name"?,"app_password"?,"enabled"?} → 200 AccountInfo；空请求体 400 bad_request；
                                    app_password 只对 gmail 开放，其它 kind → 400 invalid_kind，空串 → 400 password_required，
                                    成功后 status 置 pending、last_error 清空；enabled=false → 清空凭据、status 置 pending；
                                    enabled=true → 只置位（凭据需另行设置）
DELETE /api/accounts/{id}           彻底删除账户 + 其全部邮件 + 由其邮件生成的任务（手动条目不动）→ 204
POST /api/accounts/{id}/auth-url    {"redirect_uri"?} → {"auth_uri"}；非 microsoft → 400 invalid_kind；
                                    redirect_uri 只允许 mstoken.DEFAULT_REDIRECT_URI 或 urn:ietf:wg:oauth:2.0:oob，否则 400 bad_redirect
POST /api/accounts/{id}/auth-code   {"auth_response"} → 200 AccountInfo（status=ok，凭据落库）；
                                    无进行中流程 409 no_pending_flow；授权失败 400
                                    {"code":"auth_failed","kind":"expired|declined|admin_required|other","detail":str}
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
- `AccountInfo`（`/api/accounts*` 与 `/api/status.accounts` 共用同一序列化函数）：
  `{id, name, kind, email, status, enabled, has_credentials, ms_client_id, last_sync_at, last_error}`，
  `enabled` 停用后为 false（账户仍返回），`has_credentials` = gmail 有 app_password /
  microsoft 有 token_cache。任何 API 响应都不含 `app_password` / `token_cache`。
  账户端点里 `{id}` 不属于当前用户一律 404 not_found。
- 条目对象一律带 `reminders: [{id, remind_at}]`（按 `remind_at` 升序，空则 `[]`）；
  `remind_at` 是带 `+00:00` 的 ISO 8601（库内 naive UTC 序列化时补偏移），前端按浏览器
  本地时区渲染。
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
- 右下角「+」→ AI 快速添加（`AiAddDialog`，经 `expand-fab` 容器变换从按钮长出，
  移动端全屏）。三阶段 `input → parsing → fields`，阶段过渡用 Collapse/Fade 走
  `MOTION` token，**不新增 `VtKind`**（新增会连带改 `motion-styles.ts` 的转场契约）：
  - `input`：**只有一个输入框**（无分类无日期），过渡结束后手动 `focus()` 让 iOS
    键盘弹起（Dialog 内 `autoFocus` 在 iOS Safari 上不可靠）。Cmd/Ctrl+Enter = 确定，
    裸 Enter 保持换行。
  - `parsing`：Skeleton 骨架，容器带 `aria-busy` / `aria-label="正在解析"`。
  - `fields`：`ItemFieldsForm`（与 `ItemEditor` 共用的受控字段区，DOM 与文案一处
    定义），值由解析结果预填；`importance` / `actionable` 存进组件 state 于保存时
    原样带进载荷，**界面上不给编辑控件**。
  右上角「速记」Switch（`role="switch"`，默认关，localStorage 键
  `rakkotasks.quick-mode`）：开则跳过 `parsing`/`fields`，点「确定」立刻关窗并把原文
  交给编排层走 `/api/items/quick`。解析失败回 `input`、**保留用户原文不清空**，
  给一个「按原文添加」兜底按钮——绝不让用户白打一遍。
- 提醒编辑（`ItemFieldsForm` 的提醒区，`ItemEditor` 与 `AiAddDialog` 共用）：一行一个
  原生 `input[type=datetime-local]` + 删除按钮，底部「加提醒」，上限 `REMINDERS_MAX`=5。
  组件内部持一份**本地墙上时刻草案 state**，只在外发回调时才经
  `fromDatetimeLocalValue` 转成带偏移 ISO 并过滤空行——用户把某行清空时没有对应的
  绝对时刻可回写 props，草案让「该行退出提交数组、输入框留在原地」成立。草案只在
  挂载时从 props 初始化、之后不随 props 重置（否则被清空的行会被抽走）；
  `AiAddDialog` 靠 `key={phase}` 在进 fields 阶段时整棵子树重挂载，初始化时机足够。
  编辑中不重排行（光标会乱跳），排序去重只发生在出参上。
- `ItemEditor` 保存时**总是显式带上 `reminders`（哪怕是空数组）**：契约里省略 = 不改，
  省略会让「用户把最后一个提醒删掉再保存」变成静默无操作。
- 列表行：提醒 chip 显示最早一条 `🔔 明天 10:00`，多于一条追加 `+N`；截止 chip 原样
  保留，两者可同时出现。分组键改成 `min(最早提醒, 截止)`（`grouping.effectiveDate`），
  否则「明天 10:00 提醒、无截止」的条目会掉进「无期限」组沉底。`isOverdue` **仍只看
  `due_date`**：「逾期」说的是过了截止日，提醒迟了不该给红色高亮。
- 提醒时刻的换算集中在 `lib/time.ts`（`formatReminder` / `toDatetimeLocalValue` /
  `fromDatetimeLocalValue` / `localTimeZone`）。**不许用 `toISOString().slice(...)`**
  ——那是 UTC 墙上时刻，本地时区一偏就差几小时甚至跨天。
- 速记落库的 Promise **故意不绑组件生命周期**（不接 AbortController、卸载时不取消）：
  请求一旦到达服务端就会跑完并入库，用户切页也该让它继续；卸载时取消只会白丢条目。
  结果回来弹 Snackbar，带「查看」按钮（文案就是「查看」两个字）直接开该条详情。
- 设置页「邮箱账户」区：账户卡片（状态 Chip、凭据是否就绪、上次同步、错误）+「添加邮箱」。
  容器按断点分流：桌面（md 起）用 Dialog（`mainAreaDialogSx`），移动端用独立路由页
  `/settings/accounts/new`、`/settings/accounts/:id`、`/settings/accounts/:id/remove`，
  进入从右滑入、返回向左滑出（View Transitions route-forward / route-back；设置组内按路径深度定方向）。
  - 添加向导：① 选类型（Gmail / Outlook·Microsoft 365，学校与公司邮箱也选后者）→ ② 名称、邮箱；
    Gmail 附应用专用密码输入与生成指引（Google 账号 → 安全性 → 两步验证 → 应用专用密码）；
    微软可展开「高级」填自定义 client_id（默认 Thunderbird）→ ③ 微软授权引导：生成链接 →
    新标签登录并完成 MFA → 浏览器停在空白页 → 把完整地址粘回 → 完成；auth_failed 按 kind 给
    中文提示与重试 → ④ 完成页：说明「下一轮同步（最多 15 分钟）开始拉取最近 7 天邮件」。
  - 账户详情：重命名、改密码（gmail）、重新授权（microsoft，复用步骤 ③）、停用/启用、移除。
    移除二选一：停用（只删凭据，保留邮件与任务，可恢复）/ 彻底删除（连带邮件与任务，二次确认）。
  - 任务页空态：条目为空且用户尚无账户时显示「还没有接入邮箱」+ 前往设置的按钮。
- PWA：vite-plugin-pwa，manifest 名称 RakkoTasks，可添加到主屏幕。
- 移动优先；MUI 默认主题即可，8dp 间距体系。

## 9. 部署

- 单一 Dockerfile 多阶段：node 构建 frontend → python 镜像装 backend 并携带 `frontend/dist`，
  FastAPI StaticFiles 托管（SPA fallback 到 index.html）。
- compose 服务：`web`（uvicorn :8000）、`worker`（`python -m app.worker`，同镜像）、
  `cloudflared`（`TUNNEL_TOKEN` env；DNS 与隧道由使用者后配）。`./data` 挂载给 web 与 worker。
- 全部配置走 env，提供 `.env.example`。邮箱凭据与用户白名单不再走 env：
  `GMAIL_APP_PASSWORD` / `ALLOWED_SUBS` 已删除，Gmail 应用专用密码由用户在网页
  设置页录入存库（CLI 兜底），任何用户都可直接使用（无白名单）。

## 10. 非目标（v1 明确不做）

英文界面；发件人静音规则；勾选回写邮箱已读；除 INBOX 外的文件夹；附件下载；
推送通知；用户审批流程；授权完成后立即触发同步（等下一轮）。

已反转（曾列为非目标、后来做了，留档以免有人照旧文档判断）：**手动添加/编辑任务**
（`POST /api/items` 与 `ItemEditor`，2026-08 起）；**网页端管理邮箱账户**
（`/api/accounts*` 与设置页自助管理，2026-09-06 起）；**自然语言快速记事**
（4.4 节，2026-09-07 起）。

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

- 可编辑规则（`store.apply_put`）：**两类条目同权，无差异化限制**——客户端 PUT 的
  标题/摘要/截止日/重要度/状态，对邮件条目（`email_id` 非空）与手动条目一样全部写入；
  两者都更新 CalDAV 身份列（`caldav_uid`/`caldav_name`）与透传体。为什么不再区分：
  用户在 iPhone 提醒事项里改一条来自邮件的任务（改标题/日期/重要度都算），服务端若
  静默丢弃，下一轮同步就会把它还原回去——改了等于白改。邮件条目已不是只读的。
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
- 不做 scheduling（无 ATTENDEE/邀请往来）；CalDAV 被当作本清单的只读镜像加回写通道，
  不做日历事件。
- **闹钟不再是纯透传**（2026-09-07 起，见 11.12 的双车道）：服务端拥有自己那条车道，
  客户端手设的闹钟仍原样透传保留。

### 11.12 VALARM 双车道（提醒的落地方式）

`reminders` 表要变成 iPhone 上真的会响的东西，只有 CalDAV 这条路——VALARM。
难点是现状的透传哲学：客户端 PUT 的原文整体存进 `caldav_ics`，VALARM / `X-APPLE-*`
服务端一根手指都不碰。直接改成「服务端拥有 VALARM」会**洗掉用户在 iPhone 上手加的
闹钟**，那是真实的功能退化。

所以分两条车道，靠一个自有标记属性区分：

- **服务端车道**：每条 `reminders` 生成一个 VALARM，内含
  `X-RAKKOTASKS-REMINDER:1` 标记。序列化时先删掉透传体里**带这个标记的** VALARM
  子组件，再按库内提醒重新写入。
- **客户端车道**：不带标记的 VALARM（用户在提醒事项 App 里自己设的）原样保留在
  透传体里，服务端不读、不改、不删。

实现要点：

- VALARM 是**子组件**不是属性行，所以它不进 `_OWNED_NAMES`（那套是行级替换），
  要单独处理 `vtodo.children`。
- `TRIGGER` 用**绝对时刻**（`TRIGGER;VALUE=DATE-TIME:20260908T000000Z`）而不是相对
  偏移。两个理由：`remind_at` 本身就是绝对时刻，相对偏移得挂在 DTSTART/DUE 上；
  而 `_apply_time_cluster` 在 DUE 变化时会整簇删除，锚在簇上的闹钟会被连带删掉。
- 每个 VALARM 带 `UID:<caldav_uid>-R<序号>`（序号按 `remind_at` 升序，从 1 起）。
  RFC 9074 建议闹钟有 UID，且序号来自排序后的位置——**不许用随机数或时间戳**，
  否则同一条目每次序列化字节都变、ETag 跟着变，客户端会无限重下（同
  `serialize` 那条「不许出现 `datetime.now()`」的硬约束）。
- `read_fields` **不读 VALARM**（保持现状）。后果说清楚：用户在 iPhone 上手加的闹钟
  不会出现在网页端——它只活在透传体里。这是刻意的，服务端不试图理解 Apple 的闹钟
  语义（snooze 链、`RELATED-TO`、`X-APPLE-*` 一整套）。
- `_serialize_fresh`（无透传体时）同样要输出服务端车道的 VALARM。

**iCal 订阅源（`/api/calendar/{token}.ics`）这一轮不动。** 它是「把截止日摊在日历上」
的只读视图，提醒走 CalDAV 那条双向车道。给它也塞一遍提醒会造出两条半通的路径，而
`calendar.py` 的 RFC 折行逻辑很脆，不值得为次要通道去动。后果：只订阅了 ics、没配
CalDAV 的设备收不到提醒。

### 11.11 已知行为

- reclassify 会删除目标邮件关联的条目并在下一轮按新规则重建，重建条目带新的
  `caldav_uid` 与资源名：iPhone 上该提醒表现为先消失、随后以新身份重新出现
  （列表短暂抖动）。属预期，不丢数据。
- 网页端改手动条目的日期会清掉手机上设的闹钟：due_date 变化 → 透传体时间簇被
  整体重写（11.6），以旧 DTSTART/DUE 为锚的客户端闹钟随之失效。这是时间簇规则的
  正确副作用，不是 bug。
- 同步不是实时的：iPhone 按「获取新数据」调度轮询（含手动下拉刷新），网页端改动
  不会立即推送到达手机；手机端到网页端的延迟同理。
