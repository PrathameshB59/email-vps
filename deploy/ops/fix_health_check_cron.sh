#!/usr/bin/env bash
set -euo pipefail

HEALTH_SCRIPT="/home/devuser/dev/email-vps/deploy/ops/postfix_health_check.sh"

MODE="${1:-audit}"
TMP_FILE="$(mktemp)"

cleanup() {
  rm -f "${TMP_FILE}"
}
trap cleanup EXIT

echo "[health-cron] mode=${MODE}"
echo "[health-cron] script: ${HEALTH_SCRIPT}"
echo

if [[ "${MODE}" != "audit" ]] && [[ "${MODE}" != "apply" ]]; then
  echo "[health-cron] unsupported mode: ${MODE}" >&2
  echo "Usage: ${0} [audit|apply]" >&2
  exit 1
fi

# --- Read current crontab ---

if crontab -l >"${TMP_FILE}" 2>/dev/null; then
  echo "[health-cron] current crontab loaded"
else
  : >"${TMP_FILE}"
  echo "[health-cron] crontab is empty"
fi

# --- Check existing entries ---

EXISTING=0
if grep -Fq "postfix_health_check.sh" "${TMP_FILE}"; then
  EXISTING=$(grep -c "postfix_health_check.sh" "${TMP_FILE}")
  echo "[health-cron] found ${EXISTING} existing health check entries:"
  grep "postfix_health_check.sh" "${TMP_FILE}" | sed 's/^/  /'
else
  echo "[health-cron] no existing health check entries found"
fi

echo
echo "[health-cron] planned cron entries:"
echo "  0 8 * * *   daily   (every day at 08:00 UTC)"
echo "  0 9 * * 1   weekly  (every Monday at 09:00 UTC)"
echo "  0 10 1 * *  monthly (1st of month at 10:00 UTC)"
echo "  0 11 1 1 *  yearly  (Jan 1st at 11:00 UTC)"

if [[ "${MODE}" == "audit" ]]; then
  echo
  echo "[health-cron] audit complete (no changes applied)."
  echo "[health-cron] to apply: ${0} apply"
  exit 0
fi

# --- Apply ---

# Remove any existing health check entries
grep -Fv "postfix_health_check.sh" "${TMP_FILE}" >"${TMP_FILE}.next" || true
mv "${TMP_FILE}.next" "${TMP_FILE}"

# Ensure MAILTO="" is present
if ! grep -q '^MAILTO=""$' "${TMP_FILE}"; then
  {
    echo 'MAILTO=""'
    cat "${TMP_FILE}"
  } >"${TMP_FILE}.next"
  mv "${TMP_FILE}.next" "${TMP_FILE}"
fi

# Append health check entries
cat >> "${TMP_FILE}" <<CRON

# Postfix health check probes (email-vps)
0 8 * * * ${HEALTH_SCRIPT} --frequency daily >/dev/null 2>&1
0 9 * * 1 ${HEALTH_SCRIPT} --frequency weekly >/dev/null 2>&1
0 10 1 * * ${HEALTH_SCRIPT} --frequency monthly >/dev/null 2>&1
0 11 1 1 * ${HEALTH_SCRIPT} --frequency yearly >/dev/null 2>&1
CRON

crontab "${TMP_FILE}"

echo
echo "[health-cron] crontab updated. Current entries:"
crontab -l | grep "postfix_health_check" | sed 's/^/  /'
echo
echo "[health-cron] done."
