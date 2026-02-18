#!/bin/bash
set -uo pipefail

# Portable output path (repo-root based).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT="${SCRIPT_DIR}/metrics.json"

DATE=$(date)
LOAD=$(uptime | awk -F'load average:' '{ print $2 }')
CPU=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}')
MEM_TOTAL=$(free -h | awk '/Mem:/ {print $2}')
MEM_USED=$(free -h | awk '/Mem:/ {print $3}')
DISK=$(df -h / | awk 'NR==2 {print $5}')

SSH_FAILS=$(journalctl -u ssh --since "24 hours ago" | grep "Failed password" | wc -l)
TOP_IP=$(journalctl -u ssh --since "24 hours ago" | grep "Failed password" | awk '{print $(NF-3)}' | sort | uniq -c | sort -nr | head -1 | awk '{print $2}')

DOCKER=$(docker ps --format "{{.Names}} ({{.Status}})" 2>/dev/null)
PM2=$(pm2 list 2>/dev/null | grep online | wc -l)

# Fail2ban status (requires sudoers entry for devuser)
FAIL2BAN_SUMMARY=$(sudo /usr/bin/fail2ban-client status 2>/dev/null | head -1)
FAIL2BAN_OK="false"
if [ -n "$FAIL2BAN_SUMMARY" ]; then
  FAIL2BAN_OK="true"
fi

# AIDE baseline check (requires sudoers entry for devuser)
AIDE_BASELINE="false"
if sudo /usr/bin/test -f /var/lib/aide/aide.db 2>/dev/null || sudo /usr/bin/test -f /var/lib/aide/aide.db.gz 2>/dev/null; then
  AIDE_BASELINE="true"
fi

# Risk detection
if [ "$SSH_FAILS" -gt 1000 ]; then
  RISK="HIGH"
elif [ "$SSH_FAILS" -gt 300 ]; then
  RISK="WARNING"
else
  RISK="SECURE"
fi

cat <<EOF > "$OUTPUT"
{
  "date": "$DATE",
  "load": "$LOAD",
  "cpu": "$CPU%",
  "memory_used": "$MEM_USED",
  "memory_total": "$MEM_TOTAL",
  "disk": "$DISK",
  "ssh_fails": "$SSH_FAILS",
  "top_ip": "$TOP_IP",
  "risk": "$RISK",
  "docker": "$DOCKER",
  "pm2_online": "$PM2",
  "fail2ban_ok": "$FAIL2BAN_OK",
  "fail2ban_summary": "$FAIL2BAN_SUMMARY",
  "aide_baseline_present": "$AIDE_BASELINE"
}
EOF

# Cron example:
# MAILTO=""
# * * * * * /home/devuser/dev/email-vps/generate_metrics.sh >/dev/null 2>&1
