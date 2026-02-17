#!/bin/bash

OUTPUT="/opt/stackpilot-monitor/metrics.json"

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

# Risk detection
if [ "$SSH_FAILS" -gt 1000 ]; then
  RISK="HIGH"
elif [ "$SSH_FAILS" -gt 300 ]; then
  RISK="WARNING"
else
  RISK="SECURE"
fi

cat <<EOF > $OUTPUT
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
  "pm2_online": "$PM2"
}
EOF

