<p align="right"><strong>English</strong>&nbsp;|&nbsp;<a href="README.zh-CN.md"><kbd>中文</kbd></a></p>

# RakkoTasks

**Turn your inbox into a to-do list.** RakkoTasks is a self-hosted personal task system.
It periodically pulls mail from several mailboxes, uses a large language model to filter out
advertising and noise, and distills the emails that actually need your attention into to-do
items with a title, summary, category, due date and importance. You manage them from a web app
on your phone or desktop. You can also add tasks by hand, and subscribe to every dated task
from your system calendar.

It was built for a specific problem: school notices, bills, work mail and personal mail spread
across four mailboxes, with the handful of things you actually have to do today buried among
hundreds of messages. RakkoTasks digs them out, orders them, and waits for you.

## Features

- **Email-driven tasks.** Every 15 minutes it incrementally syncs Outlook / Microsoft 365
  (OAuth2 + XOAUTH2) and Gmail (app password) mailboxes. The LLM decides which emails are
  actionable and produces a title, summary, category (Study / Work / Personal / Bills / Other),
  due date and importance.
- **Grouped by time.** The task page groups items into Today / This week / Important / No deadline.
  Overdue items are highlighted, and items whose source email arrived today show a small blue dot
  that disappears the next day.
- **Manual tasks.** Tap the `+` button to jot down a task: the first line is the title, the rest
  is the description, with optional category and due date. Manual tasks can be edited or deleted
  at any time.
- **AI details.** When you open a task, the model reads your other emails for background (for
  example earlier notices about the same matter), writes up the details and lists the related
  emails. One tap copies everything as Markdown to paste into an AI chat.
- **AI search.** Ask questions about your whole mail archive in natural language. Answers cite
  the emails they came from, backed by SQLite FTS5 full-text search.
- **Calendar subscription.** Each user gets a tokenised iCalendar feed. Open tasks with a due
  date appear as all-day events in your system calendar, vanish when completed, and remind you
  at 10:00 on the due date. On iPhone the feed can be added with one tap via `webcal://`.
- **Original email view.** Read the original email inside the task. HTML is sanitised on the
  server and rendered in a sandboxed iframe; remote images are blocked by default.
- **Multi-user.** Sign-in is handled by Phainon, the author's own authentication service. Each
  user sees only their own mailboxes, emails and tasks.
- **PWA.** Add it to your home screen; light and dark themes follow the system.

## How it works

```
Mailboxes (IMAP) ──► worker (periodic sync) ──► SQLite (WAL + FTS5)
                          │                          ▲
                          ▼                          │
                  LLM filter / distil          FastAPI backend ◄──► React frontend (PWA)
                                                     │
                                          iCalendar feed / AI search
```

- `backend/`: FastAPI application, sync worker, LLM pipeline and the command-line admin tool
  (add mailboxes, reclassify, and so on).
- `frontend/`: React + TypeScript single-page app; the build output is served by the backend on
  the same origin.
- `deploy/`: production deployment with Docker Compose and Cloudflare Tunnel.
- The full architecture and every design decision is documented in
  [docs/DESIGN.md](docs/DESIGN.md) (Chinese).

### A note on security

The LLM reads untrusted email bodies, which opens the door to prompt injection. RakkoTasks
screens model input for injection attempts, strips every Markdown element that would trigger an
automatic outbound request (such as images) from model output, and applies an allow-list once
more in the frontend renderer, so an attacker cannot use a crafted email to make the model leak
your data. Original email HTML is always sanitised on the server and displayed in a sandbox.
See section 7 of [docs/DESIGN.md](docs/DESIGN.md).

## Quick start

Three steps. Prerequisites, Phainon app registration, Cloudflare Tunnel setup and the complete
walkthrough are in [deploy/README.md](deploy/README.md) (Chinese).

1. Configure: `cp deploy/.env.example .env` and fill in `LLM_API_KEY`, `TUNNEL_TOKEN` and the
   other values.
2. Start: `docker compose -f deploy/docker-compose.yml up -d --build`
   (three services: web, worker and cloudflared; public traffic reaches the app over HTTPS
   through the tunnel).
3. Connect mailboxes: sign in once on the web app so the backend creates your user record, then
   look up your subject id with
   `docker compose -f deploy/docker-compose.yml run --rm web python -m app.cli users list`.
   Add Gmail with
   `python -m app.cli accounts add --user <sub> --kind gmail --name Gmail --email you@gmail.com`
   (you will be prompted for the app password), and connect each Outlook account with
   `accounts connect --user <sub> <email>` to complete the OAuth device-code flow. Full details are
   in section 6 of [deploy/README.md](deploy/README.md).

### Local development

```bash
cd backend && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]' && .venv/bin/python -m pytest -q
```

```bash
cd frontend && npm ci && npm run typecheck && npx vitest run && npm run build
```

## Acknowledgements and open-source software

RakkoTasks stands on the shoulders of many open-source projects. They are listed here by purpose,
with thanks to their authors and maintainers.

### Mozilla Thunderbird

When connecting Outlook / Microsoft 365 mailboxes, the default Microsoft OAuth client identifier
`9e5f94bc-e8a4-4e73-b8be-63364c29d753` is the public client that
[Mozilla Thunderbird](https://www.thunderbird.net/) registered with Microsoft. It is the same
identifier Thunderbird itself uses for IMAP access, and it is the established way for an
individual to reach Outlook IMAP over OAuth2 without registering an Azure application.
RakkoTasks contains no Thunderbird code. If you prefer your own Azure app registration, pass
`--client-id` when adding the account. Thunderbird is released under the MPL 2.0.

### Backend

- [FastAPI](https://fastapi.tiangolo.com/) and [Uvicorn](https://www.uvicorn.org/): HTTP server
- [SQLAlchemy](https://www.sqlalchemy.org/): ORM and database access
- [SQLite](https://www.sqlite.org/) with the FTS5 extension: storage and full-text search
- [Pydantic](https://docs.pydantic.dev/) and pydantic-settings: validation and configuration
- [MSAL for Python](https://github.com/AzureAD/microsoft-authentication-library-for-python): Microsoft OAuth2 device-code flow and token cache
- [nh3](https://github.com/messense/nh3) (built on [ammonia](https://github.com/rust-ammonia/ammonia)): email HTML sanitisation
- [openai-python](https://github.com/openai/openai-python): LLM client for OpenAI-compatible APIs (DeepSeek by default)
- [httpx](https://www.python-httpx.org/): HTTP client
- Testing: [pytest](https://pytest.org/), pytest-asyncio, [respx](https://lundberg.github.io/respx/)

### Frontend

- [React](https://react.dev/) and [React Router](https://reactrouter.com/)
- [MUI](https://mui.com/) (Material UI) and [Emotion](https://emotion.sh/): components and styling
- [react-markdown](https://github.com/remarkjs/react-markdown) and [remark-breaks](https://github.com/remarkjs/remark-breaks): Markdown rendering
- [Vite](https://vite.dev/), [vite-plugin-pwa](https://vite-pwa-org.netlify.app/) and [Workbox](https://developer.chrome.com/docs/workbox): build tooling and PWA
- [TypeScript](https://www.typescriptlang.org/)
- Testing: [Vitest](https://vitest.dev/), [Testing Library](https://testing-library.com/), [jsdom](https://github.com/jsdom/jsdom)

### Deployment

- [Docker](https://www.docker.com/) and Docker Compose
- [cloudflared](https://github.com/cloudflare/cloudflared): Cloudflare Tunnel client

The authentication service, Phainon, is the author's own infrastructure and is not part of this repository.
