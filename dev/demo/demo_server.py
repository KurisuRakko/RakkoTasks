"""用法：bash dev/demo/run.sh [--port 8123]（入口；先构建前端再 exec 本文件）。

本机演示站：真后端（本仓库 backend/）+ 确定性的虚构数据 + 假 Phainon，
前端产物由 frontend/dist-demo 托管，只监听 127.0.0.1。

为什么假 Phainon 是**两个**进程内服务，而不是一个：
- 8124 给后端调用——后端 app/auth.py 用同步 httpx 打 {phainon_api_base}/auth/priestess/oidc/me，
  若把后端指回 8123 就等于自己调自己；uvicorn 是单事件循环，同步调用会占死工作线程。
- 8123 给浏览器调用——前端在 VITE_PHAINON_API_BASE='' 下用**同源相对路径**请求
  /auth/priestess/oidc/*（frontend/src/lib/phainon.ts:8），这些路径必须先于后端路由被拦下。
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import secrets
import socket
import sys
import threading
from pathlib import Path
from urllib.parse import quote

# 由脚本自身位置推出仓库根（<repo>/dev/demo/demo_server.py → <repo>），不依赖调用时的 cwd
REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = REPO_ROOT / "backend"
DATA_DIR = REPO_ROOT / "dev" / "demo" / "data"
DIST_DIR = REPO_ROOT / "frontend" / "dist-demo"

HOST = "127.0.0.1"  # 写死：演示站只给本机看，不提供改 host 的参数
DEFAULT_PORT = 8123
DEFAULT_PHAINON_PORT = 8124

# 假 Phainon 的固定答案：任何凭证都登录成同一个虚构用户
DEMO_USER = {"sub": "demo-user", "name": "演示用户", "email": "demo@example.com"}
# 必须与后端 phainon_app_id 一致，否则 app/auth.py:57 的 app_id 比对会判非法
DEMO_APP_ID = "rakkotasks"

OIDC_PREFIX = "/auth/priestess/oidc"
# 构建产物里的 SW 脚本路径：vite-plugin-pwa 的 generateSW 模式固定产出根目录 sw.js
# 与 workbox-<hash>.js（frontend/dist-demo/ 实测两者都在，见 frontend/vite.config.ts:11-40）
SW_SCRIPT_PATHS = ("/sw.js",)


def _local_iana_timezone() -> str:
    """进程本地时区的 IANA 名（后端的 local_timezone 只认 IANA 名）。

    本脚本在本机跑，进程时区即用户时区，所以按系统时区库反查名字：先看 /etc/localtime
    指向哪个 zoneinfo 文件（macOS 与 Linux 的两种前缀都剥掉），再用 envi TZ 兜底。
    名字必须过一遍 ZoneInfo 才算数——后端 _resolve_today 对非法名有 UTC 兜底，
    但静默退回 UTC 会让「今天」在 UTC 以东的时区差一天，宁可这里查不准也别瞎猜。
    """
    from zoneinfo import ZoneInfo

    candidates: list[str] = []
    try:
        target = str(Path("/etc/localtime").resolve())
    except OSError:
        target = ""
    for prefix in ("/var/db/timezone/zoneinfo/", "/usr/share/zoneinfo/"):
        if target.startswith(prefix):
            candidates.append(target.removeprefix(prefix))
    candidates.append(os.environ.get("TZ", ""))
    for name in candidates:
        if not name or name.startswith("/"):
            continue
        try:
            ZoneInfo(name)
        except Exception:
            continue
        return name
    return "UTC"


def _inject_config() -> None:
    """在 import 后端之前显式赋值全部演示用配置项。

    os.environ 的优先级高于 pydantic-settings 的 env_file（实测），所以就算仓库根 /
    backend/ / 当前目录放了 .env，也覆盖不掉这里的值——演示站的 Phainon 地址永远是
    本进程的假 Phainon。绝不打印任何配置值。
    """
    # 先 chdir：env_file=".env"（backend/app/config.py:10）按 cwd 解析，换到数据目录后
    # 仓库里的 .env 一律不生效
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    os.chdir(DATA_DIR)

    os.environ["DATABASE_PATH"] = str(DATA_DIR / "demo.sqlite3")
    # 后端静态托管目录配置项：Settings.frontend_dist（backend/app/config.py:32）；
    # 留空时后端会按自己的 __file__ 回退到 <repo>/backend/frontend/dist（app/api.py:641-646），
    # 那不是本仓库的位置，SPA 兜底根本不会挂上，所以必须显式指向构建产物
    os.environ["FRONTEND_DIST"] = str(DIST_DIR)
    # 后端 Phainon 地址配置项：Settings.phainon_api_base（backend/app/config.py:27），env 名 PHAINON_API_BASE
    os.environ["PHAINON_API_BASE"] = f"http://{HOST}:{DEFAULT_PHAINON_PORT}"
    os.environ["PHAINON_APP_ID"] = DEMO_APP_ID
    os.environ["FRONTEND_ORIGIN"] = f"http://{HOST}:{DEFAULT_PORT}"
    os.environ["LOCAL_TIMEZONE"] = _local_iana_timezone()
    # 关掉 LLM：get_llm 在 base_url / api_key 任一为空时直接抛 RuntimeError
    # （backend/app/llm.py:420-421），根本不会建立出站连接；占位串保证这条判断命中
    os.environ["LLM_BASE_URL"] = ""
    os.environ["LLM_API_KEY"] = "demo-no-llm"
    os.environ["LLM_MODEL"] = ""
    # 不启邮件归档目录：留空即关闭（backend/app/config.py:45）
    os.environ["EMAIL_ARCHIVE_DIR"] = ""


_inject_config()

# import 后端之前插 sys.path 头部：防止解释器环境里 editable 安装的另一份 app 抢先命中
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import uvicorn  # noqa: E402
from fastapi import FastAPI, Request  # noqa: E402
from fastapi.responses import JSONResponse, RedirectResponse, Response  # noqa: E402
from starlette.middleware.base import BaseHTTPMiddleware  # noqa: E402
from starlette.types import ASGIApp  # noqa: E402

import app as backend_package  # noqa: E402  （下面那行打印的就是它的 __file__）
from app.api import create_app  # noqa: E402
from app.config import Settings  # noqa: E402
from app.db import init_db, make_engine, make_session_factory  # noqa: E402

import seed  # noqa: E402  （同目录模块；sys.path 已含 backend/，这里补本文件所在目录）

logger = logging.getLogger("demo")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

# 假 Phainon 收到的 introspection 次数：启动日志里报一次，便于确认鉴权确实走了它
_introspect_count = 0
_introspect_lock = threading.Lock()

# 自毁 SW：构建产物里注册的是真 Workbox SW，演示站必须让它当场注销自己并清空缓存，
# 否则评审期间浏览器会一直拿旧缓存，测不出页面真实行为
_SELF_DESTRUCT_SW = """// demo server: self-destructing service worker
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) {
  event.waitUntil(
    Promise.all([
      caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (key) { return caches.delete(key); }));
      }),
      self.registration
        .unregister()
        .then(function () { return self.clients.claim(); })
        .then(function () {
          return self.clients.matchAll({ type: 'window' }).then(function (clients) {
            clients.forEach(function (client) { client.navigate(client.url); });
          });
        }),
    ])
  );
});
"""


def _token() -> str:
    return "demo-" + secrets.token_urlsafe(24)


# ── 8123：给浏览器用的假 Phainon（前端同源请求 /auth/priestess/oidc/*）
# 调用方：frontend/src/lib/phainon.ts:33/54/83/134/151（startLogin/consumeCallback/doRefresh/logout/getMe）
browser_phainon = FastAPI(title="Fake Phainon (browser)", docs_url=None, redoc_url=None, openapi_url=None)


@browser_phainon.get(f"{OIDC_PREFIX}/login")
def oidc_login(app_id: str = "", return_to: str = "") -> Response:
    """登录页替身：不弹任何界面，直接带着 login_code 回跳 return_to。"""
    if app_id != DEMO_APP_ID or not return_to:
        return JSONResponse({"error": "invalid_request"}, status_code=400)
    separator = "&" if "#" in return_to else "#"
    return RedirectResponse(f"{return_to}{separator}login_code={quote(_token())}", status_code=302)


@browser_phainon.post(f"{OIDC_PREFIX}/exchange")
def oidc_exchange() -> JSONResponse:
    """login_code → token 对；任何 code 都成功，见 frontend/src/lib/phainon.ts:54。"""
    return JSONResponse({"access_token": _token(), "refresh_token": _token()})


@browser_phainon.post(f"{OIDC_PREFIX}/refresh")
def oidc_refresh() -> JSONResponse:
    """refresh token 轮转；任何 refresh_token 都成功，见 frontend/src/lib/phainon.ts:83。"""
    return JSONResponse({"access_token": _token(), "refresh_token": _token()})


@browser_phainon.post(f"{OIDC_PREFIX}/logout")
def oidc_logout() -> Response:
    """登出通知；前端忽略失败，见 frontend/src/lib/phainon.ts:134。"""
    return Response(status_code=204)


@browser_phainon.get(f"{OIDC_PREFIX}/me")
def oidc_me() -> JSONResponse:
    """当前用户；形状见 frontend/src/types.ts 的 PhainonMe。"""
    return JSONResponse({"app_id": DEMO_APP_ID, "user": DEMO_USER})


# ── 8124：给后端用的假 Phainon（app/auth.py 的 introspection 目标）
# 调用方：backend/app/auth.py:51（_check_token）← auth.py:161（require_auth）
backend_phainon = FastAPI(title="Fake Phainon (backend)", docs_url=None, redoc_url=None, openapi_url=None)


@backend_phainon.get(f"{OIDC_PREFIX}/me")
def introspect(request: Request) -> Response:
    """任何 Bearer 都判为合法，app_id 与后端配置一致即放行（app/auth.py:54-63）。"""
    global _introspect_count
    authorization = request.headers.get("authorization", "")
    if not authorization.lower().startswith("bearer ") or not authorization[7:].strip():
        return JSONResponse({"detail": {"code": "unauthorized"}}, status_code=401)
    with _introspect_lock:
        _introspect_count += 1
    return JSONResponse({"app_id": DEMO_APP_ID, "user": DEMO_USER})


class PhainonMiddleware(BaseHTTPMiddleware):
    """把 8123 上的 /auth/priestess/oidc/* 交给假 Phainon，其余请求透传给后端。

    必须挂成**最外层**：create_app 里的 SPA 兜底路由（app/api.py:649）会吞掉
    所有未匹配的 GET，注册顺序上赢不了它，只能在中间件层拦。

    这里没走 app.mount：mount 只按前缀匹配，而前端请求的就是同一批绝对路径
    （frontend/src/lib/phainon.ts:8）。也没有用 httpx.ASGITransport——本中间件是
    同步 dispatch，拿不到 await。所以直接按 ASGI 调用内层应用并收口消息重建
    Response：FastAPI.__call__ 需要 (scope, receive, send) 三个参数，少一个就是
    TypeError。
    """

    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)
        self._inner = browser_phainon

    @staticmethod
    async def _call_inner(scope: dict, receive) -> Response:  # noqa: ANN001
        messages: list[dict] = []

        async def send(message: dict) -> None:
            messages.append(message)

        await browser_phainon(scope, receive, send)
        start = next((m for m in messages if m["type"] == "http.response.start"), None)
        if start is None:
            if any(m["type"] == "lifespan.startup.complete" for m in messages):
                # 非 HTTP scope（lifespan）：内层不需要启动钩子，直接放行
                return Response(status_code=200)
            return Response(status_code=500)
        body = b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")
        headers = {
            key.decode("latin-1"): value.decode("latin-1") for key, value in start.get("headers", [])
        }
        return Response(
            content=body,
            status_code=start["status"],
            headers=headers,
            media_type=headers.pop("content-type", None),
        )

    async def dispatch(self, request: Request, call_next):  # noqa: ANN001
        if request.url.path.startswith(OIDC_PREFIX):
            return await self._call_inner(request.scope, request.receive)
        return await call_next(request)


class NoStoreMiddleware(BaseHTTPMiddleware):
    """index.html 与 SW 脚本一律 no-store。

    后端自己只给这两类响应发 no-cache（app/api.py:222-229），任务书要求 no-store；
    本中间件加在最后，即最外层，直接改写内层已经写好的响应头。

    兜底脚本判定：任何以 /sw.js 结尾或 /workbox- 开头的路径都当 SW 脚本处理——
    workbox 的分块脚本与 sw.js 同源同作用域，缓存住任一个都会让自毁失效。
    """

    async def dispatch(self, request: Request, call_next):  # noqa: ANN001
        path = request.url.path
        is_sw = path in SW_SCRIPT_PATHS or path.startswith("/workbox-")
        if is_sw:
            return Response(
                content=_SELF_DESTRUCT_SW,
                media_type="application/javascript",
                headers={"Cache-Control": "no-store"},
            )
        response = await call_next(request)
        if path in ("/", "/index.html"):
            response.headers["Cache-Control"] = "no-store"
        return response


def _wait_for_port(port: int, timeout: float = 20.0) -> None:
    """等假 Phainon 真的在监听，避免首屏登录请求撞上未就绪的端口。"""
    pause = threading.Event()
    waited = 0.0
    while waited < timeout:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.settimeout(0.5)
            if probe.connect_ex((HOST, port)) == 0:
                return
        pause.wait(0.1)
        waited += 0.1
    raise RuntimeError(f"假 Phainon 未能在 {timeout:.0f}s 内监听 {HOST}:{port}")


def _start_backend_phainon(port: int) -> threading.Thread:
    """在后台线程里跑假 Phainon。

    走 server.serve() 而不是 server.startup()：uvicorn 的 lifespan 由 serve() 创建，
    单独调 startup() 会 AttributeError（'Server' object has no attribute 'lifespan'）。
    serve() 里装信号处理器只允许主线程，这里在子线程跑，必须换掉那个钩子。
    """
    config = uvicorn.Config(backend_phainon, host=HOST, port=port, log_level="warning", access_log=False)
    server = uvicorn.Server(config)
    server.install_signal_handlers = lambda: None  # type: ignore[method-assign]

    def _serve() -> None:
        asyncio.run(server.serve())

    thread = threading.Thread(target=_serve, name="fake-phainon", daemon=True)
    thread.start()
    _wait_for_port(port)
    return thread


def build_asgi_app(port: int, phainon_port: int) -> ASGIApp:
    """建库 → 播种 → 建后端应用 → 套中间件。"""
    db_path = Path(os.environ["DATABASE_PATH"])
    for suffix in ("", "-wal", "-shm"):
        Path(str(db_path) + suffix).unlink(missing_ok=True)

    engine = make_engine(str(db_path))
    init_db(engine)  # 本仓库后端自己建表（FTS5 虚表与触发器也在这里）
    counts = seed.seed_all(engine)
    logger.info("已播种演示数据：%s", counts)

    settings = Settings()
    application = create_app(settings=settings, session_factory=make_session_factory(engine))
    application.add_middleware(PhainonMiddleware)
    application.add_middleware(NoStoreMiddleware)
    return application


def main() -> None:
    parser = argparse.ArgumentParser(description="RakkoTasks 本机演示站")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"演示站端口（默认 {DEFAULT_PORT}）")
    parser.add_argument(
        "--phainon-port", type=int, default=DEFAULT_PHAINON_PORT,
        help=f"假 Phainon 端口（默认 {DEFAULT_PHAINON_PORT}）",
    )
    args = parser.parse_args()

    os.environ["PHAINON_API_BASE"] = f"http://{HOST}:{args.phainon_port}"
    os.environ["FRONTEND_ORIGIN"] = f"http://{HOST}:{args.port}"

    _start_backend_phainon(args.phainon_port)
    asgi_app = build_asgi_app(args.port, args.phainon_port)

    # 自检用日志：绝对路径，供 grep 断言
    logger.info("backend: %s", backend_package.__file__)
    logger.info("dist: %s", DIST_DIR.resolve())
    logger.info("演示站地址：http://%s:%d/（仅本机监听）", HOST, args.port)
    logger.info("已注入演示配置（配置值不打印）；.env 不会生效")

    uvicorn.run(asgi_app, host=HOST, port=args.port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
