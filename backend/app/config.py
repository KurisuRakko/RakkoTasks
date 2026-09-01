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
    # DeepSeek V4 系列的推理档位（low/high）；留空字符串则不传该参数，
    # 以兼容不支持它的模型或其它 OpenAI 兼容供应商
    llm_reasoning_effort: str = "high"   # env: LLM_REASONING_EFFORT

    # Phainon 鉴权
    phainon_api_base: str = "https://api.rakko.cn"
    phainon_app_id: str = "rakkotasks"
    frontend_origin: str = "https://tasks.rakko.cn"

    # 前端静态目录：非空时直接使用，空则回退 backend/frontend/dist 启发式路径
    frontend_dist: str = ""

    # Microsoft OAuth 默认客户端：Mozilla Thunderbird 注册的公共客户端
    # （第三方应用，可用于 IMAP）。不要改成 d3590ed6-52b3-4102-aeff-aad2292ab01c
    # （Microsoft Office）——那是第一方应用，访问 Exchange Online 需要预授权，
    # 会报 AADSTS65002，拿不到 IMAP token。如需换成自己在 Azure 注册的应用，
    # 用 accounts add --client-id 按账户覆盖。
    ms_default_client_id: str = "9e5f94bc-e8a4-4e73-b8be-63364c29d753"


@lru_cache
def get_settings() -> Settings:
    return Settings()
