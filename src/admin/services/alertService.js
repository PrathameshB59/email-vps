const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function parsePercent(value) {
  const matched = String(value || "").match(/(\d+(?:\.\d+)?)%/);
  if (!matched) {
    return null;
  }
  return Number(matched[1]);
}

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

function createAlertService({ repository, env, verifyRelay }) {
  const metricsPath = path.resolve(env.ADMIN_METRICS_PATH);

  function readMetrics() {
    if (!fs.existsSync(metricsPath)) {
      return {
        ok: false,
        reason: "metrics_not_found",
      };
    }

    try {
      const raw = fs.readFileSync(metricsPath, "utf8");
      const parsed = JSON.parse(raw);
      const mtime = fs.statSync(metricsPath).mtime;

      return {
        ok: true,
        data: parsed,
        mtime,
      };
    } catch (error) {
      return {
        ok: false,
        reason: "metrics_parse_failed",
      };
    }
  }

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

  async function computeAndPersistAlerts() {
    const quotaDate = new Date().toISOString().slice(0, 10);
    const quota = await repository.getQuota(quotaDate);
    const queue = await repository.getQueueStats();
    const relay = await getRelayHealth();
    const metrics = readMetrics();

    const quotaPercent = env.MAIL_DAILY_LIMIT > 0
      ? (quota.used / env.MAIL_DAILY_LIMIT) * 100
      : 0;

    const diskPercent = metrics.ok ? parsePercent(metrics.data.disk) : null;
    const sshFails = metrics.ok ? Number(metrics.data.ssh_fails || 0) : null;
    const metricsAgeMinutes = metrics.ok ? (Date.now() - metrics.mtime.getTime()) / (60 * 1000) : null;

    const fail2banStatus = safeCommand("fail2ban-client", ["status"]);
    const aideDbExists = fs.existsSync("/var/lib/aide/aide.db") || fs.existsSync("/var/lib/aide/aide.db.gz");
    const reportFile = fs.existsSync("/tmp/vps_report.html")
      ? "/tmp/vps_report.html"
      : (fs.existsSync("/tmp/vps_report.txt") ? "/tmp/vps_report.txt" : null);

    const alerts = [
      {
        alertType: "quota_usage",
        ...statusByThreshold(quotaPercent, 80, 95),
        value: `${quota.used}/${env.MAIL_DAILY_LIMIT}`,
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
        status: relay.ok ? "resolved" : "active",
        severity: relay.ok ? "info" : "critical",
        value: relay.ok ? "ok" : (relay.errorCode || "failed"),
        message: relay.ok
          ? "SMTP relay verification succeeded."
          : `SMTP relay verification failed: ${relay.errorMessage || "unknown"}`,
      },
      {
        alertType: "disk_usage",
        ...statusByThreshold(diskPercent, 80, 90),
        value: diskPercent == null ? "unknown" : `${diskPercent}%`,
        message: diskPercent == null
          ? "Disk metric unavailable."
          : `Disk usage is ${diskPercent}%.`,
      },
      {
        alertType: "ssh_failures",
        ...statusByThreshold(sshFails, 300, 1000),
        value: sshFails == null ? "unknown" : String(sshFails),
        message: sshFails == null
          ? "SSH failure metric unavailable."
          : `SSH failed logins in 24h: ${sshFails}.`,
      },
      {
        alertType: "metrics_freshness",
        status: metricsAgeMinutes == null || metricsAgeMinutes > 10 ? "active" : "resolved",
        severity: metricsAgeMinutes == null || metricsAgeMinutes > 10 ? "warning" : "info",
        value: metricsAgeMinutes == null ? "unknown" : `${metricsAgeMinutes.toFixed(1)}m`,
        message: metricsAgeMinutes == null
          ? "Metrics file unavailable or invalid."
          : `Metrics last updated ${metricsAgeMinutes.toFixed(1)} minutes ago.`,
      },
      {
        alertType: "fail2ban_summary",
        status: fail2banStatus ? "resolved" : "active",
        severity: fail2banStatus ? "info" : "warning",
        value: fail2banStatus ? "available" : "unavailable",
        message: fail2banStatus || "fail2ban-client status unavailable.",
      },
      {
        alertType: "aide_integrity",
        status: aideDbExists ? "resolved" : "active",
        severity: aideDbExists ? "info" : "warning",
        value: aideDbExists ? "baseline_present" : "baseline_missing",
        message: aideDbExists
          ? "AIDE baseline DB is present."
          : "AIDE baseline DB not found on host.",
      },
      {
        alertType: "daily_report_status",
        status: reportFile ? "resolved" : "active",
        severity: reportFile ? "info" : "warning",
        value: reportFile || "missing",
        message: reportFile
          ? `Latest report file found at ${reportFile}.`
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
    computeAndPersistAlerts,
  };
}

module.exports = {
  createAlertService,
};
