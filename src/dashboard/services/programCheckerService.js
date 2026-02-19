const fs = require("fs");
const { execFileSync } = require("child_process");

const SYSTEMD_UNITS = [
  { key: "nginx", unit: "nginx" },
  { key: "postfix", unit: "postfix" },
  { key: "fail2ban", unit: "fail2ban" },
];

const LISTENER_CHECKS = [
  {
    key: "smtp_local",
    label: "SMTP Local Relay",
    expected: "127.0.0.1:25",
    exposure: "local",
    patterns: [/127\.0\.0\.1:25\b/, /\[::1\]:25\b/],
  },
  {
    key: "app_local",
    label: "Email-VPS App",
    expected: "127.0.0.1:8081",
    exposure: "local",
    patterns: [/127\.0\.0\.1:8081\b/],
  },
  {
    key: "http_public",
    label: "Public HTTP",
    expected: "*:80",
    exposure: "public",
    patterns: [/0\.0\.0\.0:80\b/, /\*:80\b/, /\[::\]:80\b/],
  },
  {
    key: "https_public",
    label: "Public HTTPS",
    expected: "*:443",
    exposure: "public",
    patterns: [/0\.0\.0\.0:443\b/, /\*:443\b/, /\[::\]:443\b/],
  },
];

function nowIso() {
  return new Date().toISOString();
}

function round(value, digits = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const power = 10 ** digits;
  return Math.round(numeric * power) / power;
}

function ageMinutesFromMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  return round((Date.now() - ms) / (60 * 1000), 1);
}

function healthRank(health) {
  if (health === "critical") return 4;
  if (health === "warning") return 3;
  if (health === "degraded") return 2;
  if (health === "unknown") return 1;
  return 0;
}

function stateFromSystemdResult(rawState) {
  const state = String(rawState || "").trim().toLowerCase();
  if (state === "active") return { health: "healthy", state: "active" };
  if (state === "activating") return { health: "warning", state: "activating" };
  if (state === "inactive") return { health: "critical", state: "inactive" };
  if (state === "failed") return { health: "critical", state: "failed" };
  if (!state) return { health: "unknown", state: "unknown" };
  return { health: "degraded", state };
}

function safeExec(command, args = [], timeoutMs = 1800) {
  try {
    const stdout = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    return {
      ok: true,
      stdout: String(stdout || "").trim(),
      stderr: "",
      code: null,
      message: null,
    };
  } catch (error) {
    const stderr =
      typeof error.stderr === "string"
        ? error.stderr
        : Buffer.isBuffer(error.stderr)
          ? error.stderr.toString("utf8")
          : "";

    return {
      ok: false,
      stdout:
        typeof error.stdout === "string"
          ? error.stdout.trim()
          : Buffer.isBuffer(error.stdout)
            ? error.stdout.toString("utf8").trim()
            : "",
      stderr: String(stderr || "").trim(),
      code: error.code || "EXEC_FAILED",
      message: error.message || "Command execution failed.",
    };
  }
}

function classifyExecFailure(result) {
  const combined = `${result.stderr || ""} ${result.message || ""}`.toLowerCase();
  if (
    combined.includes("permission denied") ||
    combined.includes("operation not permitted") ||
    combined.includes("failed to connect to bus")
  ) {
    return "unknown";
  }
  if (combined.includes("not found")) {
    return "unknown";
  }
  return "degraded";
}

function summarizeOverall(components) {
  const issues = [];

  for (const component of components) {
    if (!component || component.health === "healthy") {
      continue;
    }

    issues.push({
      component: component.component,
      health: component.health,
      message: component.message || "Component requires attention.",
    });
  }

  const highestRank = issues.reduce((max, issue) => Math.max(max, healthRank(issue.health)), 0);
  const health =
    highestRank >= healthRank("critical")
      ? "critical"
      : highestRank >= healthRank("warning")
        ? "warning"
        : highestRank >= healthRank("degraded")
          ? "degraded"
          : highestRank >= healthRank("unknown")
            ? "unknown"
            : "healthy";

  return {
    health,
    issueCount: issues.length,
    issues,
  };
}

function createProgramCheckerService({
  env,
  repository,
  opsInsightService = {
    async getProgramDiagnostics() {
      return null;
    },
  },
}) {
  async function getSystemdServices() {
    const checks = SYSTEMD_UNITS.map((item) => {
      const result = safeExec("systemctl", ["is-active", item.unit]);
      if (result.ok) {
        const mapped = stateFromSystemdResult(result.stdout);
        return {
          key: item.key,
          unit: item.unit,
          state: mapped.state,
          health: mapped.health,
          message: `systemctl is-active ${item.unit}: ${mapped.state}`,
        };
      }

      return {
        key: item.key,
        unit: item.unit,
        state: "unknown",
        health: classifyExecFailure(result),
        message: result.stderr || result.message || `Unable to inspect ${item.unit}.`,
      };
    });

    const health = summarizeOverall(
      checks.map((item) => ({
        component: `systemd:${item.unit}`,
        health: item.health,
        message: item.message,
      }))
    ).health;

    return {
      health,
      checks,
    };
  }

  async function getPm2Status() {
    const result = safeExec("pm2", ["jlist"], 2200);
    if (!result.ok) {
      return {
        health: classifyExecFailure(result),
        message: result.stderr || result.message || "Unable to read PM2 process list.",
        summary: {
          total: 0,
          online: 0,
          stopped: 0,
          errored: 0,
        },
        apps: [],
      };
    }

    let appsRaw = [];
    try {
      appsRaw = JSON.parse(result.stdout || "[]");
    } catch (error) {
      return {
        health: "degraded",
        message: "PM2 returned invalid JSON payload.",
        summary: {
          total: 0,
          online: 0,
          stopped: 0,
          errored: 0,
        },
        apps: [],
      };
    }

    const apps = Array.isArray(appsRaw)
      ? appsRaw.map((app) => {
          const status = String(app?.pm2_env?.status || "unknown").toLowerCase();
          const restartCount = Number(app?.pm2_env?.restart_time || 0);
          const uptimeMs = Number(app?.pm2_env?.pm_uptime || 0);
          return {
            name: String(app?.name || "unknown"),
            status,
            restarts: Number.isFinite(restartCount) ? restartCount : 0,
            startedAt: Number.isFinite(uptimeMs) && uptimeMs > 0 ? new Date(uptimeMs).toISOString() : null,
            health: status === "online" ? "healthy" : status === "stopped" ? "warning" : "degraded",
          };
        })
      : [];

    const summary = {
      total: apps.length,
      online: apps.filter((app) => app.status === "online").length,
      stopped: apps.filter((app) => app.status === "stopped").length,
      errored: apps.filter((app) => app.status === "errored").length,
    };

    const health =
      summary.total === 0
        ? "unknown"
        : summary.errored > 0
          ? "critical"
          : summary.stopped > 0
            ? "warning"
            : "healthy";

    return {
      health,
      message: `PM2 online ${summary.online}/${summary.total}.`,
      summary,
      apps,
    };
  }

  async function getDockerStatus() {
    const daemonResult = safeExec("docker", ["info", "--format", "{{.ServerVersion}}"]);
    const listResult = safeExec("docker", ["ps", "--format", "{{.Names}}::{{.Status}}"]);

    if (!daemonResult.ok && !listResult.ok) {
      const mergedError =
        daemonResult.stderr ||
        daemonResult.message ||
        listResult.stderr ||
        listResult.message ||
        "Unable to inspect Docker state.";
      return {
        health: classifyExecFailure(daemonResult),
        message: mergedError,
        daemonVersion: null,
        summary: {
          running: 0,
          total: 0,
        },
        containers: [],
      };
    }

    const containers = String(listResult.stdout || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, status] = line.split("::");
        return {
          name: String(name || "unknown"),
          status: String(status || "unknown"),
          health: String(status || "").toLowerCase().includes("up") ? "healthy" : "warning",
        };
      });

    return {
      health: "healthy",
      message: `Docker running containers: ${containers.length}.`,
      daemonVersion: daemonResult.ok ? daemonResult.stdout || null : null,
      summary: {
        running: containers.length,
        total: containers.length,
      },
      containers,
    };
  }

  async function getListenerStatus() {
    const result = safeExec("ss", ["-tulpn"], 1600);
    if (!result.ok) {
      return {
        health: classifyExecFailure(result),
        message: result.stderr || result.message || "Unable to inspect listener sockets.",
        checks: LISTENER_CHECKS.map((check) => ({
          key: check.key,
          label: check.label,
          expected: check.expected,
          exposure: check.exposure,
          found: false,
          health: "unknown",
        })),
      };
    }

    const raw = result.stdout || "";
    const checks = LISTENER_CHECKS.map((check) => {
      const found = check.patterns.some((pattern) => pattern.test(raw));
      return {
        key: check.key,
        label: check.label,
        expected: check.expected,
        exposure: check.exposure,
        found,
        health: found ? "healthy" : "warning",
      };
    });

    const health = checks.some((item) => item.health !== "healthy") ? "warning" : "healthy";
    return {
      health,
      message: "Socket listeners inspected via ss -tulpn.",
      checks,
    };
  }

  async function getMetricsAndWorkerStatus() {
    const metricsPath = env.DASHBOARD_METRICS_PATH;
    const exists = fs.existsSync(metricsPath);
    const stat = exists ? fs.statSync(metricsPath) : null;
    const freshnessMinutes = stat ? ageMinutesFromMs(stat.mtimeMs) : null;

    const metricsHealth =
      freshnessMinutes == null
        ? "warning"
        : freshnessMinutes > 30
          ? "critical"
          : freshnessMinutes > 10
            ? "warning"
            : "healthy";

    let latestSnapshot = null;
    try {
      latestSnapshot = await repository.getLatestDashboardMetricSnapshot();
    } catch (error) {
      latestSnapshot = null;
    }

    const snapshotAgeMinutes = latestSnapshot?.captured_at
      ? ageMinutesFromMs(new Date(latestSnapshot.captured_at).getTime())
      : null;

    const snapshotHealth =
      snapshotAgeMinutes == null
        ? "warning"
        : snapshotAgeMinutes > 30
          ? "critical"
          : snapshotAgeMinutes > 10
            ? "warning"
            : "healthy";

    return {
      metrics: {
        path: metricsPath,
        exists,
        freshnessMinutes,
        health: metricsHealth,
        message: exists
          ? `metrics.json freshness: ${freshnessMinutes} min`
          : "metrics.json file is missing.",
      },
      snapshotWorker: {
        latestCapturedAt: latestSnapshot?.captured_at || null,
        ageMinutes: snapshotAgeMinutes,
        health: snapshotHealth,
        message: latestSnapshot?.captured_at
          ? `Latest dashboard snapshot age: ${snapshotAgeMinutes} min`
          : "No dashboard metric snapshot found.",
      },
    };
  }

  async function getProgramsSnapshot() {
    const [systemd, pm2, docker, listeners, freshness, opsDiagnostics] = await Promise.all([
      getSystemdServices(),
      getPm2Status(),
      getDockerStatus(),
      getListenerStatus(),
      getMetricsAndWorkerStatus(),
      opsInsightService.getProgramDiagnostics().catch(() => null),
    ]);

    const cronSchedulerStatus = opsDiagnostics?.cronSchedulerStatus || null;
    const cronMetricsJobStatus = opsDiagnostics?.cronMetricsJobStatus || null;
    const postfixConfigWarnings = Array.isArray(opsDiagnostics?.postfixConfigWarnings)
      ? opsDiagnostics.postfixConfigWarnings
      : [];

    const cronHealth = cronSchedulerStatus?.health || "unknown";
    const cronMetricsHealth = cronMetricsJobStatus?.health || "unknown";
    const postfixWarningsHealth = postfixConfigWarnings.length > 0 ? "warning" : "healthy";

    const overall = summarizeOverall([
      { component: "systemd", health: systemd.health, message: "System service checks require attention." },
      { component: "pm2", health: pm2.health, message: pm2.message },
      { component: "docker", health: docker.health, message: docker.message },
      { component: "listeners", health: listeners.health, message: listeners.message },
      { component: "metrics", health: freshness.metrics.health, message: freshness.metrics.message },
      {
        component: "snapshot-worker",
        health: freshness.snapshotWorker.health,
        message: freshness.snapshotWorker.message,
      },
      {
        component: "cron-scheduler",
        health: cronHealth,
        message: cronSchedulerStatus?.message || "Cron scheduler diagnostics unavailable.",
      },
      {
        component: "cron-metrics-job",
        health: cronMetricsHealth,
        message: cronMetricsJobStatus?.message || "Cron metrics job diagnostics unavailable.",
      },
      {
        component: "postfix-config",
        health: postfixWarningsHealth,
        message:
          postfixConfigWarnings.length > 0
            ? `Postfix config warning count: ${postfixConfigWarnings.length}.`
            : "No postfix config warnings.",
      },
    ]);

    return {
      timestamp: nowIso(),
      systemd,
      pm2,
      docker,
      listeners,
      metrics: freshness.metrics,
      snapshotWorker: freshness.snapshotWorker,
      cronSchedulerStatus,
      cronMetricsJobStatus,
      postfixConfigWarnings,
      overall,
    };
  }

  return {
    getProgramsSnapshot,
  };
}

module.exports = {
  createProgramCheckerService,
};
