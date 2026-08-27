# RakkoTasks

邮件驱动的个人 To-Do：每 15 分钟从四个邮箱（UNSW / 个人 Outlook / 公司 Outlook / Gmail）
增量拉取邮件，LLM 过滤广告与标题党、生成中文摘要任务与截止日期，手机网页勾选管理，
支持对整个邮件库的 AI 问答检索（带邮件引用）。

- 架构与全部设计决策：[docs/DESIGN.md](docs/DESIGN.md)
- 鉴权：Phainon（`tasks.rakko.cn` ← `api.rakko.cn`）
- 部署：Docker Compose + Cloudflare Tunnel，见 `deploy/`

## 快速开始

三行式指引（前置条件、Phainon 应用注册、Cloudflare Tunnel 等完整步骤见
[deploy/README.md](deploy/README.md)）：

1. 填配置：`cp deploy/.env.example .env`，填写 `LLM_API_KEY`、`GMAIL_APP_PASSWORD`、
   `ALLOWED_SUBS`、`TUNNEL_TOKEN` 等项。
2. 启动：`docker compose -f deploy/docker-compose.yml up -d --build`
   （web + worker + cloudflared 三个服务，公网经隧道走 HTTPS）。
3. 首次接入邮箱：`docker compose -f deploy/docker-compose.yml run --rm web python -m app.cli accounts add --kind gmail --name Gmail --email you@gmail.com`
   添加 Gmail；三个 Outlook 账户再分别执行 `accounts connect <email>` 完成设备码授权。
