# Tracker

A self-hostable agile project tracker with velocity-based iteration planning, in the spirit of Pivotal Tracker — plus a fully documented REST API.

![Planning board](docs/images/board.png)

Tracker is one Node.js process with an embedded SQLite database. There are no external services to run: start the container, point a browser at it, and the first account you create becomes the administrator.

## Features

**Planning**
- A single prioritised backlog per project. Drag stories between the **Current iteration / Backlog**, **Icebox** and other panels, or reorder them.
- **Velocity**: the average number of points accepted over the last *N* iterations, adjusted for team strength and iteration length.
- **Automatic iteration planning**: the current iteration and future iterations fill from the backlog in priority order, up to velocity. Smaller stories never jump ahead of bigger ones, and a story that's bigger than velocity gets an iteration to itself.
- **Manual planning mode**: assign stories to iterations by number.
- **Iteration overrides**: set team strength (for example 50% during holidays, or 0% to skip an iteration) and change the length of individual iterations.
- **Release markers** with deadlines. Tracker projects when each release will be reached and flags releases that will miss their deadline.
- "What-if" velocity: click the velocity badge to see how the backlog would project at a different velocity.

**Stories**
- Story types: feature, bug, chore and release. Each has its own workflow rules:
  `unscheduled → unstarted → started → finished → delivered → accepted / rejected`.
  Features can't be started until they're estimated, chores go straight from started to accepted, and releases only have unstarted and accepted.
- Point scales: Fibonacci, linear, powers of two, or a custom scale. You can choose whether bugs and chores can be estimated.
- Each story can have owners, a requester, followers, labels, tasks (checklist), Markdown descriptions and comments, file attachments (drag, drop or paste), blockers (`#123` references link the blocking story) and reviews (Code, Design, QA, Security, or your own review types).
- `@mentions` and `#story` references.
- Clone stories, move them to another project, and edit stories in bulk (select several, then move, label, delete, or move to another project).

**Organising**
- **Epics** track progress through a label. They have a description and comments, and you can reorder them.
- **Labels** panel with story counts. Rename or delete labels.
- **Search** with a query language: `label:ui type:bug state:started owner:me -label:wontfix epic:"Onboarding" is:blocked has:attachment created_since:2026-01-01 includedone:true`.
- Panels: **My Work**, **Done** (completed iterations), **Project History** (full activity log) and **Workspaces** (several projects side by side).

**Collaboration**
- Realtime updates: boards refresh live when anyone makes a change, using Server-Sent Events.
- Notifications in the app and by email, for mentions, ownership, comments on stories you follow, deliveries waiting for your acceptance, acceptances and rejections, and review requests.
- Roles: owner, member and viewer. Projects can be public (read-only).
- Invitations, plus an invitation-only mode for the whole instance.

**Insight**
- **Analytics**: velocity history, burn-up, stories accepted by type, current-iteration breakdown, rejection counts and cycle time.

**Integration**
- **REST API** for everything. The UI uses the same API. There's an OpenAPI 3.1 spec, interactive docs at `/api/docs`, and a written guide in [`docs/api.md`](docs/api.md).
- **Webhooks**: every activity is POSTed as JSON and signed with HMAC-SHA256.
- **Commit linking**: reference stories in commit messages with `[Finishes #123]` or `[Delivers #123]`, sent either through a GitHub/GitLab/Gitea push webhook or by calling `POST /source_commits`.
- **CSV import and export.**

<p align="center"><img src="docs/images/story.png" width="49%" alt="Expanded story"> <img src="docs/images/analytics.png" width="49%" alt="Analytics"></p>

## Quick start

### Docker (recommended)

```sh
docker compose up -d
open http://localhost:3000
```

Data is stored in the `tracker-data` volume. Set `BASE_URL` in `docker-compose.yml` to your public URL. For reverse proxies, email, backups and upgrades, see **[docs/self-hosting.md](docs/self-hosting.md)**.

### From source

Requires Node.js 22.13 or later. Tracker uses Node's built-in SQLite, so there are no native modules to compile.

```sh
npm install
npm run build
npm start                 # http://localhost:3000, data in ./data
```

To load a demo project, run this against a fresh instance:

```sh
node scripts/demo-seed.mjs http://localhost:3000   # sign in as demo@example.com / password123
```

## Configuration

All configuration is through environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `BASE_URL` | `http://localhost:$PORT` | Public URL, used in links, emails and the `Secure` cookie flag |
| `DATA_DIR` | `./data` | Where the database and uploads live |
| `DATABASE_FILE` | `$DATA_DIR/tracker.db` | SQLite file location |
| `ALLOW_SIGNUP` | `true` | Default for open sign-up. Can be changed later under Administration |
| `SMTP_URL` | — | For example `smtps://user:pass@smtp.example.com:465`. Enables email |
| `MAIL_FROM` | `Tracker <tracker@localhost>` | Sender address |
| `MAX_UPLOAD_MB` | `50` | Maximum size of an attachment |
| `SESSION_DAYS` | `30` | How long a browser session lasts |
| `TRUST_PROXY` | `false` | Set to `true` behind a reverse proxy |
| `WEBHOOK_ALLOW_PRIVATE` | `false` | Allow webhooks to private, loopback or link-local addresses (blocked by default to prevent SSRF) |
| `MAX_STREAMS_PER_USER` | `20` | Maximum number of simultaneous live-update connections per user |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug` or `silent` |

## API

```sh
curl -H "X-TrackerToken: $TOKEN" http://localhost:3000/api/v1/projects
```

- Interactive reference: **`/api/docs`** on your instance
- OpenAPI document: `/api/openapi.json`, with a copy committed at [`docs/openapi.json`](docs/openapi.json)
- Guide with examples, covering authentication, the story workflow, search syntax, webhooks, realtime and commit integration: **[docs/api.md](docs/api.md)**

## Development

```sh
npm install
npm run dev          # API on :3000 (auto-reload) + Vite UI on :5173 (proxies /api)
npm test             # server test suite
npm run test:coverage
npm run typecheck    # server + web
npm run build && npm run test:e2e   # browser end-to-end smoke test against the production build
npm run openapi      # regenerate docs/openapi.json after an intentional API change
```

The test suite is designed to make refactoring safe:

| Suite | What it guards |
|---|---|
| `contract.test.ts` | The generated OpenAPI document must equal `docs/openapi.json`, so any API change shows up as a reviewable diff |
| `authz.matrix.test.ts` | Calls **every** documented operation as an anonymous client, a non-member and a viewer. New routes are covered automatically |
| `planning.property.test.ts` | Invariants of the planning engine (ordering, capacity, no back-filling, determinism) over 500 random projects |
| `security.test.ts` | Mass assignment, SQL identifiers, CSRF, SSRF, headers, log redaction, sessions, throttling |
| `workflow.test.ts` | The web UI's copy of the story workflow matches the server's |
| `search.test.ts`, `api.test.ts`, `iterations.test.ts` | Behaviour of every search filter, the API end to end, and planning examples |
| `e2e/smoke.test.mjs` | The production build in a real browser: setup, workflow, drag and drop, comments, live updates |

CI (`.github/workflows/ci.yml`) runs all of these, checks the OpenAPI document is current, and builds and boots the Docker image.

See [docs/architecture.md](docs/architecture.md) for how the code is organised and where to extend it.

Layout:

```
server/   Fastify + TypeScript API (node:sqlite). Route schemas (TypeBox) drive validation,
          serialization and the OpenAPI docs, so the docs always match behaviour.
  src/lib/iterations.ts   the velocity and iteration-planning engine (pure, unit-tested)
  src/services/           stories, search, activity/notifications/webhooks, projects
  src/routes/             HTTP endpoints
web/      React + Vite single-page app, served by the server in production
docs/     Self-hosting guide, API guide, OpenAPI spec
```

## Limitations

- Single process: realtime events are delivered in-process, so run **one** instance per database. SQLite in WAL mode comfortably handles teams of dozens to a few hundred people.
- No SSO/OAuth sign-in yet (email and password only).
- Commit integration links commits to stories; it does not track pull requests or branches.

---

*Tracker is an independent project and is not affiliated with Pivotal, VMware or Broadcom.*
