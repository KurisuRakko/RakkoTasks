#!/usr/bin/env bash
# 用法：bash dev/demo/run.sh [--port 8123]（先构建前端，再 exec 演示服务器）
set -euo pipefail

# 仓库根由脚本自身位置推出，不依赖调用时的 cwd
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${HERE}/../.." && pwd)"
FRONTEND_DIR="${REPO_ROOT}/frontend"
DIST_DIR="${FRONTEND_DIR}/dist-demo"

# 不自动安装依赖：缺 node_modules 时直接报错退出，让人自己决定怎么装
if [ ! -d "${FRONTEND_DIR}/node_modules" ]; then
  echo "缺少 ${FRONTEND_DIR}/node_modules：请先执行 npm ci --prefix frontend --cache ./.npm-cache" >&2
  exit 1
fi

# VITE_PHAINON_API_BASE='' 让前端同源请求 /auth/priestess/oidc/*（见 frontend/src/lib/env.ts:8），
# 由演示服务器上的假 Phainon 应答；否则构建产物会去请求线上的 api.rakko.cn
( cd "${FRONTEND_DIR}" && VITE_PHAINON_API_BASE='' npx vite build --outDir dist-demo --emptyOutDir )

# 端口经 "$@" 透传给服务器（exec 让端口进程号就是本脚本的进程号，便于 Ctrl-C）
exec "${PYTHON:-python3}" "${HERE}/demo_server.py" "$@"
