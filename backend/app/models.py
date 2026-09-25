"""SQLAlchemy 2.0 声明式模型：users / accounts / emails / items / reminders / sync_runs（见 DESIGN.md 第 5 节）。"""
from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    sub: Mapped[str] = mapped_column(Text, primary_key=True)  # Phainon user.sub
    email: Mapped[str | None] = mapped_column(Text)
    name: Mapped[str | None] = mapped_column(Text)
    calendar_token: Mapped[str | None] = mapped_column(Text, unique=True)  # 日历订阅密钥：链接即凭据，泄露就 rotate
    # CalDAV Basic 鉴权应用密码的 sha256 hex；NULL = 未开通（旧库由 _ensure_columns 就地补列）
    caldav_password_hash: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.now, server_default=func.now(), nullable=False
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.now, server_default=func.now(), nullable=False
    )

    accounts: Mapped[list["Account"]] = relationship(back_populates="user")


class Account(Base):
    __tablename__ = "accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_sub: Mapped[str] = mapped_column(ForeignKey("users.sub"), nullable=False, index=True)  # 归属用户
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)  # gmail | qq | microsoft
    email: Mapped[str] = mapped_column(String(256), nullable=False)
    ms_client_id: Mapped[str | None] = mapped_column(String(64))
    app_password: Mapped[str | None] = mapped_column(Text)  # Gmail 应用专用密码，明文，仅服务端 IMAP 使用
    token_cache: Mapped[str | None] = mapped_column(Text)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)  # 软删除：0 停用但保留邮件/任务
    # IMAP 增量游标
    uidvalidity: Mapped[int | None] = mapped_column(Integer)
    last_uid: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # 发件箱归档游标：与收件箱游标分开，各自随自己文件夹的 UIDVALIDITY 重置
    sent_uidvalidity: Mapped[int | None] = mapped_column(Integer)
    sent_last_uid: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_error: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="pending", nullable=False)  # ok|error|pending

    user: Mapped[User] = relationship(back_populates="accounts")
    emails: Mapped[list["Email"]] = relationship(back_populates="account")


class Email(Base):
    __tablename__ = "emails"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), nullable=False, index=True)
    message_id: Mapped[str] = mapped_column(String(512), nullable=False)  # 无 Message-ID 时用合成键
    subject: Mapped[str] = mapped_column(Text, default="", nullable=False)
    sender: Mapped[str] = mapped_column(Text, default="", nullable=False)
    recipients: Mapped[str] = mapped_column(Text, default="", nullable=False)  # 逗号分隔
    sent_at: Mapped[datetime | None] = mapped_column(DateTime)
    text_body: Mapped[str] = mapped_column(Text, default="", nullable=False)
    html_body: Mapped[str | None] = mapped_column(Text)
    attachments_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)  # 文件名 JSON 数组
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.now, server_default=func.now(), nullable=False
    )
    # LLM 处理状态
    filtered: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    filter_reason: Mapped[str | None] = mapped_column(Text)
    llm_state: Mapped[str] = mapped_column(String(16), default="pending", nullable=False)  # pending|done|error

    account: Mapped[Account] = relationship(back_populates="emails")
    item: Mapped["Item | None"] = relationship(back_populates="email", uselist=False)

    __table_args__ = (UniqueConstraint("account_id", "message_id", name="uq_account_message"),)


class Item(Base):
    __tablename__ = "items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # null = 手动条目（无源邮件）；SQLite 的 UNIQUE 允许多个 NULL，不冲突
    email_id: Mapped[int | None] = mapped_column(ForeignKey("emails.id"), nullable=True, unique=True)
    # 归属直接落在条目上，不再经邮件链推导；手动条目没有邮件可推导
    user_sub: Mapped[str] = mapped_column(ForeignKey("users.sub"), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(128), nullable=False)
    summary: Mapped[str] = mapped_column(Text, default="", nullable=False)
    category: Mapped[str] = mapped_column(String(16), default="其他", nullable=False)
    due_date: Mapped[date | None] = mapped_column(Date)
    importance: Mapped[str] = mapped_column(String(8), default="normal", nullable=False)
    # high | normal | low：与 due_date 无关的重要程度，用于把「重要但没日期」的事顶上来
    actionable: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="open", nullable=False)  # open|done
    detail_md: Mapped[str | None] = mapped_column(Text)
    # 关联邮件 JSON 数组 [{"email_id": int, "reason": str}]，沿用 attachments_json 的 JSON 文本列惯例
    related_json: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.now, server_default=func.now(), nullable=False
    )
    done_at: Mapped[datetime | None] = mapped_column(DateTime)
    # CalDAV 资源标识：服务端生成的 32 位大写 hex UID；资源名 = coalesce(caldav_name, caldav_uid)
    caldav_uid: Mapped[str | None] = mapped_column(Text, default=lambda: uuid.uuid4().hex.upper())
    caldav_name: Mapped[str | None] = mapped_column(Text)  # 客户端文件名 stem ≠ UID 时才非空
    caldav_ics: Mapped[str | None] = mapped_column(Text)  # 客户端最近一次 PUT 的原始 VCALENDAR 文本（透传载体）
    # onupdate 保证任何 ORM 变更都刷新（ETag 来源）；库内 naive datetime 按 UTC 解释
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, default=datetime.now, onupdate=datetime.now)

    email: Mapped["Email | None"] = relationship(back_populates="item")
    # 提醒时刻列表，按时间升序。cascade 与 FK 的 ondelete 两道都要：三处删条目
    # （api/cli/caldav store）走的都是 ORM session.delete，靠 cascade 生效；
    # ondelete 兜住将来可能出现的批量 DELETE（db.py 已开 PRAGMA foreign_keys=ON）。
    reminders: Mapped[list["Reminder"]] = relationship(
        back_populates="item",
        cascade="all, delete-orphan",
        order_by="Reminder.remind_at",
        passive_deletes=False,
    )


class Reminder(Base):
    """条目的提醒时刻（一条目多提醒）。

    与 items.due_date 是**两件事**：due_date 是「什么时候到期」（全天、无时刻），
    这里是「什么时候敲用户」（有时刻）。分开的理由见 DESIGN.md 4.4 与 11.5——
    「明天提醒我修空调」只该产生提醒、不该产生一个假的截止日。

    remind_at 为 naive datetime、按 UTC 解释（与全库 DateTime 列同口径）；
    本地时刻 ↔ UTC 的换算发生在 API 边界（见 itemrules.validate_reminders）。
    """

    __tablename__ = "reminders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    item_id: Mapped[int] = mapped_column(
        ForeignKey("items.id", ondelete="CASCADE"), nullable=False, index=True
    )
    remind_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.now, server_default=func.now(), nullable=False
    )

    item: Mapped["Item"] = relationship(back_populates="reminders")

    __table_args__ = (
        # 同一条目同一时刻只留一个：去重在 validate_reminders 里做，这里是兜底
        UniqueConstraint("item_id", "remind_at", name="uq_reminders_item_at"),
    )


class SyncRun(Base):
    """一轮同步；同一张表也存 web 进程写下的手动唤醒请求。

    请求行（state=requested）被 worker 认领后就地变成轮次行（state=running），
    所以不另建请求表：请求与轮次是同一件事的两个阶段，分行存反而要处理
    「请求有行、轮次没行」的对账问题。requested_at 只有请求阶段有意义。
    """

    __tablename__ = "sync_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    trigger: Mapped[str] = mapped_column(String(16), nullable=False)  # manual | scheduled
    state: Mapped[str] = mapped_column(String(16), nullable=False)  # requested | running | done | failed
    requested_at: Mapped[datetime | None] = mapped_column(DateTime)  # 仅手动请求
    started_at: Mapped[datetime | None] = mapped_column(DateTime)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime)
    error: Mapped[str | None] = mapped_column(Text)  # 整轮级异常；单邮箱失败只记在 stages 里
    # 各阶段进度的 JSON 串（结构见 sync_state 里给前端的契约），只由 SyncProgress 整段重写
    stages: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
