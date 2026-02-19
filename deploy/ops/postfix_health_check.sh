#!/usr/bin/env bash
set -euo pipefail

# Postfix health check — sends a test email via email-vps CLI.
# Usage: postfix_health_check.sh --frequency daily|weekly|monthly|yearly

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
LOG_DIR="${PROJECT_DIR}/logs"
LOG_FILE="${LOG_DIR}/postfix_health.log"
RECIPIENT="prathameshbirajdar.pc2@gmail.com"

FREQUENCY="manual"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --frequency)
      FREQUENCY="${2:-manual}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

mkdir -p "${LOG_DIR}"

TIMESTAMP=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
HOSTNAME=$(hostname -f 2>/dev/null || hostname)
FREQUENCY_UPPER=$(echo "${FREQUENCY}" | tr '[:lower:]' '[:upper:]')

log() {
  echo "[${TIMESTAMP}] [${FREQUENCY}] $1" >> "${LOG_FILE}"
  echo "$1"
}

log "Starting Postfix health check (frequency=${FREQUENCY})..."

cd "${PROJECT_DIR}"

REQUEST_ID="health-${FREQUENCY}-$(date +%s)"
if node src/cli/mail-send.js \
  --to "${RECIPIENT}" \
  --template health-check \
  --category "postfix-health-check" \
  --vars "triggerType=Scheduled,frequency=${FREQUENCY},frequencyUpper=${FREQUENCY_UPPER},hostname=${HOSTNAME},triggeredBy=cron,title=Postfix Health Check (${FREQUENCY}),summary=${FREQUENCY_UPPER} scheduled delivery probe from ${HOSTNAME}.,requestId=${REQUEST_ID},service=email-vps,environment=production,dashboardUrl=https://mail.stackpilot.in/dashboard/mail,timestamp=${TIMESTAMP}" \
  >> "${LOG_FILE}" 2>&1; then
  log "OK — ${FREQUENCY} health check email sent to ${RECIPIENT}"
else
  log "FAIL — ${FREQUENCY} health check email failed (exit code $?)"
  exit 1
fi
