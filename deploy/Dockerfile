# RakkoTasks 多阶段镜像：node 构建前端 → python 运行时托管 API + 前端静态文件。
# 构建上下文必须是仓库根：docker build -f deploy/Dockerfile .

# ── 阶段 1：前端构建 ──────────────────────────────────────────
FROM node:22-alpine AS frontend-build
WORKDIR /build
COPY frontend/ ./
RUN npm ci --no-audit --no-fund && npm run build

# ── 阶段 2：运行时 ────────────────────────────────────────────
FROM python:3.12-slim
COPY backend/ /app/backend/
RUN pip install --no-cache-dir /app/backend
COPY --from=frontend-build /build/dist /app/frontend-dist

# FRONTEND_DIST 由镜像内置（.env 中请勿再配置，覆盖为空会导致前端 404）
ENV FRONTEND_DIST=/app/frontend-dist \
    DATABASE_PATH=/data/rakkotasks.db \
    PYTHONUNBUFFERED=1

# 以非 root 运行：uid 1000 的 app 用户，数据卷归其所有
RUN useradd --uid 1000 --create-home app \
    && mkdir -p /data \
    && chown app:app /data
USER app

VOLUME /data
EXPOSE 8000

# Web 入口；worker 在 compose 中覆盖 command（python -m app.worker）
CMD ["uvicorn", "app.api:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
