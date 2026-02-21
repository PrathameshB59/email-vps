# email-vps

Single-process Email-VPS service with:

- Local-only mail API (`/api/v1/mail/*`) protected by bearer token.
- One multi-page operations console with:
  - mandatory two-step auth: email OTP first, then credentials,
  - public direct credential login blocked by default,
  - localhost break-glass fallback (optional),
  - signed HttpOnly session cookie,
  - optional IP allowlist toggle.
- SQLite-backed queue/events/quota plus dashboard metric snapshots (90-day retention).
- Balanced NOC overview plus dedicated deep-dive pages for activity, security, health, performance, stability, programs, and mail checks.
- Operations control subnav for AIDE, Fail2Ban, relay, postfix, crontab/logwatch, and rclone backup monitoring.

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
- `DASHBOARD_AUTH_FLOW=otp_then_credentials`
- `DASHBOARD_OTP_TO`
- `DASHBOARD_OTP_FROM` (optional sender override)
- `DASHBOARD_MAIL_PROBE_TO`
- `DASHBOARD_MAIL_PROBE_COOLDOWN_SECONDS`

Optional hardening values:

- `DASHBOARD_IP_ALLOWLIST_ENABLED=true`
- `DASHBOARD_ALLOWED_IPS=<comma-separated-operator-ips>`
- `DASHBOARD_LOCAL_FALLBACK_ENABLED=false` (disable localhost break-glass)

Optional rclone monitor values:

- `DASHBOARD_RCLONE_REMOTE` (default `gdrive`)
- `DASHBOARD_RCLONE_TARGET` (default `gdrive:vps/devuser`)
- `DASHBOARD_RCLONE_BACKUP_DIR` (default `/home/devuser/backups`)
- `DASHBOARD_RCLONE_BACKUP_SCRIPT` (default `/home/devuser/backup-nightly.sh`)
- `DASHBOARD_RCLONE_AUTOSYNC_SCRIPT` (default `/home/devuser/auto-sync.sh`)
- `DASHBOARD_RCLONE_BACKUP_LOG` (default `/home/devuser/backups/backup.log`)
- `DASHBOARD_RCLONE_SYNC_LOG` (default `/home/devuser/backups/sync.log`)
- `DASHBOARD_RCLONE_CONFIG_PATH` (default `/home/devuser/.config/rclone/rclone.conf`)
- `DASHBOARD_RCLONE_STALE_HOURS` (default `24`)

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
- `POST /auth/login` (step 2, requires OTP pre-auth for public requests)
- `POST /auth/otp/request`
- `POST /auth/otp/verify` (step 1 only, no session issuance)
- `POST /auth/logout`
- `GET /auth/session`
- `GET /dashboard`
- `GET /dashboard/activity`
- `GET /dashboard/security`
- `GET /dashboard/health`
- `GET /dashboard/performance`
- `GET /dashboard/stability`
- `GET /dashboard/programs`
- `GET /dashboard/operations`
- `GET /dashboard/operations/aide`
- `GET /dashboard/operations/fail2ban`
- `GET /dashboard/operations/relay`
- `GET /dashboard/operations/postfix`
- `GET /dashboard/operations/crontab`
- `GET /dashboard/operations/rclone`
- `GET /dashboard/mail`

Protected dashboard data APIs:

- `GET /api/v1/dashboard/overview`
- `GET /api/v1/dashboard/trends?window=24h|7d|30d`
- `GET /api/v1/dashboard/timeseries?window=24h|7d|30d`
- `GET /api/v1/dashboard/insights?window=24h|7d|30d`
- `GET /api/v1/dashboard/logs?status=&category=&severity=&q=`
- `GET /api/v1/dashboard/alerts`
- `GET /api/v1/dashboard/security`
- `GET /api/v1/dashboard/activity`
- `GET /api/v1/dashboard/programs`
- `GET /api/v1/dashboard/operations?window=24h|7d|30d`
- `GET /api/v1/dashboard/operations/control/:control?window=24h|7d|30d`
- `GET /api/v1/dashboard/ops-events?source=&status=&severity=&window=&limit=&offset=`
- `POST /api/v1/dashboard/operations/recheck`
- `GET /api/v1/dashboard/mail-check`
- `POST /api/v1/dashboard/mail-probe`
- `GET /api/v1/dashboard/otp-delivery` (authenticated diagnostics)

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
- `dashboard_otp_challenges`
- `dashboard_otp_daily_quota`
- `dashboard_otp_delivery_events`
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

## Cron Noise Remediation (`/opt/stackpilot-monitor` legacy)

If inbox receives cron errors for missing `/opt/stackpilot-monitor/generate_metrics.sh`, run:

```bash
bash deploy/ops/fix_metrics_cron.sh audit
bash deploy/ops/fix_metrics_cron.sh apply-user
sudo bash deploy/ops/fix_metrics_cron.sh audit-root
sudo bash deploy/ops/fix_metrics_cron.sh apply-root
```

This removes stale user/root cron references, applies:

`* * * * * /home/devuser/dev/email-vps/generate_metrics.sh >/dev/null 2>&1`

and sets `MAILTO=""` for silent cron delivery.  
Use dashboard alerts + logs for failure observability.

## Postfix Duplicate Warning Remediation (`main.cf`)

If Logwatch/cron reports warnings such as:

- `overriding earlier entry: relayhost=...`
- `overriding earlier entry: smtp_tls_security_level=...`

run the postfix fixer and verify config health:

```bash
sudo bash /home/devuser/dev/email-vps/deploy/ops/fix_postfix_config.sh
sudo postconf -n | grep -E 'relayhost|smtp_tls_security_level'
sudo tail -n 120 /var/log/mail.log | grep -E 'overriding earlier entry|postfix'
```

Then recheck from dashboard:

```bash
curl -i -b /tmp/email-vps.cookie -X POST https://mail.stackpilot.in/api/v1/dashboard/operations/recheck
curl -i -b /tmp/email-vps.cookie "https://mail.stackpilot.in/api/v1/dashboard/ops-events?source=postfix&status=open&limit=20&offset=0"
```

## Operations Collector Validation

Validate deep-ops state end-to-end:

```bash
curl -i -b /tmp/email-vps.cookie "https://mail.stackpilot.in/api/v1/dashboard/operations?window=24h"
curl -i -b /tmp/email-vps.cookie "https://mail.stackpilot.in/api/v1/dashboard/ops-events?source=cron&status=open&limit=20&offset=0"
curl -i -b /tmp/email-vps.cookie "https://mail.stackpilot.in/api/v1/dashboard/ops-events?source=logwatch&status=open&limit=20&offset=0"
curl -i -b /tmp/email-vps.cookie "https://mail.stackpilot.in/api/v1/dashboard/mail-check"
curl -i -b /tmp/email-vps.cookie "https://mail.stackpilot.in/api/v1/dashboard/programs"
```

Expected:

- controls include AIDE/Fail2Ban/relay/postfix/cron/logwatch/rclone signals
- timeline contains open/resolved event lifecycle with fingerprints
- stale `/opt/stackpilot-monitor` references report in cron diagnostics when present

## Operations Route Recovery Checklist

If `https://mail.stackpilot.in/dashboard/operations` or nested control pages return `Cannot GET`:

1. verify current runtime is refreshed:

```bash
pm2 restart email-vps --update-env
pm2 save
```

2. validate routes:

```bash
curl -i https://mail.stackpilot.in/dashboard/operations
curl -i https://mail.stackpilot.in/dashboard/operations/postfix
curl -i https://mail.stackpilot.in/dashboard/operations/rclone
curl -i -b /tmp/email-vps.cookie "https://mail.stackpilot.in/api/v1/dashboard/operations/control/postfix?window=24h"
curl -i -b /tmp/email-vps.cookie "https://mail.stackpilot.in/api/v1/dashboard/operations/control/rclone?window=24h"
```

3. expected:
- page routes return `200` HTML
- control API returns `200` JSON

If deep pages stay on `Loading ...`, hard-refresh once after deploy so updated page module bootstrap is loaded.

## Rclone Control Diagnostics (Monitor-Only)

Rclone control is a read-only diagnostics view. It does not run sync/copy actions from the UI.

Quick checks:

```bash
rclone version
rclone listremotes
rclone lsd gdrive:
ls -lah /home/devuser/backups | tail -n 20
tail -n 80 /home/devuser/backups/backup.log
tail -n 80 /home/devuser/backups/sync.log
```

## Lighthouse Clean-Profile Audit Procedure

Use clean-profile Chrome runs for consistent baselines (extensions can skew results):

1. Open an incognito window with extensions disabled.
2. Audit:
   - `https://mail.stackpilot.in/dashboard/activity`
   - `https://mail.stackpilot.in/dashboard/operations`
3. Check and record:
   - Performance
   - Best Practices
   - SEO
   - CLS, render-blocking requests, and JS payload findings
4. Keep CSP in report-only during tuning; move to enforce mode only after verification.

Reference baseline (captured February 19, 2026, clean-profile target run):

- `/dashboard/activity`: Performance `79`, Accessibility `100`, Best Practices `81`, SEO `90`
- primary remaining optimizations: CLS stabilization on masthead/nav and route JS payload tuning

## Deployment Assets

- Nginx: `deploy/nginx/mail.stackpilot.in.conf`
- PM2: `deploy/pm2/ecosystem.config.cjs`
- Cron fixer: `deploy/ops/fix_metrics_cron.sh`
- Runbook: `docs/SECTION15_RUNBOOK.md`

## Tests

```bash
npm test
```
