# email-vps

Email-VPS now includes:

- Phase 1+2 mail relay implementation (Postfix relay + queue + retries + quota + templates).
- Section 15 secure admin dashboard service on localhost `127.0.0.1:9100`.

## Services

1. Mail service (`src/server.js`)
- Serves `dashboard.html` and `metrics.json` on port `8081`.
- Exposes `/api/v1/mail/*` with loopback-only + bearer token protection.

2. Admin service (`src/admin/server.js`)
- Serves `/admin/login`, `/admin/dashboard`, `/admin/logs`, `/admin/alerts`.
- Exposes `/api/v1/admin/*` with JWT access/refresh auth.
- Runs on `127.0.0.1:9100` behind Nginx reverse proxy.

## Install

```bash
npm install
cp .env.example .env
```

Set strong secrets in `.env`:

- `MAIL_API_TOKEN`
- `MAIL_FROM`
- `ADMIN_JWT_ACCESS_SECRET`
- `ADMIN_JWT_REFRESH_SECRET`

## Run

Mail service:

```bash
npm run start:mail
```

Admin service:

```bash
npm run start:admin
```

## Mail API

All routes require:

- `Authorization: Bearer <MAIL_API_TOKEN>`
- Loopback source by default (`127.0.0.1` / `::1`)

Routes:

- `POST /api/v1/mail/send`
- `POST /api/v1/mail/send-template`
- `GET /api/v1/mail/health`
- `GET /api/v1/mail/quota`
- `GET /api/v1/mail/events`

## Admin API

Auth routes:

- `POST /api/v1/admin/auth/login`
- `POST /api/v1/admin/auth/refresh`
- `POST /api/v1/admin/auth/logout`

Protected routes:

- `GET /api/v1/admin/overview`
- `GET /api/v1/admin/logs`
- `GET /api/v1/admin/quota`
- `GET /api/v1/admin/alerts`
- `GET /api/v1/admin/relay-health`

## CLI

```bash
npm run mail:test -- --to you@example.com
npm run mail:send -- --to you@example.com --template system-alert --vars title=CPU,details=High,severity=warning
```

Seed admin user:

```bash
npm run seed:admin -- --email admin@stackpilot.in --password 'StrongPasswordHere'
```

## Data Storage

SQLite DB:

- `data/email_vps.sqlite`

Primary tables:

- `mail_queue`
- `mail_events`
- `daily_quota`
- `admin_users`
- `admin_sessions`
- `admin_auth_events`
- `system_alert_state`

## Runtime Checkpoints

PM2 target scripts:

- `email-vps` -> `/home/devuser/dev/email-vps/src/server.js`
- `email-vps-admin` -> `/home/devuser/dev/email-vps/src/admin/server.js`

Metrics cron target:

- `* * * * * /home/devuser/dev/email-vps/generate_metrics.sh`

Postfix check:

```bash
systemctl status postfix
ss -tulpn | grep ':25'
```

Security target is localhost-only SMTP listener. If your host currently exposes `:25`, apply privileged hardening:

```bash
sudo postconf -e 'inet_interfaces = loopback-only'
sudo systemctl restart postfix
```

## Deployment Artifacts

- Nginx config: `deploy/nginx/mail.stackpilot.in.conf`
- PM2 ecosystem: `deploy/pm2/admin-ecosystem.config.cjs`
- Section 15 runbook: `docs/SECTION15_RUNBOOK.md`

## Tests

```bash
npm test
```

Covers env parsing, retry policy, quota behavior, queue recovery, API auth/local-only enforcement, template rendering, and metrics path migration.
