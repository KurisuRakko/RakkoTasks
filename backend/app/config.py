"""全局配置：全部来自环境变量，均有默认值，便于离线测试。"""
from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # 数据与同步
    database_path: str = "data/rakkotasks.db"
    sync_interval_minutes: int = 15
    initial_backfill_days: int = 180
    search_index_days: int = 90

    # LLM（OpenAI-compatible）
    llm_base_url: str = ""
    llm_api_key: str = ""
    llm_model: str = ""

    # Phainon 鉴权
    phainon_api_base: str = "https://api.rakko.cn"
    phainon_app_id: str = "rakkotasks"
    frontend_origin: str = "https://tasks.rakko.cn"

    # 前端静态目录：非空时直接使用，空则回退 backend/frontend/dist 启发式路径
    frontend_dist: str = ""

    # Microsoft OAuth 默认客户端
    ms_default_client_id: str = "d3590ed6-52b3-4102-aeff-aad2292ab01c"


@lru_cache
def get_settings() -> Settings:
    return Settings()
