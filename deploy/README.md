# RakkoTasks 部署运维手册

面向 **Debian 13 (trixie) + Docker + Cloudflare Tunnel** 的单机生产部署。
架构：`web`（FastAPI，:8000，同时托管前端 SPA）+ `worker`（定时同步），
数据落在宿主机 `data/` 目录（SQLite, WAL）。公网入口由**宿主机的 cloudflared
systemd 服务**统一提供，不在本项目的 compose 内（见第 3 节）。
所有命令在部署目录 **`/srv/rakkotasks`** 下执行。

compose 文件是**仓库根的 `compose.yaml`**，不在 `deploy/` 下——这样服务器上的
Dockge 才能把整个仓库识别成一个栈（它只认栈目录根的 `compose.yaml`）。因此所有
`docker compose` 命令都不需要 `-f`。服务器上 `/opt/stacks/rakkotasks` 是指向
`/srv/rakkotasks` 的软链接，Dockge 经它管理本栈。

> ⚠️ **不要在 Dockge 里编辑本栈的 compose。** Dockge 的在线编辑会直接写
> `/opt/stacks/rakkotasks/compose.yaml`，也就是本仓库的 `compose.yaml`，会让服务器上的
> git 工作区变脏，下次 `git pull` 直接冲突。改配置一律走 git：本地改 → push →
> 服务器 `git pull`。Dockge 对本栈只用来起停、看日志、看状态。
> 这条限制只针对本栈；Dockge 里新建的栈没有 git 介入，随便在线编辑。

---

## 1. 前置条件

- Debian 13 (trixie) 服务器，已安装 Docker 与 Compose 插件。用 Docker **官方仓库**
  的 `docker-ce` 套件，不要用 Debian 自带的 `docker.io`——后者版本老，且 compose 是
  已 EOL 的分离 Python 版：

  ```bash
  sudo apt-get install -y ca-certificates curl
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
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

## 3. 公网入口（宿主机 cloudflared）

公网入口**不在本项目的 compose 内**，而是由宿主机上的 cloudflared systemd 服务统一
提供。这台机器上所有对外服务共用同一条隧道（隧道名 `rakkoserver`），新增服务只需往
ingress 列表里加一条规则，**不再为每个项目单独开隧道，也不在路由器上做端口转发**。

隧道配置在 `/etc/cloudflared/config.yml`：

```yaml
tunnel: <隧道 UUID>
credentials-file: /etc/cloudflared/<UUID>.json

ingress:
  - hostname: tasks.rakko.cn
    service: http://127.0.0.1:8000
  - service: http_status:404
```

`service` 必须指向 `http://127.0.0.1:8000`：cloudflared 跑在宿主机上而不是容器网络里，
取的是 compose 把 `web` 发布到回环地址的那个端口。**不要写成 `http://web:8000`**——
那是容器网络内的服务名，宿主机解析不了。

DNS 记录用下面这条命令创建或改指向，不必手动在面板里加（`--overwrite-dns` 用于把已
存在的记录改指到本隧道）：

```bash
cloudflared tunnel route dns --overwrite-dns rakkoserver tasks.rakko.cn
```

改完 ingress 后重启服务生效：

```bash
sudo systemctl restart cloudflared
```

`deploy/.env.example` 已不再包含 `TUNNEL_TOKEN`；旧 `.env` 里留着这一行不影响运行，
可以删掉。

## 4. 配置

```bash
cp deploy/.env.example .env
vim .env
```

必须填写的项：

| 变量 | 取值方法 |
|---|---|
| `LLM_API_KEY` | DeepSeek 开放平台创建 API Key |

其余项保留默认值即可（默认值与 `backend/app/config.py` 一致）。
`FRONTEND_DIST` 已由镜像内置，**不要在 .env 里配置**。
首次接入的回补默认 7 天（`INITIAL_BACKFILL_DAYS`，.env.example 已设为 7）；
改大会让首轮抓取与 LLM 费用成倍增加，已在运行的部署改完要重启 worker 生效。

## 5. 启动

```bash
docker compose up -d --build
docker compose ps
```

两个服务（`web`、`worker`）应全部 `running`。首次构建会拉 node:22-alpine /
python:3.12-slim 基础镜像，需要几分钟。公网入口是宿主机的 cloudflared 服务，
不在这里，用 `systemctl is-active cloudflared` 单独确认。

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
使用。命令在服务器的部署目录 `/srv/rakkotasks` 下执行，账户一律用 `--user <sub|邮箱>` 指定归属：

> **先决条件**：使用者本人必须先登录一次网页（`https://tasks.rakko.cn` 完成
> Phainon 登录），否则服务器上还没有他的用户记录，CLI 无从归属。交互式命令
> （录入密码、授权码）必须用 `run --rm`（带 TTY），**不能用 `exec -T`**（无
> TTY 时交互输入无法工作）。

1. 查该用户的 sub / 邮箱（新用户登录后即可看到）：

   ```bash
   docker compose run --rm web \
     python -m app.cli users list
   ```

2. **Gmail（应用专用密码，交互式录入，不回显、不会进 shell history）**：

   ```bash
   docker compose run --rm web \
     python -m app.cli accounts add --user <sub或邮箱> --kind gmail \
       --name Gmail --email you@gmail.com
   ```

   事后改密码用 `accounts set-password`（同样交互式录入）：

   ```bash
   docker compose run --rm web \
     python -m app.cli accounts set-password --user <sub或邮箱> you@gmail.com
   ```

3. **微软（Outlook / Microsoft 365，原理见 6.1）**：`add` 后执行 `connect`
   走设备码授权——终端会打印 **device code 授权 URL 与代码**，在任意浏览器
   打开并完成登录/MFA 后，token 自动保存回数据库。需自定义 client_id 的账户
   在 `add` 时追加 `--client-id <你的client_id>`（Entra 配置要求见 6.1）：

   ```bash
   docker compose run --rm web \
     python -m app.cli accounts add --user <sub或邮箱> --kind microsoft \
       --name UNSW --email your@unsw.edu.au
   docker compose run --rm web \
     python -m app.cli accounts connect --user <sub或邮箱> your@unsw.edu.au
   ```

   > **若设备码被租户条件访问策略拒绝**（UNSW 等教育租户已禁用设备码，属常见）：
   > 改用**授权码流程**（标准浏览器交互），两步、非交互。第一步，生成授权链接
   > （默认重定向 `login.microsoftonline.com/common/oauth2/nativeclient`；如租户
   > 要求，可追加 `--redirect-uri urn:ietf:wg:oauth:2.0:oob`，UNSW 官方文档
   > 采用该值）：

   ```bash
   docker compose run --rm web \
     python -m app.cli accounts auth-url --user <sub或邮箱> your@unsw.edu.au
   ```

   第二步，用浏览器打开上面的链接、用该邮箱登录并完成 MFA；登录成功后浏览器
   会停在一个空白页，把地址栏的**完整 URL**（或页面上显示的授权码）粘贴回来
   （URL 含 `&`，务必用单引号包住）：

   ```bash
   docker compose run --rm web \
     python -m app.cli accounts auth-code --user <sub或邮箱> your@unsw.edu.au \
     '<完整URL或授权码>'
   ```

4. **停用账户**：`accounts remove` 等价于网页的「停用」——软删除（清除凭据、
   不再同步，已抓取的邮件与已生成的任务保留）；网页的「彻底删除」没有 CLI
   对应命令：

   ```bash
   docker compose run --rm web \
     python -m app.cli accounts remove --user <sub或邮箱> <email>
   ```

### 核对

```bash
docker compose run --rm web \
  python -m app.cli accounts list --user <sub或邮箱>
```

`status` 应为 `ok`（网页设置页 → 邮箱账户同样能看到）。添加/授权完成后重启
worker 让下一轮同步立即开始：

```bash
docker compose restart worker
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
docker compose logs -f --tail=100 web
docker compose logs -f --tail=100 worker
# 公网入口的日志在宿主机 systemd 里，不在 compose 内
sudo journalctl -u cloudflared -f

# 升级：拉取新代码后重建（数据库在 volume 里，不受影响）
git pull
docker compose up -d --build
# 升级时数据库由启动过程就地迁移，升级前建议先备份 data/。

# 备份：整个 data/ 目录（含 SQLite WAL 文件）。最稳妥先停服务再拷：
docker compose stop
cp -a data/ /backup/rakkotasks-$(date +%F)/
docker compose start
# 在线备份可用 sqlite3 data/rakkotasks.db ".backup '/backup/rakkotasks.db'"

# 令牌掉线：设置页该账户显示 error 时，主路径是使用者在网页 设置 → 邮箱账户 →
# 该账户 → 「重新授权」（Gmail 则在账户详情里更换应用专用密码）；CLI 的
# accounts auth-url / auth-code（或 connect）只作运维兜底，示例（--user 可填 sub 或邮箱）：
docker compose run --rm web \
  python -m app.cli accounts connect --user <sub或邮箱> <email>

# 停用某个邮箱账户：accounts remove 是软删除——停用并清除凭据、不再同步，
# 但保留已抓取的邮件与已生成的任务（设置页该账户显示「已停用」）
docker compose run --rm web \
  python -m app.cli accounts remove --user <sub或邮箱> <email>
```

故障排查要点：

- `web` 起不来：看 `docker compose logs web`；最常见是 `.env` 语法错误或端口被占。
- 前端 404：确认 `.env` 里**没有** `FRONTEND_DIST=` 空值（镜像内置了构建产物路径）。
- 公网 530 / 502：先 `systemctl is-active cloudflared`，再 `sudo journalctl -u cloudflared -n 50`。
  最常见是 ingress 的 `service` 写错（必须是 `http://127.0.0.1:8000`，不是 `http://web:8000`），
  或者 `web` 容器没起来导致回环端口无人监听。
- 手机打不开：确认 `/etc/cloudflared/config.yml` 里有 `tasks.rakko.cn` 的 ingress 规则，
  且 DNS CNAME 指向本隧道（`cloudflared tunnel route dns --overwrite-dns rakkoserver tasks.rakko.cn` 可重设）。

### 原件归档（.eml）

worker 把每轮从 IMAP 拉到的新邮件（去重之后）的**原始字节**原样写成 `.eml` 落盘，
附件原始字节天然包含在内——即数据库之外另存一份不依赖邮箱服务器的原件副本。写入
只发生在 `worker`；`web` 不挂载、不读写归档目录。

**目录结构**（`<根>` = 容器内 `EMAIL_ARCHIVE_DIR`，compose 固定为 `/archive`，对应
宿主机上的 `EMAIL_ARCHIVE_HOST_DIR`）：

```text
<根>/<账户邮箱>/<YYYY-MM-DD>/<HHMMSS>_<主题>_<12位哈希>.eml
<根>/<账户邮箱>/undated/<主题>_<12位哈希>.eml      # 缺 Date 头或无法解析的邮件
```

- 日期与时分秒按**发信时间**（邮件 Date 头）换算到 `LOCAL_TIMEZONE` 的本地时间。
- 账户邮箱转小写，非 `[a-z0-9@._+-]` 字符替换为 `_`；主题只保留字母数字（含中日韩
  文字）、`_`、`-`，其余替换为 `_`，截到 50 字；12 位哈希取自 Message-ID，保证同一封
  邮件重复写入时路径不变（覆盖而非重复）。
- 权限：目录 `0700`、文件 `0600`（容器内 uid 1000 写）。

**何时写、何时删**

一句话：**待办留什么，归档就留什么**。进入待办的邮件保留原件，被过滤的邮件删除原件。

- 写：每轮同步拉到**新**邮件时写一份。
- 删：LLM 判为被过滤的邮件（`filtered=True`，不生成待办）并成功落库后删除对应文件；
  删完若当天目录为空一并删除。被过滤的邮件因此会在盘上短暂存在（从拉取到分类完成，
  通常同一轮内）。过滤由 LLM 按四类判定——回执/确认、可选活动推广、
  广告/营销/newsletter、标题党，判定规则见 docs/DESIGN.md §4.1。
- 保留：进入待办的邮件保留；LLM 分类失败（`llm_state="error"`）暂按保留处理——之后
  重试若被过滤，届时再删。
- 失败处理：写盘失败只计数并告警（日志只含账户目录名与异常类名，不含主题、正文、
  路径），不中断同步、不影响入库。每轮同步摘要里有
  `archive: {written, failed, discarded}`。

**已知限制**

1. 只对功能上线后新拉到的邮件生效，存量邮件不会补归档（原文从未落库）。
2. 通过 `reclassify` 把已被过滤的邮件改判为进入待办，原件已删，不会恢复。
3. 账户停用或彻底删除都**不会**删除归档文件；归档是独立的原件留存，需手动清理。
4. 归档是全部进入待办的邮件（含附件）的明文副本，备份与访问控制要按敏感数据对待；
   归档目录不在 `data/` 下时，上面备份小节里的 `cp -a data/` 不会捎带它，需单独备份。

**启用步骤**

```bash
mkdir -p <宿主机归档目录>
sudo chown 1000:1000 <宿主机归档目录>   # 宿主机用户 uid 恰为 1000 时可省
chmod 700 <宿主机归档目录>
# 在仓库根 .env 写入 EMAIL_ARCHIVE_HOST_DIR=<宿主机归档目录>
docker compose up -d worker
```

若不预建目录，Docker 会以 root 身份自动创建挂载源，容器内 uid 1000 无权写入，日志会
出现「原件归档失败（…）：PermissionError」，同步本身不受影响。

## 9. 容器以非 root 运行

镜像内进程以 **uid 1000**（`app` 用户）运行，不以 root 跑业务进程，降低容器
逃逸后的影响面；`/data` 数据卷已 chown 给该用户。

- **Linux 宿主机已有旧部署的**：旧镜像以 root 写入过 `data/`，文件属主是 root，
  升级镜像后新进程（uid 1000）将无法读写，需在升级前执行一次：
  `sudo chown -R 1000:1000 data/`
  ——若归档目录不在 `data/` 下（`EMAIL_ARCHIVE_HOST_DIR` 指向别处），也要对它单独
  chown 一次，否则 worker 写归档会报 PermissionError（见第 8 节「原件归档」）。
- **macOS Docker Desktop（VirtioFS）**：文件权限映射宽松，通常无需处理；若
  启动后 web/worker 报权限错误，同样执行上面一条 chown 即可。

## 10. 宿主机防火墙与端口暴露

宿主机防火墙是 **nftables**，规则在 `/etc/nftables.conf` 的 `table inet filter`，
input 链默认 `policy drop`，只放行内网网段与 Tailscale 接口。

> **Docker 发布的端口不受 input 链保护。** 容器端口走 DNAT + FORWARD，**不经过 INPUT
> 链**，nftables 的 input 规则对它完全无效。「ufw 挡不住 Docker」说的就是这件事，
> 换成 nftables 一样挡不住。

因此：

- 本部署的 `web` 绑定在 `127.0.0.1:8000`，只有宿主机自己（含 cloudflared）连得上，
  对外暴露面为零，**不需要任何防火墙规则**。
- 将来若要把某个容器端口暴露到 `127.0.0.1` 以外，**必须**二选一：在 compose 里绑定
  具体地址（如 `10.8.8.88:PORT:PORT`），或者往 `DOCKER-USER` 链加规则。
  **绝不能依赖 input 链的 policy drop 去保护容器端口。**
- 重载防火墙用 `sudo systemctl reload nftables`。配置文件用的是
  `delete table inet filter` 惯用法而非 `flush ruleset`——后者会连 Docker 建的表一起
  清空，导致容器网络静默中断。
