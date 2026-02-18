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

TIMESTAMP=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
HOSTNAME=$(hostname -f 2>/dev/null || hostname)

log() {
  echo "[${TIMESTAMP}] [${FREQUENCY}] $1" >> "${LOG_FILE}"
  echo "$1"
}

log "Starting Postfix health check (frequency=${FREQUENCY})..."

cd "${PROJECT_DIR}"

if node src/cli/mail-send.js \
  --to "${RECIPIENT}" \
  --template system-alert \
  --category "postfix-health-check" \
  --vars "title=Postfix Health Check (${FREQUENCY}),summary=${FREQUENCY^} scheduled delivery probe from ${HOSTNAME}.,impact=None — this is an automated health verification.,probableCause=Cron-triggered Postfix health check.,recommendedAction=No action needed if this email was received.,nextUpdateEta=Next ${FREQUENCY} check,details=Frequency: ${FREQUENCY} | Host: ${HOSTNAME} | Time: ${TIMESTAMP},severity=info,incidentId=health-${FREQUENCY}-$(date +%s),requestId=health-${FREQUENCY}-$(date +%s),service=email-vps,environment=production,dashboardUrl=https://mail.stackpilot.in/dashboard/mail,timestamp=${TIMESTAMP}" \
  >> "${LOG_FILE}" 2>&1; then
  log "OK — ${FREQUENCY} health check email sent to ${RECIPIENT}"
else
  log "FAIL — ${FREQUENCY} health check email failed (exit code $?)"
  exit 1
fi
