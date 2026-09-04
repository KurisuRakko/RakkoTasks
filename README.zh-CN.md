<p align="right"><a href="README.md"><kbd>English</kbd></a>&nbsp;|&nbsp;<strong>中文</strong></p>

# RakkoTasks

**把邮箱变成待办清单。** RakkoTasks 是一个自托管的个人任务系统：它定时从你的多个邮箱拉取邮件，
用大语言模型过滤掉广告与噪音，把真正需要你行动的邮件提炼成一条条中文待办（标题、摘要、分类、
截止日期、重要度），然后在手机或电脑的网页上勾选管理。你也可以手动添加待办，并把所有有截止日的
任务订阅到系统日历里。

它面向的是这样一个场景：学校通知、账单提醒、工作邮件和个人邮件散落在四个邮箱里，
每天真正需要做的事就藏在几百封邮件中间。RakkoTasks 负责把它们挑出来、排好序、等你处理。

## 功能

- **邮件驱动的待办**：每 15 分钟增量同步 Outlook / Microsoft 365（OAuth2 + XOAUTH2）与 Gmail（应用专用密码）邮箱，
  LLM 判断哪些邮件是需要行动的任务，生成中文标题、摘要、分类（学业 / 工作 / 个人 / 账单 / 其他）、截止日期与重要度。
- **按时间分组**：任务页按「今天 / 本周 / 重要 / 无期限」分组，逾期标红；源邮件是今天发来的条目左侧显示小蓝点，过了当天自动消失。
- **手动待办**：右下角 `+` 直接记一条任务，第一行是标题、其余行是详情，可选分类与截止日期；手动条目可随时编辑或删除。
- **AI 详情**：点开任务时，模型会翻阅你的其他邮件找背景（比如同一件事的前几封通知），写出详情并列出关联邮件，可一键「复制给 AI」继续追问。
- **AI 搜索**：对整个邮件库自然语言提问，回答带邮件引用，基于 SQLite FTS5 全文检索。
- **日历订阅**：每个用户一条带密钥的 iCalendar 订阅链接，有截止日的未完成任务以全天事件出现在系统日历里，完成后自动消失，截止日当天 10:00 提醒。iPhone 可一键 `webcal://` 订阅。
- **原邮件查看**：在任务里直接看原邮件，HTML 经服务端消毒并在沙箱 iframe 中渲染，远程图片默认不加载。
- **多用户**：通过自建的 Phainon 鉴权服务登录，每个用户只看到自己的邮箱、邮件与任务。
- **PWA**：可添加到手机主屏，深浅色跟随系统。

## 工作原理

```
邮箱 (IMAP) ──► worker 定时同步 ──► SQLite (WAL + FTS5)
                      │                     ▲
                      ▼                     │
                 LLM 过滤/提炼          FastAPI 后端 ◄──► React 前端 (PWA)
                                            │
                                    iCalendar 订阅 / AI 搜索
```

- `backend/`：FastAPI 应用、同步 worker、LLM 管线、命令行管理工具（添加邮箱、重分类等）。
- `frontend/`：React + TypeScript 单页应用，构建产物由后端同源托管。
- `deploy/`：Docker Compose 与 Cloudflare Tunnel 的生产部署。
- 全部架构与设计决策见 [docs/DESIGN.md](docs/DESIGN.md)。

### 关于安全

LLM 会阅读不可信的邮件正文，因此存在提示注入的风险。RakkoTasks 在模型输入侧做了注入检测，
在输出侧剥离所有会自动发起外部请求的 Markdown 元素（如图片），前端渲染层再做一次白名单过滤，
避免攻击者借邮件诱导模型把你的数据带出去。原邮件 HTML 一律经服务端消毒后在沙箱中显示。
细节见 [docs/DESIGN.md](docs/DESIGN.md) 第 7 节。

## 快速开始

三行式指引（前置条件、Phainon 应用注册、Cloudflare Tunnel 等完整步骤见
[deploy/README.md](deploy/README.md)）：

1. 填配置：`cp deploy/.env.example .env`，填写 `LLM_API_KEY`、`TUNNEL_TOKEN` 等项。
2. 启动：`docker compose -f deploy/docker-compose.yml up -d --build`
   （web + worker + cloudflared 三个服务，公网经隧道走 HTTPS）。
3. 首次接入邮箱：先在网页上登录一次（后端自动建用户记录），再用
   `docker compose -f deploy/docker-compose.yml run --rm web python -m app.cli users list`
   查到自己的 sub，然后 `python -m app.cli accounts add --user <sub> --kind gmail --name Gmail --email you@gmail.com`
   添加 Gmail（按提示交互式输入应用专用密码）；Outlook 账户分别执行
   `accounts connect --user <sub> <email>` 完成设备码授权。完整步骤见
   [deploy/README.md](deploy/README.md) 第 6 节。

### 本地开发

```bash
cd backend && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]' && .venv/bin/python -m pytest -q
```

```bash
cd frontend && npm ci && npm run typecheck && npx vitest run && npm run build
```

## 致谢与使用的开源软件

RakkoTasks 站在许多开源项目的肩膀上。以下按用途列出，感谢这些项目的作者与维护者。

### Mozilla Thunderbird

接入 Outlook / Microsoft 365 邮箱时，默认使用的 Microsoft OAuth 客户端标识
`9e5f94bc-e8a4-4e73-b8be-63364c29d753` 是 [Mozilla Thunderbird](https://www.thunderbird.net/)
向微软注册的公共客户端。这与 Thunderbird 自身访问 IMAP 时所用的是同一个标识，
也是目前个人用户不注册 Azure 应用就能用 OAuth2 访问 Outlook IMAP 的通行做法。
RakkoTasks 不包含 Thunderbird 的任何代码；如果你希望使用自己注册的 Azure 应用，
可以在添加账户时用 `--client-id` 覆盖。Thunderbird 以 MPL 2.0 许可发布。

### 后端

- [FastAPI](https://fastapi.tiangolo.com/) 与 [Uvicorn](https://www.uvicorn.org/)：HTTP 服务
- [SQLAlchemy](https://www.sqlalchemy.org/)：ORM 与数据库访问
- [SQLite](https://www.sqlite.org/) 及其 FTS5 扩展：存储与全文检索
- [Pydantic](https://docs.pydantic.dev/) 与 pydantic-settings：数据校验与配置
- [MSAL for Python](https://github.com/AzureAD/microsoft-authentication-library-for-python)：Microsoft OAuth2 设备码流程与令牌缓存
- [nh3](https://github.com/messense/nh3)（基于 [ammonia](https://github.com/rust-ammonia/ammonia)）：邮件 HTML 消毒
- [openai-python](https://github.com/openai/openai-python)：OpenAI 兼容接口的 LLM 客户端（默认对接 DeepSeek）
- [httpx](https://www.python-httpx.org/)：HTTP 客户端
- 测试：[pytest](https://pytest.org/)、pytest-asyncio、[respx](https://lundberg.github.io/respx/)

### 前端

- [React](https://react.dev/) 与 [React Router](https://reactrouter.com/)
- [MUI](https://mui.com/)（Material UI）与 [Emotion](https://emotion.sh/)：组件与样式
- [react-markdown](https://github.com/remarkjs/react-markdown) 与 [remark-breaks](https://github.com/remarkjs/remark-breaks)：Markdown 渲染
- [Vite](https://vite.dev/)、[vite-plugin-pwa](https://vite-pwa-org.netlify.app/) 与 [Workbox](https://developer.chrome.com/docs/workbox)：构建与 PWA
- [TypeScript](https://www.typescriptlang.org/)
- 测试：[Vitest](https://vitest.dev/)、[Testing Library](https://testing-library.com/)、[jsdom](https://github.com/jsdom/jsdom)

### 部署

- [Docker](https://www.docker.com/) 与 Docker Compose
- [cloudflared](https://github.com/cloudflare/cloudflared)：Cloudflare Tunnel 客户端

鉴权服务 Phainon 为作者自建的基础设施，不属于本仓库。
