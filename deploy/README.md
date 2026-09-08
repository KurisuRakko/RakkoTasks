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
- 构建走 BuildKit（Docker 23+ 默认启用），deploy/Dockerfile.dockerignore 负责裁剪构建上下文（排除 data/、.env、node_modules 等）。

## 2. Phainon 应用注册

1. 打开 Phainon 管理端 `phainon.rakko.cn`，新建一个应用：
   - `app_id`：`rakkotasks`
   - `allowed_origins`：`https://tasks.rakko.cn`
   - `allowed_return_urls`：`https://tasks.rakko.cn/`
2. 保存后即可使用：能登进 Phainon 的账号即可访问本站，首次登录时后端自动创建
   用户记录，无需任何白名单配置。
   > **风险提示**：若 Phainon（Priestess）允许自助注册，则任何注册者都能进来使用
   > 本站（新用户没有任何邮箱账户，看到的是空列表）。需要收紧时应在 Priestess
   > 侧控制账号发放，本站不做审批。

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
| `TUNNEL_TOKEN` | 见第 3 节 |

其余项保留默认值即可（默认值与 `backend/app/config.py` 一致）。
`FRONTEND_DIST` 已由镜像内置，**不要在 .env 里配置**。
首次接入的回补默认 7 天（`INITIAL_BACKFILL_DAYS`，.env.example 已设为 7）；
改大会让首轮抓取与 LLM 费用成倍增加，已在运行的部署改完要重启 worker 生效。

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

## 6. 邮箱接入

邮箱账户由**使用者本人在网页设置页自助接入**（主路径，见 6.1），凭据经 HTTPS
提交后存库，不再需要管理员在服务器上代劳；CLI 保留为运维兜底（见 6.2），与网页
共用同一服务层、语义一致。多用户各自接入自己的账户，互不可见。

### 6.1 网页自助接入（主路径）

使用者登录 `https://tasks.rakko.cn` → **设置 → 邮箱账户 → 添加邮箱**，按账户类型操作：

**Gmail（应用专用密码）**

1. 先在 Google 账号里生成应用专用密码：账号 → 安全性 → 开启**两步验证**；
   再到 安全性 → 应用专用密码 → 生成 16 位密码。
2. 把 16 位密码填进添加向导。密码经 HTTPS 提交后存库，**不会再显示**（任何
   API 都不会返回它）；之后可在账户详情里修改。

**Outlook / Microsoft 365（个人、学校、公司邮箱都一样，OAuth2 授权码流程）**

1. 向导点「生成授权链接」；
2. 新标签页打开链接，用该邮箱登录并完成 MFA；
3. 登录成功后浏览器停在一个**空白页**（地址以
   `login.microsoftonline.com/common/oauth2/nativeclient` 开头，这是正常现象）；
4. 把地址栏的**完整地址**复制粘回向导，完成。

> **为什么要手动粘回地址**：默认使用 Mozilla Thunderbird 注册的公共客户端 ID
> （`9e5f94bc-e8a4-4e73-b8be-63364c29d753`），它注册的回跳地址不是本站，微软
> 无法自动回跳，只能这样两步完成授权。设备码流程被 UNSW 等租户的条件访问策略
> 禁用，网页不提供。
>
> **常见失败**：授权链接过期 / 用户在微软侧点「拒绝」→ 重新授权；租户要求管理员
> 同意 → 在向导「高级」里填自己注册的 client_id（需在 Entra 里把应用配置为
> **公共客户端**并授予 `IMAP.AccessAsUser.All` 委托权限；不要用 Microsoft Office
> 的 `d3590ed6-…`，那是第一方应用，会报 `AADSTS65002`）。

**接入后**：首轮同步在**下一轮定时任务**开始时执行（最多 15 分钟，不做「授权完成
立即同步」），回补最近 `INITIAL_BACKFILL_DAYS`（默认 7）天。设置页账户卡片的
状态 Chip 含义：

- 待授权：微软授权还没完成（还差把地址粘回向导）；
- 等待首次同步：凭据已就绪，等下一轮定时任务开始首轮回补；
- 正常：同步正常；
- 出错：凭据失效或同步失败，卡片上有错误信息，可「重新授权」；
- 已停用：账户被停用（见下）。

移除账户（账户详情页，二选一）：

- **停用**：只删除凭据、停止同步；已抓取的邮件与已生成的任务全部保留，
  之后可重新启用（需重新填凭据 / 重新授权）；
- **彻底删除**：连带该账户的全部邮件、以及由这些邮件生成的任务一起删除，
  **不可恢复**（手动条目不受影响）。

### 6.2 命令行兜底（运维用）

CLI 与网页共用同一服务层、语义一致；日常接入请走 6.1，CLI 供运维与脚本化场景
使用。命令在服务器仓库根执行，账户一律用 `--user <sub|邮箱>` 指定归属：

> **先决条件**：使用者本人必须先登录一次网页（`https://tasks.rakko.cn` 完成
> Phainon 登录），否则服务器上还没有他的用户记录，CLI 无从归属。交互式命令
> （录入密码、授权码）必须用 `run --rm`（带 TTY），**不能用 `exec -T`**（无
> TTY 时交互输入无法工作）。

1. 查该用户的 sub / 邮箱（新用户登录后即可看到）：

   ```bash
   docker compose -f deploy/docker-compose.yml run --rm web \
     python -m app.cli users list
   ```

2. **Gmail（应用专用密码，交互式录入，不回显、不会进 shell history）**：

   ```bash
   docker compose -f deploy/docker-compose.yml run --rm web \
     python -m app.cli accounts add --user <sub或邮箱> --kind gmail \
       --name Gmail --email you@gmail.com
   ```

   事后改密码用 `accounts set-password`（同样交互式录入）：

   ```bash
   docker compose -f deploy/docker-compose.yml run --rm web \
     python -m app.cli accounts set-password --user <sub或邮箱> you@gmail.com
   ```

3. **微软（Outlook / Microsoft 365，原理见 6.1）**：`add` 后执行 `connect`
   走设备码授权——终端会打印 **device code 授权 URL 与代码**，在任意浏览器
   打开并完成登录/MFA 后，token 自动保存回数据库。需自定义 client_id 的账户
   在 `add` 时追加 `--client-id <你的client_id>`（Entra 配置要求见 6.1）：

   ```bash
   docker compose -f deploy/docker-compose.yml run --rm web \
     python -m app.cli accounts add --user <sub或邮箱> --kind microsoft \
       --name UNSW --email your@unsw.edu.au
   docker compose -f deploy/docker-compose.yml run --rm web \
     python -m app.cli accounts connect --user <sub或邮箱> your@unsw.edu.au
   ```

   > **若设备码被租户条件访问策略拒绝**（UNSW 等教育租户已禁用设备码，属常见）：
   > 改用**授权码流程**（标准浏览器交互），两步、非交互。第一步，生成授权链接
   > （默认重定向 `login.microsoftonline.com/common/oauth2/nativeclient`；如租户
   > 要求，可追加 `--redirect-uri urn:ietf:wg:oauth:2.0:oob`，UNSW 官方文档
   > 采用该值）：

   ```bash
   docker compose -f deploy/docker-compose.yml run --rm web \
     python -m app.cli accounts auth-url --user <sub或邮箱> your@unsw.edu.au
   ```

   第二步，用浏览器打开上面的链接、用该邮箱登录并完成 MFA；登录成功后浏览器
   会停在一个空白页，把地址栏的**完整 URL**（或页面上显示的授权码）粘贴回来
   （URL 含 `&`，务必用单引号包住）：

   ```bash
   docker compose -f deploy/docker-compose.yml run --rm web \
     python -m app.cli accounts auth-code --user <sub或邮箱> your@unsw.edu.au \
     '<完整URL或授权码>'
   ```

4. **停用账户**：`accounts remove` 等价于网页的「停用」——软删除（清除凭据、
   不再同步，已抓取的邮件与已生成的任务保留）；网页的「彻底删除」没有 CLI
   对应命令：

   ```bash
   docker compose -f deploy/docker-compose.yml run --rm web \
     python -m app.cli accounts remove --user <sub或邮箱> <email>
   ```

### 核对

```bash
docker compose -f deploy/docker-compose.yml run --rm web \
  python -m app.cli accounts list --user <sub或邮箱>
```

`status` 应为 `ok`（网页设置页 → 邮箱账户同样能看到）。添加/授权完成后重启
worker 让下一轮同步立即开始：

```bash
docker compose -f deploy/docker-compose.yml restart worker
```

首次回补默认 7 天（`INITIAL_BACKFILL_DAYS`，改大见 .env.example 注释），新账户
首轮先入库最近 7 天的邮件，属正常现象；每条新邮件会各调用一次 LLM 过滤/摘要。

## 7. 验证

```bash
# 1) 本机存活探针（应输出 {"status":"ok"}）
curl http://127.0.0.1:8000/api/health

# 2) 手机浏览器打开 https://tasks.rakko.cn → Phainon 登录 → 看到任务列表
# 3) 设置页 → 邮箱账户查看各账户状态、上次同步时间、LLM 待处理数
```

登录即用：首次登录会自动创建用户记录（页面显示空账户列表属正常，邮箱账户由
使用者本人按第 6 节在网页设置页接入）。

## 8. 日常运维

```bash
# 日志（各服务单独看）
docker compose -f deploy/docker-compose.yml logs -f --tail=100 web
docker compose -f deploy/docker-compose.yml logs -f --tail=100 worker
docker compose -f deploy/docker-compose.yml logs -f --tail=100 cloudflared

# 升级：拉取新代码后重建（数据库在 volume 里，不受影响）
git pull
docker compose -f deploy/docker-compose.yml up -d --build
# 升级时数据库由启动过程就地迁移，升级前建议先备份 data/。

# 备份：整个 data/ 目录（含 SQLite WAL 文件）。最稳妥先停服务再拷：
docker compose -f deploy/docker-compose.yml stop
cp -a data/ /backup/rakkotasks-$(date +%F)/
docker compose -f deploy/docker-compose.yml start
# 在线备份可用 sqlite3 data/rakkotasks.db ".backup '/backup/rakkotasks.db'"

# 令牌掉线：设置页该账户显示 error 时，主路径是使用者在网页 设置 → 邮箱账户 →
# 该账户 → 「重新授权」（Gmail 则在账户详情里更换应用专用密码）；CLI 的
# accounts auth-url / auth-code（或 connect）只作运维兜底，示例（--user 可填 sub 或邮箱）：
docker compose -f deploy/docker-compose.yml run --rm web \
  python -m app.cli accounts connect --user <sub或邮箱> <email>

# 停用某个邮箱账户：accounts remove 是软删除——停用并清除凭据、不再同步，
# 但保留已抓取的邮件与已生成的任务（设置页该账户显示「已停用」）
docker compose -f deploy/docker-compose.yml run --rm web \
  python -m app.cli accounts remove --user <sub或邮箱> <email>
```

故障排查要点：

- `web` 起不来：看 `docker compose logs web`；最常见是 `.env` 语法错误或端口被占。
- 前端 404：确认 `.env` 里**没有** `FRONTEND_DIST=` 空值（镜像内置了构建产物路径）。
- `cloudflared` 循环重启：`TUNNEL_TOKEN` 为空，按第 5 节导出后再启动。
- 手机打不开：确认隧道 Public Hostname 的 Service URL 是 `http://web:8000`，
  并在 Cloudflare 面板确认 DNS CNAME 已生成。

## 9. 容器以非 root 运行

镜像内进程以 **uid 1000**（`app` 用户）运行，不以 root 跑业务进程，降低容器
逃逸后的影响面；`/data` 数据卷已 chown 给该用户。

- **Linux 宿主机已有旧部署的**：旧镜像以 root 写入过 `data/`，文件属主是 root，
  升级镜像后新进程（uid 1000）将无法读写，需在升级前执行一次：
  `sudo chown -R 1000:1000 data/`
- **macOS Docker Desktop（VirtioFS）**：文件权限映射宽松，通常无需处理；若
  启动后 web/worker 报权限错误，同样执行上面一条 chown 即可。
