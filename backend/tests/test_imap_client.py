"""ImapClient 的发件箱与归档专用拉取：LIST 解析、只读 SELECT、BODY.PEEK[]。"""
from app.imap.client import ImapClient, parse_list_line

# 生产四个账户的真实 LIST 响应形态
MODIFIED_UTF7 = b'(\\HasNoChildren \\Sent) "/" &XfJT0ZABkK5O9g-'
PLAIN_SENT = b'(\\HasNoChildren \\Sent) "/" Sent'
QUOTED_SENT = b'(\\HasNoChildren \\Sent) "/" "[Gmail]/Sent Mail"'
INBOX = b'(\\HasNoChildren) "/" "INBOX"'


class FakeConn:
    """记录调用参数的假连接：LIST 行与 SELECT/STATUS/FETCH 响应可预设。"""

    def __init__(self, list_lines=(), uidvalidity=7):
        self.list_lines = list(list_lines)
        self.uidvalidity = uidvalidity
        self.calls: list[tuple] = []

    def list(self):
        self.calls.append(("list",))
        return "OK", list(self.list_lines)

    def select(self, name, readonly=False):
        self.calls.append(("select", name, readonly))
        return "OK", [b"1"]

    def status(self, name, what):
        self.calls.append(("status", name, what))
        return "OK", [f"{name} (UIDVALIDITY {self.uidvalidity})".encode()]

    def uid(self, command, *args):
        self.calls.append(("uid", command, *args))
        return "OK", [(b"1 (BODY[] {5}", b"raw-bytes")]


def test_parse_list_line_keeps_modified_utf7_name_as_is() -> None:
    """modified UTF-7 的「已发送邮件」按原样返回，绝不解码。"""
    flags, name = parse_list_line(MODIFIED_UTF7)
    assert flags == {"\\HasNoChildren", "\\Sent"}
    assert name == "&XfJT0ZABkK5O9g-"


def test_parse_list_line_handles_atom_and_quoted_names() -> None:
    """分隔符与名字都可能是带引号的字符串，名字里的空格属于名字。"""
    assert parse_list_line(PLAIN_SENT) == ({"\\HasNoChildren", "\\Sent"}, "Sent")
    assert parse_list_line(QUOTED_SENT) == ({"\\HasNoChildren", "\\Sent"}, "[Gmail]/Sent Mail")
    assert parse_list_line(b'(\\HasNoChildren) NIL INBOX') == ({"\\HasNoChildren"}, "INBOX")


def test_parse_list_line_without_sent_flag() -> None:
    flags, name = parse_list_line(INBOX)
    assert "\\Sent" not in flags
    assert name == "INBOX"


def test_parse_list_line_unescapes_quoted_name() -> None:
    """名字里的 \\\\ 与 \\" 还原成字面字符。"""
    flags, name = parse_list_line(b'(\\Sent) "/" "a\\\\b\\"c"')
    assert flags == {"\\Sent"}
    assert name == 'a\\b"c'


def test_parse_list_line_literal_tuple_entry() -> None:
    """字面量形式：flags 在 tuple[0] 里，名字在 tuple[1] 里。"""
    flags, name = parse_list_line(b'(\\HasNoChildren \\Sent) "/" {19}')
    assert "\\Sent" in flags
    assert name == "{19}"  # parse_list_line 只认行内名字，字面量名字由调用方从 tuple[1] 取


def test_find_sent_folder_matches_any_sent_flag() -> None:
    """三个真实样例都能找到；没有 \\Sent 的行被跳过。"""
    for line in (MODIFIED_UTF7, PLAIN_SENT, QUOTED_SENT):
        conn = FakeConn([INBOX, line])
        assert ImapClient(conn).find_sent_folder() == parse_list_line(line)[1]

    conn = FakeConn([INBOX, b'(\\HasChildren) "/" "Archive"'])
    assert ImapClient(conn).find_sent_folder() is None
    assert ImapClient(FakeConn()).find_sent_folder() is None


def test_find_sent_folder_reads_literal_tuple_entry() -> None:
    """字面量条目（tuple）用 tuple[1] 当名字，flags 从 tuple[0] 解析。"""
    conn = FakeConn([INBOX, (b'(\\HasNoChildren \\Sent) "/" {19}', b"&XfJT0ZABkK5O9g-")])
    assert ImapClient(conn).find_sent_folder() == "&XfJT0ZABkK5O9g-"


def test_select_folder_readonly_quotes_name_and_parses_uidvalidity() -> None:
    """名字带引号传给 SELECT（readonly=True），UIDVALIDITY 从 STATUS 解析。"""
    conn = FakeConn(uidvalidity=42)
    assert ImapClient(conn).select_folder_readonly("[Gmail]/Sent Mail") == 42
    assert ("select", '"[Gmail]/Sent Mail"', True) in conn.calls
    assert ("status", '"[Gmail]/Sent Mail"', "(UIDVALIDITY)") in conn.calls


def test_select_folder_readonly_escapes_quotes_and_backslashes() -> None:
    """名字里的 \\ 与 " 从 READONLY 的 SELECT 传出去。"""
    conn = FakeConn()
    ImapClient(conn).select_folder_readonly('a"b\\c')
    assert ("select", '"a\\"b\\\\c"', True) in conn.calls


def test_select_inbox_is_readonly() -> None:
    """收件箱也用 EXAMINE 打开（readonly=True），UIDVALIDITY 从 STATUS 解析。"""
    conn = FakeConn(uidvalidity=13)
    assert ImapClient(conn).select_inbox() == 13
    assert ("select", "INBOX", True) in conn.calls
    assert ("status", "INBOX", "(UIDVALIDITY)") in conn.calls


def test_fetch_uid_uses_body_peek() -> None:
    """唯一的拉取方法走 BODY.PEEK[]：不设置 \\Seen，不改用户邮箱的已读状态。"""
    conn = FakeConn()
    assert ImapClient(conn).fetch_uid(11) == b"raw-bytes"
    assert ("uid", "FETCH", "11", "(BODY.PEEK[])") in conn.calls


class StrictReadOnlyConn:
    """只放行只读命令的假连接：任何写操作（含未显式定义的）都直接 raise。

    显式定义的方法自己校验参数：select 必须 readonly=True（EXAMINE），uid 只
    允许 SEARCH 与带 BODY.PEEK[ 的 FETCH。__getattr__ 兜住 store/copy/append/
    expunge/create/delete/rename/subscribe 等一切未定义方法名。
    """

    def __init__(self, uidvalidity: int = 7, sent_folder: str = "Sent") -> None:
        self.uidvalidity = uidvalidity
        self.sent_folder = sent_folder
        self.calls: list[tuple] = []

    def list(self):
        self.calls.append(("list",))
        return "OK", [b'(\\HasNoChildren) "/" "INBOX"', f'(\\HasNoChildren \\Sent) "/" "{self.sent_folder}"'.encode()]

    def select(self, name, readonly=False):
        self.calls.append(("select", name, readonly))
        # 不是只读打开就是越界：SELECT 会把邮箱置成可写并清掉 \Recent
        assert readonly is True, f"SELECT {name!r} 未按只读（EXAMINE）打开"
        assert isinstance(name, str), f"SELECT 的文件夹名不是字符串: {name!r}"
        return "OK", [b"1"]

    def status(self, name, what):
        self.calls.append(("status", name, what))
        return "OK", [f"{name} (UIDVALIDITY {self.uidvalidity})".encode()]

    def uid(self, command, *args):
        self.calls.append(("uid", command, *args))
        assert command in ("SEARCH", "FETCH"), f"发现写命令 UID {command}"
        if command == "FETCH":
            # RFC822 会隐式设置 \Seen；只有 BODY.PEEK[] 不改用户邮箱状态
            assert "BODY.PEEK[" in args[1], f"FETCH 未走 PEEK: {args[1]!r}"
            return "OK", [(b"1 (BODY[] {5}", b"raw-bytes")]
        return "OK", [b"11"]

    def logout(self):
        self.calls.append(("logout",))
        return "BYE", [b"bye"]

    def __getattr__(self, name: str):
        raise AssertionError(f"ImapClient 调用了未授权的连接方法: {name}")


def test_client_only_issues_readonly_commands_end_to_end() -> None:
    """完整流程跑一遍：任何写命令或非 PEEK 拉取都会让 StrictReadOnlyConn 抛错。"""
    conn = StrictReadOnlyConn()
    client = ImapClient(conn)

    assert client.select_inbox() == 7
    assert client.search_uids("UID 11:*") == [11]
    assert client.fetch_uid(11) == b"raw-bytes"
    assert client.find_sent_folder() == "Sent"
    assert client.select_folder_readonly("Sent") == 7
    assert client.fetch_uid(11) == b"raw-bytes"
    client.logout()

    assert ("select", "INBOX", True) in conn.calls
    assert ("select", '"Sent"', True) in conn.calls
    assert [c for c in conn.calls if c[0] == "uid"] == [
        ("uid", "SEARCH", "UID 11:*"),
        ("uid", "FETCH", "11", "(BODY.PEEK[])"),
        ("uid", "FETCH", "11", "(BODY.PEEK[])"),
    ]
