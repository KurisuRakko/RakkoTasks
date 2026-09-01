"""mstoken 常量离线断言：钉死 OAuth 资源域名与 IMAP 主机名的区别。"""
from app.imap.client import MS_IMAP_HOST
from app.imap.mstoken import MS_SCOPE


def test_ms_scope_uses_resource_domain_outlook_office_com():
    # 资源域名写错成 IMAP 主机名 outlook.office365.com 会被微软拒为
    # AADSTS70011 invalid_scope，设备码流程无法启动。
    assert MS_SCOPE == ["https://outlook.office.com/IMAP.AccessAsUser.All"]
    assert "outlook.office365.com" not in MS_SCOPE[0]


def test_ms_imap_host_stays_outlook_office365_com():
    # IMAP 服务器主机名与 OAuth 资源域名不是一回事，防止被"顺手统一"。
    assert MS_IMAP_HOST == "outlook.office365.com"
