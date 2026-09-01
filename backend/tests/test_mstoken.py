"""mstoken 常量离线断言：钉死 OAuth 资源域名与 IMAP 主机名的区别。"""
from app.config import Settings
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


def test_ms_default_client_id_is_thunderbird():
    # Thunderbird 注册的公共客户端，第三方应用，可用于 IMAP。
    assert Settings().ms_default_client_id == "9e5f94bc-e8a4-4e73-b8be-63364c29d753"


def test_ms_default_client_id_not_microsoft_office():
    # 不要改回 d3590ed6-52b3-4102-aeff-aad2292ab01c（Microsoft Office）：
    # 那是第一方应用，访问 Exchange Online 必须经预授权，会报
    # AADSTS65002，拿不到 IMAP token。
    assert (
        Settings().ms_default_client_id
        != "d3590ed6-52b3-4102-aeff-aad2292ab01c"
    ), "默认 client_id 不能是 Microsoft Office 的 d3590ed6：第一方应用访问 Exchange Online 需要预授权，会报 AADSTS65002，IMAP 拿不到 token"
