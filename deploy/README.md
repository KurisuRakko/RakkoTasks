# RakkoTasks 部署运维手册

面向 **Debian 12 + Docker + Cloudflare Tunnel** 的单机生产部署。
架构：`web`（FastAPI，:8000，同时托管前端 SPA）+ `worker`（定时同步）+ `cloudflared`（隧道），
数据落在宿主机 `data/` 目录（SQLite, WAL）。所有命令在**仓库根**执行。

---

## 1. 前置条件

- Debian 12 服务器，已安装 Docker 与 Compose 插件：

  ```bash
  apt-get update && apt-get install -y docker.io docker-compose-v2
  systemctl enable --now docker
  docker compose version   # 需输出 v2 版本号
  ```

- Cloudflare 账号，且域名 **rakko.cn** 已托管在 Cloudflare（NS 指向 Cloudflare）。
- 一个可用的 LLM API Key（默认 DeepSeek，见第 4 节）。
- 服务器能访问：`api.rakko.cn`（Phainon 鉴权）、LLM API、四个邮箱的 IMAP 端点。

## 2. Phainon 应用注册

1. 打开 Phainon 管理端 `phainon.rakko.cn`，新建一个应用：
   - `app_id`：`rakkotasks`
   - `allowed_origins`：`https://tasks.rakko.cn`
   - `allowed_return_urls`：`https://tasks.rakko.cn/`
2. 保存后，把前端地址 `https://tasks.rakko.cn` 登录一次（隧道建好后），
   到 Phainon 管理端的会话/用户列表里读取你的 `sub`，填入 `.env` 的 `ALLOWED_SUBS`
   （多个用户用英文逗号分隔）。
   > `ALLOWED_SUBS` 为空时所有人都会被 401 拒绝——这是刻意行为，先填好再对外。

## 3. Cloudflare Tunnel

1. Cloudflare 控制台 → Zero Trust → Networks → Tunnels → **Create a tunnel**
   （类型选 Cloudflared）。
2. 创建后复制隧道 `token`（形如 `eyJ...`），填入 `.env` 的 `TUNNEL_TOKEN`。
3. 在该隧道下添加 **Public Hostname**：
   - Subdomain / Domain：`tasks` / `rakko.cn`
   - Service 类型：`HTTP`，URL：`http://web:8000`
   （容器网络内服务名是 `web`，不要写成 `127.0.0.1`）
4. DNS 记录由隧道自动创建（CNAME `tasks.rakko.cn → <tunnel-id>.cfargotunnel.com`），无需手动加。

## 4. 配置

```bash
cp deploy/.env.example .env
vim .env
```

必须填写的项：

| 变量 | 取值方法 |
|---|---|
| `LLM_API_KEY` | DeepSeek 开放平台创建 API Key |
| `GMAIL_APP_PASSWORD` | 见第 6 节「Gmail」 |
| `ALLOWED_SUBS` | 见第 2 节 |
| `TUNNEL_TOKEN` | 见第 3 节 |

其余项保留默认值即可（默认值与 `backend/app/config.py` 一致）。
`FRONTEND_DIST` 已由镜像内置，**不要在 .env 里配置**。

## 5. 启动

```bash
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps
```

三个服务应全部 `running`。首次构建会拉 node:22-alpine / python:3.12-slim 基础镜像，需要几分钟。

> **TUNNEL_TOKEN 读取方式**：compose 在解析 `${TUNNEL_TOKEN}` 时，从**当前 shell 环境变量**
> 或 **deploy/.env** 读取，不会自动读仓库根的 `.env`。如果你只在仓库根 `.env` 填了 token，
> 先导出再启动：
>
> ```bash
> export TUNNEL_TOKEN=$(grep '^TUNNEL_TOKEN=' .env | cut -d= -f2-)
> docker compose -f deploy/docker-compose.yml up -d --build
> ```
>
> 或者始终用 `--env-file` 指定根目录 .env：
> `docker compose --env-file .env -f deploy/docker-compose.yml up -d --build`
> （两种情况任选其一；token 为空时 cloudflared 会启动失败并循环重启）。

## 6. 首次邮箱接入（关键）

四个账户：UNSW、个人 Outlook、公司 Outlook、Gmail。账户元数据存数据库，
凭据类配置走 env（Gmail）或 OAuth token（Microsoft，存数据库）。

### Gmail（应用专用密码）

1. Google 账号 → 安全性 → 开启**两步验证**。
2. 安全性 → 应用专用密码 → 生成 16 位密码，填入 `.env` 的 `GMAIL_APP_PASSWORD`。
3. 保存后**重启 web/worker 让新 env 生效**（`docker compose ... restart web worker`）。
4. 添加账户：

   ```bash
   docker compose -f deploy/docker-compose.yml run --rm web \
     python -m app.cli accounts add --kind gmail --name Gmail --email you@gmail.com
   ```

### 三个 Outlook（OAuth2 device code）

逐个添加（把邮箱换成自己的）：

```bash
docker compose -f deploy/docker-compose.yml run --rm web \
  python -m app.cli accounts add --kind microsoft --name UNSW --email your@unsw.edu.au
docker compose -f deploy/docker-compose.yml run --rm web \
  python -m app.cli accounts add --kind microsoft --name 个人Outlook --email you@outlook.com
docker compose -f deploy/docker-compose.yml run --rm web \
  python -m app.cli accounts add --kind microsoft --name 公司Outlook --email you@company.com
```

每个账户随后执行 `connect`，终端会打印 **device code 授权 URL 与代码**，
在任意浏览器打开并完成登录/MFA 后，token 自动保存回数据库：

```bash
docker compose -f deploy/docker-compose.yml run --rm web \
  python -m app.cli accounts connect your@unsw.edu.au
docker compose -f deploy/docker-compose.yml run --rm web \
  python -m app.cli accounts connect you@outlook.com
docker compose -f deploy/docker-compose.yml run --rm web \
  python -m app.cli accounts connect you@company.com
```

> 若某个账户需使用自己的 Azure 应用注册（默认用微软官方公共客户端
> `d3590ed6-...`），`add` 时追加 `--client-id <你的client_id>`。

### 核对

```bash
docker compose -f deploy/docker-compose.yml run --rm web \
  python -m app.cli accounts list
```

`status` 应为 `ok`。添加/授权完成后重启 worker 让下一轮同步立即开始：

```bash
docker compose -f deploy/docker-compose.yml restart worker
```

首次回补默认 180 天（`INITIAL_BACKFILL_DAYS`），Gmail 与新账户会先大量入库，
属正常现象；每条新邮件会各调用一次 LLM 过滤/摘要。

## 7. 验证

```bash
# 1) 本机存活探针（应输出 {"status":"ok"}）
curl http://127.0.0.1:8000/api/health

# 2) 手机浏览器打开 https://tasks.rakko.cn → Phainon 登录 → 看到任务列表
# 3) 页面「状态」页查看四账户健康、上次同步时间、LLM 待处理数
```

登录后 `ALLOWED_SUBS` 若还没填，会被 401 拒绝：按第 2 节取 sub 填入 `.env` 并重启 web。

## 8. 日常运维

```bash
# 日志（各服务单独看）
docker compose -f deploy/docker-compose.yml logs -f --tail=100 web
docker compose -f deploy/docker-compose.yml logs -f --tail=100 worker
docker compose -f deploy/docker-compose.yml logs -f --tail=100 cloudflared

# 升级：拉取新代码后重建（数据库在 volume 里，不受影响）
git pull
docker compose -f deploy/docker-compose.yml up -d --build

# 备份：整个 data/ 目录（含 SQLite WAL 文件）。最稳妥先停服务再拷：
docker compose -f deploy/docker-compose.yml stop
cp -a data/ /backup/rakkotasks-$(date +%F)/
docker compose -f deploy/docker-compose.yml start
# 在线备份可用 sqlite3 data/rakkotasks.db ".backup '/backup/rakkotasks.db'"

# 令牌掉线：状态页显示账户 error 时，重跑该账户的 connect 即可
docker compose -f deploy/docker-compose.yml run --rm web \
  python -m app.cli accounts connect <email>
```

故障排查要点：

- `web` 起不来：看 `docker compose logs web`；最常见是 `.env` 语法错误或端口被占。
- 前端 404：确认 `.env` 里**没有** `FRONTEND_DIST=` 空值（镜像内置了构建产物路径）。
- `cloudflared` 循环重启：`TUNNEL_TOKEN` 为空，按第 5 节导出后再启动。
- 手机打不开：确认隧道 Public Hostname 的 Service URL 是 `http://web:8000`，
  并在 Cloudflare 面板确认 DNS CNAME 已生成。
