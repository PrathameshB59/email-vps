#!/usr/bin/env bash
set -euo pipefail

OLD_PATH="/opt/stackpilot-monitor/generate_metrics.sh"
NEW_PATH="/home/devuser/dev/email-vps/generate_metrics.sh"
NEW_ENTRY="* * * * * ${NEW_PATH} >/dev/null 2>&1"

MODE="${1:-audit}"
TMP_FILE="$(mktemp)"

CRONTAB_SCOPE="user"
case "${MODE}" in
  audit|apply-user)
    CRONTAB_SCOPE="user"
    ;;
  audit-root|apply-root)
    CRONTAB_SCOPE="root"
    ;;
  *)
    echo "[cron-fix] unsupported mode: ${MODE}" >&2
    echo "Usage: ${0} [audit|audit-root|apply-user|apply-root]" >&2
    exit 1
    ;;
esac

if [[ "${CRONTAB_SCOPE}" == "root" ]] && [[ "${EUID}" -ne 0 ]]; then
  echo "[cron-fix] mode '${MODE}' requires root. Re-run with sudo." >&2
  exit 1
fi

cleanup() {
  rm -f "${TMP_FILE}"
}
trap cleanup EXIT

echo "[cron-fix] mode=${MODE}"
echo "[cron-fix] scope=${CRONTAB_SCOPE}"
echo "[cron-fix] old path: ${OLD_PATH}"
echo "[cron-fix] new path: ${NEW_PATH}"
echo

if [[ "${CRONTAB_SCOPE}" == "root" ]]; then
  echo "[cron-fix] scanning root crontab..."
else
  echo "[cron-fix] scanning current user crontab..."
fi
if crontab -l >"${TMP_FILE}" 2>/dev/null; then
  if grep -Fq "${OLD_PATH}" "${TMP_FILE}"; then
    echo "  - found stale ${CRONTAB_SCOPE} crontab reference to ${OLD_PATH}"
  else
    echo "  - no stale ${CRONTAB_SCOPE} crontab reference found"
  fi
else
  : >"${TMP_FILE}"
  echo "  - ${CRONTAB_SCOPE} crontab is empty"
fi

if [[ "${MODE}" == "audit" ]] || [[ "${MODE}" == "audit-root" ]]; then
  echo
  echo "[cron-fix] audit complete (no changes applied)."
  if [[ "${CRONTAB_SCOPE}" == "root" ]]; then
    echo "[cron-fix] to apply root-crontab fix: ${0} apply-root"
  else
    echo "[cron-fix] to apply user-crontab fix: ${0} apply-user"
  fi
  exit 0
fi

grep -Fv "${OLD_PATH}" "${TMP_FILE}" >"${TMP_FILE}.next" || true
mv "${TMP_FILE}.next" "${TMP_FILE}"

if ! grep -q '^MAILTO=""$' "${TMP_FILE}"; then
  {
    echo 'MAILTO=""'
    cat "${TMP_FILE}"
  } >"${TMP_FILE}.next"
  mv "${TMP_FILE}.next" "${TMP_FILE}"
fi

if ! grep -Fq "${NEW_PATH}" "${TMP_FILE}"; then
  echo "${NEW_ENTRY}" >>"${TMP_FILE}"
  echo "[cron-fix] appended new metrics cron entry."
else
  echo "[cron-fix] new metrics cron entry already present."
fi

crontab "${TMP_FILE}"

echo
echo "[cron-fix] ${CRONTAB_SCOPE} crontab updated."
echo "[cron-fix] active ${CRONTAB_SCOPE} crontab:"
crontab -l
echo
echo "[cron-fix] note: audit root and /etc/cron* manually with sudo:"
echo "  sudo crontab -l | grep -n '${OLD_PATH}' || true"
echo "  sudo grep -R -n '${OLD_PATH}' /etc/cron* || true"
