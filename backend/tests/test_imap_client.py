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


def test_fetch_uid_peek_uses_body_peek() -> None:
    """归档拉取必须走 BODY.PEEK[]：不设置 \\Seen，不改用户邮箱的已读状态。"""
    conn = FakeConn()
    assert ImapClient(conn).fetch_uid_peek(11) == b"raw-bytes"
    assert ("uid", "FETCH", "11", "(BODY.PEEK[])") in conn.calls
