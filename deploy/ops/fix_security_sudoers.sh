#!/usr/bin/env bash
set -euo pipefail

SUDOERS_FILE="/etc/sudoers.d/devuser-security-checks"
FAIL2BAN_BIN="/usr/bin/fail2ban-client"
TARGET_USER="devuser"

MODE="${1:-audit}"

echo "[sudoers-fix] mode=${MODE}"
echo "[sudoers-fix] target file: ${SUDOERS_FILE}"
echo

if [[ "${EUID}" -ne 0 ]]; then
  echo "[sudoers-fix] this script requires root. Re-run with sudo." >&2
  exit 1
fi

# --- Audit current state ---

echo "[sudoers-fix] checking current state..."

if [[ -f "${SUDOERS_FILE}" ]]; then
  echo "  - sudoers file already exists:"
  cat "${SUDOERS_FILE}" | sed 's/^/    /'
else
  echo "  - sudoers file does not exist yet"
fi

if [[ -x "${FAIL2BAN_BIN}" ]]; then
  echo "  - fail2ban-client found at ${FAIL2BAN_BIN}"
else
  echo "  - WARNING: fail2ban-client not found at ${FAIL2BAN_BIN}"
fi

if [[ -d "/var/lib/aide" ]]; then
  echo "  - /var/lib/aide directory exists"
  ls -la /var/lib/aide/ 2>/dev/null | head -5 | sed 's/^/    /'
else
  echo "  - WARNING: /var/lib/aide directory not found"
fi

if [[ "${MODE}" == "audit" ]]; then
  echo
  echo "[sudoers-fix] audit complete (no changes applied)."
  echo "[sudoers-fix] to apply: sudo ${0} apply"
  exit 0
fi

if [[ "${MODE}" != "apply" ]]; then
  echo "[sudoers-fix] unsupported mode: ${MODE}" >&2
  echo "Usage: sudo ${0} [audit|apply]" >&2
  exit 1
fi

# --- Apply ---

echo
echo "[sudoers-fix] writing ${SUDOERS_FILE}..."

cat > "${SUDOERS_FILE}" <<'SUDOERS'
# Allow devuser to check fail2ban and AIDE status for dashboard metrics.
# Scoped to specific read-only commands only.
devuser ALL=(root) NOPASSWD: /usr/bin/fail2ban-client status
devuser ALL=(root) NOPASSWD: /usr/bin/test -f /var/lib/aide/aide.db
devuser ALL=(root) NOPASSWD: /usr/bin/test -f /var/lib/aide/aide.db.gz
SUDOERS

chmod 440 "${SUDOERS_FILE}"

echo "[sudoers-fix] validating syntax..."
if visudo -cf "${SUDOERS_FILE}"; then
  echo "[sudoers-fix] syntax OK"
else
  echo "[sudoers-fix] SYNTAX ERROR - removing broken file" >&2
  rm -f "${SUDOERS_FILE}"
  exit 1
fi

echo
echo "[sudoers-fix] verifying fail2ban access for ${TARGET_USER}..."
if su - "${TARGET_USER}" -c "sudo ${FAIL2BAN_BIN} status" >/dev/null 2>&1; then
  echo "  - fail2ban-client status: OK"
else
  echo "  - fail2ban-client status: FAILED (fail2ban may not be running)"
fi

echo "[sudoers-fix] verifying AIDE DB access for ${TARGET_USER}..."
if su - "${TARGET_USER}" -c "sudo /usr/bin/test -f /var/lib/aide/aide.db" 2>/dev/null; then
  echo "  - AIDE baseline (aide.db): FOUND"
elif su - "${TARGET_USER}" -c "sudo /usr/bin/test -f /var/lib/aide/aide.db.gz" 2>/dev/null; then
  echo "  - AIDE baseline (aide.db.gz): FOUND"
else
  echo "  - AIDE baseline: NOT FOUND (check AIDE initialization)"
fi

echo
echo "[sudoers-fix] done. Contents of ${SUDOERS_FILE}:"
cat "${SUDOERS_FILE}" | sed 's/^/  /'
