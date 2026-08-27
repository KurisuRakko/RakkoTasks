# RakkoTasks

邮件驱动的个人 To-Do：每 15 分钟从四个邮箱（UNSW / 个人 Outlook / 公司 Outlook / Gmail）
增量拉取邮件，LLM 过滤广告与标题党、生成中文摘要任务与截止日期，手机网页勾选管理，
支持对整个邮件库的 AI 问答检索（带邮件引用）。

- 架构与全部设计决策：[docs/DESIGN.md](docs/DESIGN.md)
- 鉴权：Phainon（`tasks.rakko.cn` ← `api.rakko.cn`）
- 部署：Docker Compose + Cloudflare Tunnel，见 `deploy/`
