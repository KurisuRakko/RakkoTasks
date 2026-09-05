"""CalDAV（iPhone 提醒事项同步）：Basic 鉴权与应用密码（auth）、VTODO 解析/序列化
（vtodo）、集合数据访问（store）、XML 收发（xmlio）、HTTP 路由（router）。

对外只暴露 register_caldav：在 create_app 里、SPA fallback 之前挂载。
"""
from app.caldav.router import register_caldav

__all__ = ["register_caldav"]
