# email-vps

Phase 1+2 implementation for secure VPS email delivery (Postfix relay based) while preserving the existing monitoring dashboard.

## What This Service Does

- Serves the existing `dashboard.html` and `metrics.json` monitor view on port `8081`.
- Provides secured mail API endpoints at `/api/v1/mail/*`.
- Uses local Postfix relay (`127.0.0.1:25` by default) for outbound mail.
- Enforces a global `500/day` quota by default.
- Persists queue, attempts, and quota state in SQLite.
- Retries transient delivery failures with exponential backoff.

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Create environment file:

```bash
cp .env.example .env
```

3. Edit `.env` and set at minimum:

- `MAIL_API_TOKEN`
- `MAIL_FROM`

4. Start service:

```bash
npm start
```

Service defaults:

- Dashboard: `http://<host>:8081/dashboard.html`
- Mail API base: `http://<host>:8081/api/v1/mail`

## API Contracts

All `/api/v1/mail/*` endpoints require:

- `Authorization: Bearer <MAIL_API_TOKEN>`
- Loopback source IP by default (`127.0.0.1` / `::1`)

### `POST /api/v1/mail/send`

Request:

```json
{
  "to": "user@example.com",
  "subject": "Alert",
  "text": "CPU high",
  "category": "system-alert"
}
```

### `POST /api/v1/mail/send-template`

Request:

```json
{
  "to": "user@example.com",
  "template": "system-alert",
  "variables": {
    "title": "CPU Spike",
    "severity": "warning",
    "service": "nginx",
    "details": "Load average is elevated"
  }
}
```

### `GET /api/v1/mail/health`

Returns relay verification, queue counts, and quota snapshot.

### `GET /api/v1/mail/quota`

Returns current-day usage against configured daily limit.

## CLI Workflows

Send a direct test email:

```bash
npm run mail:test -- --to you@example.com
```

Send a templated email:

```bash
npm run mail:send -- --to you@example.com --template system-alert --vars title=CPU,details=High%20load,severity=warning
```

## Data and Persistence

SQLite database path defaults to:

- `/home/devuser/dev/email-vps/data/email_vps.sqlite`

Tables:

- `mail_queue`
- `mail_events`
- `daily_quota`

Retention cleanup:

- Old `mail_events` rows are pruned (default 30 days).

## Postfix Relay Checks

Verify Postfix is active:

```bash
sudo systemctl status postfix
```

Verify SMTP is local-only:

```bash
sudo ss -tulpn | grep ':25'
```

Expected local-only bind.

Quick send test from host:

```bash
echo "relay test" | mail -s "Email VPS relay test" your_email@example.com
```

## Cron and PM2

Metrics generation every minute:

```cron
* * * * * /home/devuser/dev/email-vps/generate_metrics.sh
```

Run app with PM2:

```bash
pm2 start src/server.js --name email-vps
pm2 save
pm2 startup
```

## Troubleshooting

- `UNAUTHORIZED`: invalid/missing bearer token.
- `FORBIDDEN_NON_LOCAL`: API called from non-loopback address.
- `DAILY_QUOTA_EXCEEDED`: day limit reached.
- Relay verify failed in health endpoint:
  - check `postfix` is running,
  - confirm local port/host in `.env`,
  - inspect `/var/log/mail.log`.

## Notes

- No VPS progress HTML files are modified by this implementation.
- This phase intentionally excludes SPF/DKIM/DMARC/PTR setup.
