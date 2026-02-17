# Section 15 Deployment Runbook

## 1. Environment

1. Copy `.env.example` to `.env`.
2. Set strong values for:
   - `ADMIN_JWT_ACCESS_SECRET`
   - `ADMIN_JWT_REFRESH_SECRET`
   - `ADMIN_ALLOWED_ORIGIN`
3. Seed first admin account:

```bash
npm run seed:admin -- --email admin@stackpilot.in --password 'StrongPasswordHere'
```

## 2. Start Services with PM2

```bash
pm2 start deploy/pm2/admin-ecosystem.config.cjs
pm2 save
pm2 startup
```

Verify:

```bash
pm2 status
pm2 describe email-vps-admin
```

Expected admin bind:

- `127.0.0.1:9100`

## 3. Nginx Reverse Proxy

1. Copy `deploy/nginx/mail.stackpilot.in.conf` to `/etc/nginx/sites-available/mail.stackpilot.in`.
2. Enable site:

```bash
sudo ln -s /etc/nginx/sites-available/mail.stackpilot.in /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

3. Create SSL:

```bash
sudo certbot --nginx -d mail.stackpilot.in
```

## 4. Security Verification

1. Confirm only 22/80/443 are public in UFW.
2. Confirm admin backend is local-only:

```bash
ss -tulpn | grep 9100
```

3. Confirm SMTP exposure policy:

```bash
ss -tulpn | grep ':25'
```

Target: localhost-only for postfix listener.

## 5. API Validation

1. Login endpoint:

```bash
curl -s -X POST http://127.0.0.1:9100/api/v1/admin/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@stackpilot.in","password":"StrongPasswordHere"}'
```

2. Use access token to fetch overview:

```bash
curl -s http://127.0.0.1:9100/api/v1/admin/overview \
  -H 'Authorization: Bearer <ACCESS_TOKEN>'
```

## 6. Rollback

1. Stop admin app:

```bash
pm2 stop email-vps-admin
```

2. Disable nginx site if needed:

```bash
sudo rm /etc/nginx/sites-enabled/mail.stackpilot.in
sudo nginx -t
sudo systemctl reload nginx
```

3. Keep mail relay app (`email-vps`) running independently.
