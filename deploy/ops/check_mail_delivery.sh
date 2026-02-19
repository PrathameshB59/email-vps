#!/usr/bin/env bash
# check_mail_delivery.sh — Diagnose Postfix → Gmail delivery gap
# Run on VPS as devuser (some commands may need sudo)
set -euo pipefail

SEP="━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

section() {
  echo ""
  echo "$SEP"
  echo "  $1"
  echo "$SEP"
}

# ── 1. Postfix queue ─────────────────────────────────────────
section "Postfix Mail Queue (mailq)"
if command -v mailq &>/dev/null; then
  mailq || echo "[OK] Queue is empty."
else
  echo "[WARN] mailq not found. Trying postqueue..."
  postqueue -p 2>/dev/null || echo "[WARN] postqueue also unavailable."
fi

# ── 2. Recent Postfix mail log ───────────────────────────────
section "Recent Mail Log (/var/log/mail.log — last 80 lines)"
if [ -f /var/log/mail.log ]; then
  tail -80 /var/log/mail.log
elif [ -f /var/log/maillog ]; then
  tail -80 /var/log/maillog
else
  echo "[WARN] No mail log found at /var/log/mail.log or /var/log/maillog"
fi

# ── 3. Search for known health-check message IDs ─────────────
section "Health-Check Message ID Search in Mail Log"
# Message IDs seen in DB for recent health checks
MSG_IDS=(
  "8dc6ee6a-3780-b4ee-3a7f-3841aa91dc04"
  "1e58e121-4575-37d9-13e4-9f9376b63f43"
)
LOG_FILES=(/var/log/mail.log /var/log/maillog)
FOUND=false
for LOGF in "${LOG_FILES[@]}"; do
  if [ -f "$LOGF" ]; then
    for MID in "${MSG_IDS[@]}"; do
      MATCHES=$(grep -F "$MID" "$LOGF" 2>/dev/null | head -20 || true)
      if [ -n "$MATCHES" ]; then
        echo "Found '$MID' in $LOGF:"
        echo "$MATCHES"
        FOUND=true
      fi
    done
  fi
done
if [ "$FOUND" = "false" ]; then
  echo "[INFO] Known message IDs not found in logs (may have been rotated)."
fi

# ── 4. Postfix key config settings ───────────────────────────
section "Postfix Config: Key Relay Settings (main.cf)"
MAIN_CF="/etc/postfix/main.cf"
if [ -f "$MAIN_CF" ]; then
  KEYS=(relayhost mynetworks inet_interfaces smtp_sasl_auth_enable
        smtp_sasl_password_maps smtp_tls_security_level
        smtpd_relay_restrictions myorigin mydestination myhostname)
  for K in "${KEYS[@]}"; do
    VAL=$(grep -E "^[[:space:]]*${K}[[:space:]]*=" "$MAIN_CF" 2>/dev/null | head -1 || true)
    if [ -n "$VAL" ]; then
      echo "$VAL"
    else
      echo "$K = (not set in main.cf — using default)"
    fi
  done
else
  echo "[WARN] /etc/postfix/main.cf not found."
fi

# ── 5. Postfix actual running values ─────────────────────────
section "Postfix Running Config: postconf -n (non-default values)"
if command -v postconf &>/dev/null; then
  postconf -n 2>/dev/null || echo "[WARN] postconf failed."
else
  echo "[WARN] postconf not found."
fi

# ── 6. DKIM / opendkim status ────────────────────────────────
section "DKIM Signing: opendkim Status"
if command -v systemctl &>/dev/null; then
  systemctl status opendkim 2>/dev/null | head -20 || echo "[INFO] opendkim not installed or not running."
fi
# Check if opendkim is in Postfix milter config
if [ -f "$MAIN_CF" ]; then
  MILTER=$(grep -E "smtpd_milters|non_smtpd_milters" "$MAIN_CF" 2>/dev/null | head -4 || true)
  if [ -n "$MILTER" ]; then
    echo ""
    echo "Postfix milter config:"
    echo "$MILTER"
  else
    echo "[WARN] No milter (DKIM) configured in main.cf — outgoing mail is NOT DKIM-signed."
  fi
fi

# ── 7. SPF / DNS check for sender domain ─────────────────────
section "SPF DNS Check for Sender Domain"
SENDER_DOMAIN=""
if [ -f /home/devuser/dev/email-vps/.env ]; then
  MAIL_FROM=$(grep -E "^MAIL_FROM=" /home/devuser/dev/email-vps/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' || true)
  if [ -n "$MAIL_FROM" ]; then
    # Extract domain from "Name <user@domain>" or "user@domain"
    SENDER_DOMAIN=$(echo "$MAIL_FROM" | grep -oE '[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' | tail -1 || true)
  fi
fi
if [ -n "$SENDER_DOMAIN" ]; then
  echo "Sender domain: $SENDER_DOMAIN"
  if command -v dig &>/dev/null; then
    echo ""
    echo "SPF TXT record:"
    dig +short TXT "$SENDER_DOMAIN" 2>/dev/null | grep -i spf | head -3 || echo "[INFO] No SPF TXT record found."
    echo ""
    echo "MX records:"
    dig +short MX "$SENDER_DOMAIN" 2>/dev/null | head -5 || echo "[INFO] No MX records."
  elif command -v nslookup &>/dev/null; then
    echo "SPF TXT record:"
    nslookup -type=TXT "$SENDER_DOMAIN" 2>/dev/null | grep -i spf | head -3 || echo "[INFO] No SPF TXT record found."
  else
    echo "[WARN] dig/nslookup not available for DNS checks."
  fi
else
  echo "[WARN] Could not determine MAIL_FROM domain from .env"
fi

# ── 8. Postfix routing test ───────────────────────────────────
section "Postfix Routing Test for Gmail"
if command -v postmap &>/dev/null; then
  echo "Testing routing for prathameshbirajdar.pc2@gmail.com:"
  sendmail -bv prathameshbirajdar.pc2@gmail.com 2>/dev/null | head -10 || echo "[INFO] sendmail -bv not available or returned error."
fi

# ── 9. Recent health-check emails from DB ────────────────────
section "Recent Health Check Events from SQLite DB"
DB_PATH="/home/devuser/dev/email-vps/email_vps.sqlite"
if [ ! -f "$DB_PATH" ]; then
  DB_PATH="/home/devuser/dev/email-vps/data/email_vps.sqlite"
fi
if [ -f "$DB_PATH" ] && command -v sqlite3 &>/dev/null; then
  echo "Last 10 health-check events:"
  sqlite3 "$DB_PATH" "
    SELECT
      id,
      substr(created_at, 1, 19) as created,
      status,
      category,
      to_email,
      error_code,
      substr(metadata_json, 1, 100) as meta
    FROM mail_events
    WHERE category IN ('health-check', 'postfix-health-check')
    ORDER BY id DESC
    LIMIT 10;
  " 2>/dev/null || echo "[WARN] Could not query SQLite DB."
  echo ""
  echo "Last 10 mail_queue entries for health checks:"
  sqlite3 "$DB_PATH" "
    SELECT
      id,
      substr(created_at, 1, 19) as created,
      status,
      attempts,
      category,
      to_email,
      substr(error_code, 1, 40) as error
    FROM mail_queue
    WHERE category IN ('health-check', 'postfix-health-check')
    ORDER BY id DESC
    LIMIT 10;
  " 2>/dev/null || echo "[WARN] Could not query mail_queue."
else
  echo "[WARN] SQLite DB not found or sqlite3 not installed."
fi

# ── 10. Postfix process status ───────────────────────────────
section "Postfix Process Status"
if command -v systemctl &>/dev/null; then
  systemctl status postfix 2>/dev/null | head -15 || echo "[WARN] postfix systemctl status failed."
else
  ps aux 2>/dev/null | grep postfix | grep -v grep | head -5 || echo "[INFO] Postfix processes not found in ps."
fi

# ── Summary ───────────────────────────────────────────────────
section "SUMMARY — What to Look For"
cat <<'EOF'
1. QUEUE: If mailq shows messages queued (not empty), Postfix is not forwarding them.
   → Check "relayhost" setting. If empty, Postfix tries direct delivery (often blocked by Gmail).
   → If using Gmail SMTP relay, ensure smtp_sasl_auth_enable=yes and credentials are set.

2. MAIL LOG: Look for:
   - "550" or "554" → Gmail hard reject (SPF/DKIM failure or policy rejection)
   - "421" or "450/451" → Temporary deferral (retry later)
   - "status=sent" → Postfix claims it was sent onward
   - "connect to gmail.com: Connection refused" → Network/relay issue

3. DKIM: If no milter config in main.cf, mail is unsigned → Gmail likely rejects or junks it.
   → Install opendkim and configure Postfix milter.

4. SPF: If sender domain has no SPF record, Gmail may reject.
   → Add TXT record: "v=spf1 include:_spf.google.com ~all" (if using Google relay)
   → Or: "v=spf1 ip4:<VPS-IP> ~all" (if sending directly)

5. GMAIL SPAM: Check spam folder. Gmail may accept but filter.

6. RELAY: If relayhost is empty, Gmail blocks direct MX delivery from unknown IPs.
   → Use Gmail SMTP relay (smtp.gmail.com:587) with app password, or SendGrid/Mailgun.
EOF

echo ""
echo "$SEP"
echo "  Diagnostic complete."
echo "$SEP"
