# Section 15 Runbook (Unified Multi-Page Console)

## 1. Environment

1. Copy `.env.example` to `.env`.
2. Set strong values for:
   - `MAIL_API_TOKEN`
   - `DASHBOARD_LOGIN_USER`
   - `DASHBOARD_LOGIN_PASS`
   - `DASHBOARD_SESSION_SECRET`
   - `DASHBOARD_OTP_TO`
   - `DASHBOARD_MAIL_PROBE_TO`
3. Public OTP-first mode defaults:
   - `DASHBOARD_IP_ALLOWLIST_ENABLED=false`
   - `DASHBOARD_OTP_PRIMARY_ENABLED=true`
4. Optional strict allowlist:
   - `DASHBOARD_IP_ALLOWLIST_ENABLED=true`
   - `DASHBOARD_ALLOWED_IPS=<your_public_ip>,127.0.0.1,::1`
5. Keep service localhost-bound:
   - `HOST=127.0.0.1`
   - `PORT=8081`
6. Optional mail probe tuning:
   - `DASHBOARD_MAIL_PROBE_COOLDOWN_SECONDS=300`

## 2. DNS Recovery Checklist (`NXDOMAIN`)

If browser shows `DNS_PROBE_FINISHED_NXDOMAIN` for `mail.stackpilot.in`:

1. Verify record:

```bash
dig +short mail.stackpilot.in A
```

2. If empty, add DNS at provider:

- Type: `A`
- Host: `mail`
- Value: `<VPS_PUBLIC_IP>`
- TTL: `300` (or provider default)

3. Re-check after propagation:

```bash
dig +short mail.stackpilot.in A
```

4. Confirm domain resolves before troubleshooting Nginx/app.

## 3. Start with PM2

```bash
pm2 start deploy/pm2/ecosystem.config.cjs
pm2 save
pm2 startup
```

Verify:

```bash
pm2 status
pm2 describe email-vps
ss -tulpn | grep 8081
```

Expected bind:

- `127.0.0.1:8081`

## 4. Nginx Reverse Proxy + TLS

1. Copy `deploy/nginx/mail.stackpilot.in.conf` to `/etc/nginx/sites-available/mail.stackpilot.in`.
2. Enable and reload:

```bash
sudo ln -s /etc/nginx/sites-available/mail.stackpilot.in /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

3. Create/renew certificate:

```bash
sudo certbot --nginx -d mail.stackpilot.in
```

## 5. Security Verification

```bash
ss -tulpn | grep 8081
ss -tulpn | grep ':25'
sudo ufw status
```

Targets:

- Node service local-only on `127.0.0.1:8081`
- SMTP listener local-only
- only 22/80/443 public

## 6. Functional Validation

Local health and login:

```bash
curl -i http://127.0.0.1:8081/health
curl -i http://127.0.0.1:8081/login
```

Dashboard auth/session:

```bash
curl -i https://mail.stackpilot.in/auth/session
```

OTP-first auth flow:

```bash
curl -i -c /tmp/email-vps.cookie -X POST https://mail.stackpilot.in/auth/otp/request
curl -i -b /tmp/email-vps.cookie -X POST https://mail.stackpilot.in/auth/otp/verify \
  -H 'Content-Type: application/json' \
  -d '{"code":"123456"}'
```

Dashboard APIs (after login cookie):

- `/api/v1/dashboard/overview`
- `/api/v1/dashboard/insights?window=24h`
- `/api/v1/dashboard/timeseries?window=24h`
- `/api/v1/dashboard/logs?severity=warning&q=<recipient_or_request_id>`
- `/api/v1/dashboard/activity`
- `/api/v1/dashboard/programs`
- `/api/v1/dashboard/mail-check`
- `/api/v1/dashboard/mail-probe` (POST)

Dashboard page routes:

- `/dashboard` (overview)
- `/dashboard/activity`
- `/dashboard/security`
- `/dashboard/health`
- `/dashboard/performance`
- `/dashboard/stability`
- `/dashboard/programs`
- `/dashboard/mail`

Mail API should remain non-public via local-only guard:

```bash
curl -i https://mail.stackpilot.in/api/v1/mail/health -H 'Authorization: Bearer <MAIL_API_TOKEN>'
```

Expected: `403 FORBIDDEN_NON_LOCAL` from public origin.

## 7. Mail UX Validation

Run local mail sends:

```bash
npm run mail:test -- --to you@example.com
npm run mail:send -- --to you@example.com --template system-alert --vars title=Test,summary=Check,severity=info
```

Validate inbox rendering:

- severity chip + incident ID in header
- sections: What happened / Impact / Probable cause / What to do now
- Dashboard + Runbook action buttons
- metadata footer present

## 8. Cron and Metrics

Ensure metrics cron remains active:

```bash
crontab -l | grep generate_metrics.sh
```

Expected cron entry:

```bash
* * * * * /home/devuser/dev/email-vps/generate_metrics.sh >/dev/null 2>&1
```

If you still receive cron errors for old `/opt/stackpilot-monitor` path:

```bash
bash /home/devuser/dev/email-vps/deploy/ops/fix_metrics_cron.sh audit
bash /home/devuser/dev/email-vps/deploy/ops/fix_metrics_cron.sh apply-user
sudo bash /home/devuser/dev/email-vps/deploy/ops/fix_metrics_cron.sh audit-root
sudo bash /home/devuser/dev/email-vps/deploy/ops/fix_metrics_cron.sh apply-root
```

This removes stale user/root cron entries, sets `MAILTO=""`, and keeps observability in dashboard alerts.

## 9. Troubleshooting Matrix

- `NXDOMAIN`: DNS A record missing or not propagated.
- `404` on `https://mail.stackpilot.in/login` right after successful certbot:
  - cause: certbot may attach `mail.stackpilot.in` blocks to `/etc/nginx/sites-available/default` with static `try_files`.
  - fix: run `sudo bash /home/devuser/dev/email-vps/deploy/nginx/fix_mail_stackpilot_vhost.sh`
  - verify:
    - `curl -I http://mail.stackpilot.in/login` -> `301`
    - `curl -I https://mail.stackpilot.in/login` -> `200/302`
- `403` on dashboard pages/APIs with `FORBIDDEN_IP`:
  - applies only when `DASHBOARD_IP_ALLOWLIST_ENABLED=true`.
  - check current client IP from your access device (`curl -4 https://api.ipify.org`).
  - update `.env` `DASHBOARD_ALLOWED_IPS=<current_client_ip>,127.0.0.1,::1`.
  - apply with `pm2 restart email-vps --update-env && pm2 save`.
- `401` on dashboard APIs: missing/expired session cookie.
- local start fails with secret length/comment issues: quote `DASHBOARD_SESSION_SECRET` if it contains `#`.
- dashboard loads but charts empty: no snapshots yet; wait for snapshot worker or trigger refresh after traffic.
- cron spam with `/opt/stackpilot-monitor/generate_metrics.sh: not found`:
  - cause: stale cron entry from legacy monitor path.
  - fix: run `deploy/ops/fix_metrics_cron.sh` for both user and root scopes and confirm new cron path under `/home/devuser/dev/email-vps`.

## 10. Rollback

1. Stop service:

```bash
pm2 stop email-vps
```

2. Disable Nginx site if needed:

```bash
sudo rm /etc/nginx/sites-enabled/mail.stackpilot.in
sudo nginx -t
sudo systemctl reload nginx
```

3. Restore previous app revision and restart PM2.
