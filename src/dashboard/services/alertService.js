const fs = require("fs");
const { execFileSync } = require("child_process");
const { normalizeInteger, parsePercent, readMetricsFile } = require("./metrics");

function safeCommand(command, args = []) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 1500,
    }).trim();
  } catch (error) {
    return null;
  }
}

function statusByThreshold(value, warnAt, criticalAt) {
  if (value == null) {
    return { status: "active", severity: "warning" };
  }

  if (value >= criticalAt) {
    return { status: "active", severity: "critical" };
  }

  if (value >= warnAt) {
    return { status: "active", severity: "warning" };
  }

  return { status: "resolved", severity: "info" };
}

function createDashboardAlertService({ repository, env, verifyRelay }) {
  async function getRelayHealth() {
    const relay = await verifyRelay();
    return {
      ok: Boolean(relay.ok),
      host: env.MAIL_RELAY_HOST,
      port: env.MAIL_RELAY_PORT,
      secure: env.MAIL_RELAY_SECURE,
      errorCode: relay.code || null,
      errorMessage: relay.message || null,
    };
  }

  async function getSecuritySignals() {
    const metrics = readMetricsFile(env.DASHBOARD_METRICS_PATH);
    const relay = await getRelayHealth();

    const diskPct = metrics.ok ? parsePercent(metrics.data.disk) : null;
    const sshFails = metrics.ok ? normalizeInteger(metrics.data.ssh_fails) : null;
    const pm2Online = metrics.ok ? normalizeInteger(metrics.data.pm2_online) : null;
    const risk = metrics.ok ? String(metrics.data.risk || "UNKNOWN") : "UNKNOWN";

    const fail2banSummary =
      metrics.ok && metrics.data.fail2ban_ok === "true"
        ? metrics.data.fail2ban_summary || "available"
        : safeCommand("fail2ban-client", ["status"]);
    const aideBaselinePresent =
      metrics.ok && metrics.data.aide_baseline_present !== undefined
        ? metrics.data.aide_baseline_present === "true"
        : fs.existsSync("/var/lib/aide/aide.db") || fs.existsSync("/var/lib/aide/aide.db.gz");
    const reportPath = fs.existsSync("/tmp/vps_report.html")
      ? "/tmp/vps_report.html"
      : fs.existsSync("/tmp/vps_report.txt")
        ? "/tmp/vps_report.txt"
        : null;

    const metricsAgeMinutes = metrics.modifiedAt
      ? (Date.now() - new Date(metrics.modifiedAt).getTime()) / (60 * 1000)
      : null;

    return {
      metrics,
      relay,
      diskPct,
      sshFails,
      pm2Online,
      risk,
      fail2banSummary,
      aideBaselinePresent,
      reportPath,
      metricsAgeMinutes,
    };
  }

  async function computeAndPersistAlerts({ queue, quota }) {
    const security = await getSecuritySignals();
    const quotaPercent =
      quota.limit > 0 ? Number(((quota.used / quota.limit) * 100).toFixed(1)) : 0;

    const alerts = [
      {
        alertType: "quota_usage",
        ...statusByThreshold(quotaPercent, 80, 95),
        value: `${quota.used}/${quota.limit}`,
        message: `Daily quota usage at ${quotaPercent.toFixed(1)}%.`,
      },
      {
        alertType: "retry_queue",
        status: queue.retrying > 0 ? "active" : "resolved",
        severity: queue.retrying > 0 ? "warning" : "info",
        value: String(queue.retrying),
        message: `Retry queue size is ${queue.retrying}.`,
      },
      {
        alertType: "failed_queue",
        status: queue.failed > 0 ? "active" : "resolved",
        severity: queue.failed > 0 ? "warning" : "info",
        value: String(queue.failed),
        message: `Failed queue size is ${queue.failed}.`,
      },
      {
        alertType: "relay_health",
        status: security.relay.ok ? "resolved" : "active",
        severity: security.relay.ok ? "info" : "critical",
        value: security.relay.ok ? "ok" : security.relay.errorCode || "failed",
        message: security.relay.ok
          ? "SMTP relay verification succeeded."
          : `SMTP relay verification failed: ${security.relay.errorMessage || "unknown"}`,
      },
      {
        alertType: "disk_usage",
        ...statusByThreshold(security.diskPct, 80, 90),
        value: security.diskPct == null ? "unknown" : `${security.diskPct}%`,
        message:
          security.diskPct == null
            ? "Disk metric unavailable."
            : `Disk usage is ${security.diskPct}%.`,
      },
      {
        alertType: "ssh_failures",
        ...statusByThreshold(security.sshFails, 300, 1000),
        value: security.sshFails == null ? "unknown" : String(security.sshFails),
        message:
          security.sshFails == null
            ? "SSH failure metric unavailable."
            : `SSH failed logins in 24h: ${security.sshFails}.`,
      },
      {
        alertType: "metrics_freshness",
        status:
          security.metricsAgeMinutes == null || security.metricsAgeMinutes > 10
            ? "active"
            : "resolved",
        severity:
          security.metricsAgeMinutes == null || security.metricsAgeMinutes > 10
            ? "warning"
            : "info",
        value:
          security.metricsAgeMinutes == null
            ? "unknown"
            : `${security.metricsAgeMinutes.toFixed(1)}m`,
        message:
          security.metricsAgeMinutes == null
            ? "Metrics file unavailable or invalid."
            : `Metrics last updated ${security.metricsAgeMinutes.toFixed(1)} minutes ago.`,
      },
      {
        alertType: "fail2ban_summary",
        status: security.fail2banSummary ? "resolved" : "active",
        severity: security.fail2banSummary ? "info" : "warning",
        value: security.fail2banSummary ? "available" : "unavailable",
        message: security.fail2banSummary || "fail2ban-client status unavailable.",
      },
      {
        alertType: "aide_integrity",
        status: security.aideBaselinePresent ? "resolved" : "active",
        severity: security.aideBaselinePresent ? "info" : "warning",
        value: security.aideBaselinePresent ? "baseline_present" : "baseline_missing",
        message: security.aideBaselinePresent
          ? "AIDE baseline DB is present."
          : "AIDE baseline DB not found on host.",
      },
      {
        alertType: "daily_report_status",
        status: security.reportPath ? "resolved" : "active",
        severity: security.reportPath ? "info" : "warning",
        value: security.reportPath || "missing",
        message: security.reportPath
          ? `Latest report file found at ${security.reportPath}.`
          : "No daily report artifact found in /tmp.",
      },
    ];

    for (const alert of alerts) {
      await repository.upsertSystemAlertState(alert);
    }

    return repository.listSystemAlertState(100);
  }

  return {
    getRelayHealth,
    getSecuritySignals,
    computeAndPersistAlerts,
  };
}

module.exports = {
  createDashboardAlertService,
};
