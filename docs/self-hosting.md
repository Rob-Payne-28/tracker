# Self-hosting Tracker

Tracker runs as a single Node.js process. All of its state lives in one directory (`DATA_DIR`):

```
data/
  tracker.db        SQLite database (plus tracker.db-wal / tracker.db-shm while running)
  uploads/          file attachments
```

## Running with Docker Compose

```yaml
services:
  tracker:
    image: tracker:latest     # build with `docker compose build`
    build: .
    restart: unless-stopped
    ports: ["3000:3000"]
    environment:
      BASE_URL: https://tracker.example.com
      TRUST_PROXY: "true"
      SMTP_URL: smtps://user:password@smtp.example.com:465
      MAIL_FROM: Tracker <tracker@example.com>
    volumes:
      - tracker-data:/data
volumes:
  tracker-data:
```

After `docker compose up -d`, open the site. Because no accounts exist yet, it shows **Set up your Tracker**. The first account becomes the instance administrator.

The image runs as the unprivileged `node` user, keeps all state in the `/data` volume, and exposes a health check at `GET /healthz`.

## Running without Docker

```sh
npm ci
npm run build
DATA_DIR=/var/lib/tracker BASE_URL=https://tracker.example.com npm start
```

Here is an example systemd unit:

```ini
[Unit]
Description=Tracker
After=network.target

[Service]
User=tracker
WorkingDirectory=/opt/tracker
Environment=NODE_ENV=production DATA_DIR=/var/lib/tracker BASE_URL=https://tracker.example.com TRUST_PROXY=true
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server/dist/index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## Reverse proxy & TLS

Put Tracker behind any reverse proxy that terminates TLS, and set `TRUST_PROXY=true`. Set `BASE_URL` to the `https://` URL; this also marks session cookies as `Secure`.

The live board uses Server-Sent Events on `/api/v1/events`. Make sure your proxy doesn't buffer that endpoint. Tracker already sends `X-Accel-Buffering: no`, which nginx respects.

**Caddy**

```
tracker.example.com {
  reverse_proxy localhost:3000
}
```

**nginx**

```nginx
server {
  server_name tracker.example.com;
  client_max_body_size 60m;            # >= MAX_UPLOAD_MB
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 1h;             # long-lived event streams
  }
}
```

## Email

Set `SMTP_URL` (any URL that [Nodemailer](https://nodemailer.com/smtp/) accepts) to enable:

- notification emails (users can turn them off in their profile)
- invitation emails
- self-service password resets

Without email, Tracker still works:

- Invitation links are shown to the person who invites someone, so they can share them directly.
- Administrators can generate password-reset links under **Administration**.

## Accounts & access

- **Open sign-up vs. invitation only**: set the default with `ALLOW_SIGNUP`. An administrator can change it at any time under **Administration**.
- **Project owners** invite people by email from **Project → Settings → Members**. Unknown emails get an invitation link.
- **Administrators** can create, deactivate or delete users, generate reset links, and see every project (`GET /api/v1/projects?all=true`). An administrator has owner rights in every project.

## Backups

The database is SQLite in WAL mode. Copying `tracker.db` alone while the server is running is **not** safe.

Use one of these methods instead:

```sh
# Online, consistent snapshot (sqlite3 CLI):
sqlite3 /data/tracker.db ".backup '/backups/tracker-$(date +%F).db'"
rsync -a /data/uploads/ /backups/uploads/
```

or stop the container and copy the whole data directory.

To restore, put `tracker.db` and `uploads/` back into `DATA_DIR` and start Tracker.

For logical backups, `GET /api/v1/projects/{id}/export.csv` exports each project's stories as CSV.

## Upgrading

```sh
git pull && docker compose build && docker compose up -d
```

Database migrations run automatically at startup. Take a backup before upgrading.

## Maintenance tasks (automatic)

Every 6 hours, and at startup, Tracker:

- removes expired sessions
- removes uploads that were never attached to a comment within 24 hours
- removes stored files whose stories or comments have been deleted

## Security notes

- Passwords are hashed with scrypt. Changing your password signs out your other sessions.
- API tokens act as passwords. A user can regenerate theirs from their profile, and the old token stops working immediately. Tokens passed in URLs (`?token=`, used for event streams, download links and repository webhooks) are redacted from logs.
- Sign-in attempts are rate limited per IP address and account, and failed sign-ins take the same time whether or not the account exists.
- **CSRF**: requests authenticated with the browser session cookie that change data must come from Tracker's own origin (checked using the `Origin` or `Referer` header). API clients that use tokens are unaffected. If you serve Tracker under several hostnames, set `BASE_URL` to the one people use.
- **SSRF**: webhooks can't target private, loopback, link-local or other non-public addresses. This is checked when a webhook is saved and again when Tracker connects, which defeats DNS rebinding. Redirects are never followed. Set `WEBHOOK_ALLOW_PRIVATE=true` only if you need to deliver webhooks inside your network.
- Request bodies are restricted to documented fields. Unknown fields are dropped before they reach the application.
- Response headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy`. The web app is served with a strict `Content-Security-Policy` (scripts from the same origin only).
- Uploaded files are served with `Content-Security-Policy: sandbox` and `nosniff`. Only safe media types are shown inline.
- Each user can have at most `MAX_STREAMS_PER_USER` live-update connections open.
- Project owners can invite new people by email, which creates an account even when open sign-up is disabled. If your instance should be strictly admin-provisioned, keep that in mind when deciding who may create projects.

## Sizing

One small VM (1 vCPU, 512 MB RAM) is plenty for most teams. Iteration planning is computed on demand from the stories in the project, so even projects with thousands of stories respond in milliseconds. Run exactly **one** Tracker process per data directory.
