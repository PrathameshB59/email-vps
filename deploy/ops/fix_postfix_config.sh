#!/usr/bin/env bash
# fix_postfix_config.sh — Fix duplicate main.cf entries and add devuser to adm group
# Run as: sudo bash deploy/ops/fix_postfix_config.sh
set -euo pipefail

MAIN_CF="/etc/postfix/main.cf"
DEVUSER="${SUDO_USER:-devuser}"

echo "=== Postfix Config Fix ==="

# ── 1. Clean duplicate relayhost entry ───────────────────────
echo ""
echo "[1] Removing duplicate 'relayhost =' (empty) entry..."
if grep -qE "^relayhost = $" "$MAIN_CF" 2>/dev/null; then
  # Remove the empty relayhost line (keep [smtp.gmail.com]:587)
  sed -i '/^relayhost = $/d' "$MAIN_CF"
  echo "    Removed empty relayhost entry."
else
  echo "    No empty relayhost entry found (already clean)."
fi

# ── 2. Clean duplicate smtp_tls_security_level=may ───────────
echo ""
echo "[2] Removing 'smtp_tls_security_level=may' (overridden by '= encrypt' for Gmail)..."
# Match exact form with no spaces (the default entry), distinct from '= encrypt' form
if grep -qE "^smtp_tls_security_level=may$" "$MAIN_CF" 2>/dev/null; then
  sed -i '/^smtp_tls_security_level=may$/d' "$MAIN_CF"
  echo "    Removed smtp_tls_security_level=may entry."
else
  echo "    No smtp_tls_security_level=may entry found (already clean)."
fi

# ── 3. Verify final config state ─────────────────────────────
echo ""
echo "[3] Verifying main.cf relay config:"
grep -E "^relayhost|^smtp_sasl|^smtp_tls" "$MAIN_CF" 2>/dev/null || echo "    No relay entries found."

# ── 4. Test config syntax ─────────────────────────────────────
echo ""
echo "[4] Testing Postfix config syntax..."
if postfix check 2>/dev/null; then
  echo "    Config syntax OK."
else
  echo "    WARNING: postfix check reported issues. Review main.cf manually."
fi

# ── 5. Reload Postfix ─────────────────────────────────────────
echo ""
echo "[5] Reloading Postfix..."
postfix reload
echo "    Postfix reloaded."

# ── 6. Add devuser to adm group for log access ───────────────
echo ""
echo "[6] Adding ${DEVUSER} to adm group (for mail.log access)..."
if id -nG "$DEVUSER" 2>/dev/null | grep -q "\badm\b"; then
  echo "    ${DEVUSER} is already in adm group."
else
  usermod -aG adm "$DEVUSER"
  echo "    Added ${DEVUSER} to adm group."
  echo "    NOTE: Log out and back in (or run 'newgrp adm') for the change to take effect."
fi

# ── 7. Quick mail log check ───────────────────────────────────
echo ""
echo "[7] Last 20 Postfix log entries:"
tail -20 /var/log/mail.log 2>/dev/null || echo "    Cannot read mail.log."

echo ""
echo "=== Done ==="
echo ""
echo "Next steps:"
echo "  1. Verify Gmail app password is still valid:"
echo "     sudo cat /etc/postfix/sasl_passwd"
echo "  2. Check Gmail spam / All Mail for subject '[Email-VPS] Health Check'"
echo "  3. After re-login, run: tail -50 /var/log/mail.log | grep smtp.gmail.com"
echo "  4. pm2 restart email-vps  (already done if you ran this after deploying)"
