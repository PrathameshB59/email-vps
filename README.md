# email-vps

Single-process Email-VPS service with:

- Local-only mail API (`/api/v1/mail/*`) protected by bearer token.
- One private web dashboard (`/login` -> `/dashboard`) protected by:
  - env-based credentials,
  - signed HttpOnly session cookie,
  - IP allowlist.
- SQLite-backed queue/events/quota plus dashboard metric snapshots (90-day retention).
- Balanced NOC dashboard UI with Chart.js-driven operational insights.

## Install

```bash
npm install
cp .env.example .env
```

## Required `.env` values

- `MAIL_API_TOKEN`
- `MAIL_FROM`
- `DASHBOARD_LOGIN_USER`
- `DASHBOARD_LOGIN_PASS`
- `DASHBOARD_SESSION_SECRET`
- `DASHBOARD_ALLOWED_IPS`

Production bind:

- `HOST=127.0.0.1`
- `PORT=8081`

## Run

```bash
npm start
```

## Dashboard Routes

Auth and pages:

- `GET /login`
- `POST /auth/login`
- `POST /auth/logout`
- `GET /auth/session`
- `GET /dashboard`

Protected dashboard data APIs:

- `GET /api/v1/dashboard/overview`
- `GET /api/v1/dashboard/trends?window=24h|7d|30d`
- `GET /api/v1/dashboard/timeseries?window=24h|7d|30d`
- `GET /api/v1/dashboard/insights?window=24h|7d|30d`
- `GET /api/v1/dashboard/logs?status=&category=&severity=&q=`
- `GET /api/v1/dashboard/alerts`
- `GET /api/v1/dashboard/security`

Compatibility behavior:

- `/admin/*` -> `302 /dashboard`
- `/api/v1/admin/*` -> `410 ADMIN_API_DEPRECATED`

## Mail API

All `/api/v1/mail/*` routes require:

- `Authorization: Bearer <MAIL_API_TOKEN>`
- loopback source (`127.0.0.1` / `::1`) unless `MAIL_ALLOW_NON_LOCAL=true`

Routes:

- `POST /api/v1/mail/send`
- `POST /api/v1/mail/send-template`
- `GET /api/v1/mail/health`
- `GET /api/v1/mail/quota`
- `GET /api/v1/mail/events`

## Template Variables (Ops Incident Digest)

`system-alert` and `app-notification` support:

- required/common: `title`, `severity`, `details`
- optional incident context: `summary`, `impact`, `probableCause`, `recommendedAction`, `nextUpdateEta`
- metadata/action links: `environment`, `service`, `incidentId`, `requestId`, `dashboardUrl`, `runbookUrl`, `timestamp`

## CLI

```bash
npm run mail:test -- --to you@example.com
npm run mail:send -- --to you@example.com --template system-alert --vars title=CPU,summary=High,probableCause=Load,severity=warning
```

## Storage

SQLite file:

- `data/email_vps.sqlite`

Primary active tables:

- `mail_queue`
- `mail_events`
- `daily_quota`
- `system_alert_state`
- `dashboard_metric_snapshots`
- `admin_auth_events` (dashboard login audit trail)

## Public Access Recovery (NXDOMAIN)

If `mail.stackpilot.in` is not reachable publicly but local app works:

1. Verify DNS:

```bash
dig +short mail.stackpilot.in A
```

2. If empty, create DNS record at provider:

- Type: `A`
- Host: `mail`
- Value: `<your_vps_public_ip>`

3. Verify Nginx and TLS:

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d mail.stackpilot.in
```

4. Validate local app still healthy:

```bash
curl -i http://127.0.0.1:8081/health
curl -i http://127.0.0.1:8081/login
```

## Deployment Assets

- Nginx: `deploy/nginx/mail.stackpilot.in.conf`
- PM2: `deploy/pm2/ecosystem.config.cjs`
- Runbook: `docs/SECTION15_RUNBOOK.md`

## Tests

```bash
npm test
```
