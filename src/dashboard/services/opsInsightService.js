const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const POSTFIX_MAIN_CF_DEFAULT = "/etc/postfix/main.cf";
const METRICS_SCRIPT_PATH = "/home/devuser/dev/email-vps/generate_metrics.sh";
const STALE_METRICS_SCRIPT_PATH = "/opt/stackpilot-monitor/generate_metrics.sh";
const KNOWN_OP_SOURCES = ["postfix", "relay", "cron", "logwatch", "fail2ban", "aide"];
const POSTFIX_DUPLICATE_KEY_SEVERITY = new Set(["relayhost", "smtp_tls_security_level"]);
const OPERATIONS_CONTROLS = {
  aide: {
    key: "aide",
    label: "AIDE Integrity",
    sources: ["aide"],
    fixHints: [
      "sudo aide --check",
      "sudo ls -l /var/lib/aide/",
      "sudo aideinit --yes --config /etc/aide/aide.conf",
    ],
  },
  fail2ban: {
    key: "fail2ban",
    label: "Fail2Ban Defense",
    sources: ["fail2ban"],
    fixHints: [
      "sudo systemctl status fail2ban --no-pager",
      "sudo fail2ban-client status",
      "sudo tail -n 200 /var/log/fail2ban.log",
    ],
  },
  relay: {
    key: "relay",
    label: "SMTP Relay",
    sources: ["relay"],
    fixHints: [
      "sudo postqueue -p",
      "sudo systemctl status postfix --no-pager",
      "sudo tail -n 200 /var/log/mail.log | grep -E 'status=|deferred|bounced|reject'",
    ],
  },
  postfix: {
    key: "postfix",
    label: "Postfix Runtime",
    sources: ["postfix"],
    fixHints: [
      "sudo bash /home/devuser/dev/email-vps/deploy/ops/fix_postfix_config.sh audit",
      "sudo bash /home/devuser/dev/email-vps/deploy/ops/fix_postfix_config.sh apply",
      "sudo postconf -n | grep -E 'relayhost|smtp_tls_security_level'",
    ],
  },
  crontab: {
    key: "crontab",
    label: "Cron and Logwatch",
    sources: ["cron", "logwatch"],
    fixHints: [
      "sudo systemctl status cron --no-pager",
      "sudo crontab -l | grep -n 'generate_metrics.sh'",
      "sudo grep -R -n '/opt/stackpilot-monitor/generate_metrics.sh' /etc/cron* || true",
    ],
  },
};

function nowIso() {
  return new Date().toISOString();
}

function isoHoursAgo(hours) {
  return new Date(Date.now() - Number(hours) * 60 * 60 * 1000).toISOString();
}

function round(value, digits = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const power = 10 ** digits;
  return Math.round(numeric * power) / power;
}

function ageMinutesFromIso(isoValue) {
  if (!isoValue) {
    return null;
  }
  const parsed = new Date(isoValue).getTime();
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return round((Date.now() - parsed) / (60 * 1000), 1);
}

function sanitizeWindow(window) {
  if (window === "7d") {
    return { window: "7d", hours: 24 * 7 };
  }
  if (window === "30d") {
    return { window: "30d", hours: 24 * 30 };
  }
  return { window: "24h", hours: 24 };
}

function sanitizeControl(control) {
  const value = String(control || "")
    .trim()
    .toLowerCase();
  if (!value) {
    return null;
  }
  return Object.prototype.hasOwnProperty.call(OPERATIONS_CONTROLS, value) ? value : null;
}

function safeExec(command, args = [], timeoutMs = 2200) {
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

function normalizeSeverity(value) {
  const normalized = String(value || "info").trim().toLowerCase();
  if (normalized === "critical") return "critical";
  if (normalized === "warning") return "warning";
  return "info";
}

function severityRank(value) {
  const normalized = normalizeSeverity(value);
  if (normalized === "critical") return 3;
  if (normalized === "warning") return 2;
  return 1;
}

function healthRank(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "critical") return 4;
  if (normalized === "warning") return 3;
  if (normalized === "degraded") return 2;
  if (normalized === "unknown") return 1;
  return 0;
}

function coerceHealthFromSeverity(severity) {
  if (normalizeSeverity(severity) === "critical") return "critical";
  if (normalizeSeverity(severity) === "warning") return "warning";
  return "healthy";
}

function combineHealth(...values) {
  const highest = values.reduce((max, value) => Math.max(max, healthRank(value)), 0);
  if (highest >= healthRank("critical")) return "critical";
  if (highest >= healthRank("warning")) return "warning";
  if (highest >= healthRank("degraded")) return "degraded";
  if (highest >= healthRank("unknown")) return "unknown";
  return "healthy";
}

function resolveSystemdState(result) {
  if (!result.ok) {
    return {
      state: "unknown",
      health: "unknown",
      message: result.stderr || result.message || "systemctl check failed.",
    };
  }

  const state = String(result.stdout || "").trim().toLowerCase();
  if (state === "active") {
    return { state: "active", health: "healthy", message: "service is active" };
  }
  if (state === "activating") {
    return { state: "activating", health: "warning", message: "service is activating" };
  }
  if (state === "inactive" || state === "failed") {
    return { state, health: "critical", message: `service is ${state}` };
  }

  return { state: state || "unknown", health: "degraded", message: `service is ${state || "unknown"}` };
}

function readTextFileSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return {
        ok: false,
        missing: true,
        path: filePath,
        content: "",
        message: "file not found",
      };
    }

    return {
      ok: true,
      missing: false,
      path: filePath,
      content: fs.readFileSync(filePath, "utf8"),
      message: null,
    };
  } catch (error) {
    return {
      ok: false,
      missing: false,
      path: filePath,
      content: "",
      message: error.message || "read failed",
    };
  }
}

function hashFingerprint(parts) {
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex");
}

function makeOpsEvent({
  source,
  severity = "warning",
  code,
  title,
  message,
  rawSnippet = null,
  metadata = null,
  fingerprintSeed = null,
}) {
  const normalizedSource = String(source || "unknown").trim().toLowerCase();
  const normalizedCode = String(code || "OPS_EVENT").trim().toUpperCase();
  const normalizedSeverity = normalizeSeverity(severity);
  const fingerprint = hashFingerprint([
    normalizedSource,
    normalizedCode,
    String(fingerprintSeed || title || message || ""),
  ]);

  return {
    source: normalizedSource,
    severity: normalizedSeverity,
    code: normalizedCode,
    title: String(title || "Operational issue detected"),
    message: String(message || "Operational issue detected."),
    fingerprint,
    status: "open",
    rawSnippet: rawSnippet == null ? null : String(rawSnippet),
    metadataJson: metadata == null ? null : JSON.stringify(metadata),
  };
}

function parsePostfixConfig(mainCfText) {
  const lines = String(mainCfText || "").split("\n");
  const keys = new Map();

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const withoutComment = raw.replace(/\s+#.*$/, "");
    const trimmed = withoutComment.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }

    const key = match[1].trim();
    const value = match[2].trim();
    if (!keys.has(key)) {
      keys.set(key, []);
    }

    keys.get(key).push({
      key,
      value,
      line: index + 1,
    });
  }

  const issues = [];
  for (const [key, entries] of keys.entries()) {
    if (entries.length > 1) {
      const severity = POSTFIX_DUPLICATE_KEY_SEVERITY.has(key) ? "warning" : "info";
      const lineList = entries.map((entry) => entry.line).join(", ");
      issues.push({
        key,
        severity,
        code: "POSTFIX_DUPLICATE_KEY",
        title: `Duplicate Postfix key: ${key}`,
        message: `Postfix main.cf has duplicate "${key}" entries on lines ${lineList}.`,
        lineList,
        rawSnippet: entries.map((entry) => `${entry.key}=${entry.value}`).join(" | "),
      });
    }
  }

  return {
    keys,
    issues,
  };
}

function parsePostqueueCount(raw) {
  const text = String(raw || "");
  if (!text.trim()) {
    return { queueCount: null, message: "postqueue output unavailable" };
  }

  if (/mail queue is empty/i.test(text)) {
    return { queueCount: 0, message: "Mail queue is empty." };
  }

  const summaryMatch = text.match(/in\s+(\d+)\s+requests?/i);
  if (summaryMatch) {
    return {
      queueCount: Number(summaryMatch[1]),
      message: summaryMatch[0],
    };
  }

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const requestLines = lines.filter((line) => /^[A-F0-9]/i.test(line));
  if (requestLines.length > 0) {
    return {
      queueCount: requestLines.length,
      message: `Detected ${requestLines.length} queued entries.`,
    };
  }

  return { queueCount: null, message: "Unable to infer queue count." };
}

function listCronFiles() {
  const files = [];
  if (fs.existsSync("/etc/crontab")) {
    files.push("/etc/crontab");
  }

  const cronDir = "/etc/cron.d";
  try {
    if (fs.existsSync(cronDir)) {
      const entries = fs.readdirSync(cronDir);
      for (const entry of entries) {
        const fullPath = path.join(cronDir, entry);
        if (!fs.statSync(fullPath).isFile()) {
          continue;
        }
        files.push(fullPath);
      }
    }
  } catch (error) {
    // ignore and continue with readable files only
  }

  return files;
}

function extractLogWarnings(rawText) {
  const lines = String(rawText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const warnings = [];
  for (const line of lines) {
    const lower = line.toLowerCase();

    if (lower.includes("overriding earlier entry") && lower.includes("/etc/postfix/main.cf")) {
      const keyMatch = line.match(/overriding earlier entry:\s*([a-zA-Z0-9_.-]+)=/i);
      const duplicateKey = keyMatch ? keyMatch[1] : "unknown";
      warnings.push({
        source: "postfix",
        severity: POSTFIX_DUPLICATE_KEY_SEVERITY.has(duplicateKey) ? "warning" : "info",
        code: "POSTFIX_DUPLICATE_WARNING",
        title: `Postfix duplicate warning (${duplicateKey})`,
        message: `Postfix log reports duplicate "${duplicateKey}" entry in main.cf.`,
        rawSnippet: line,
        fingerprintSeed: `${duplicateKey}:duplicate-warning`,
      });
      continue;
    }

    if (lower.includes(STALE_METRICS_SCRIPT_PATH.toLowerCase()) && lower.includes("not found")) {
      warnings.push({
        source: "cron",
        severity: "critical",
        code: "CRON_STALE_METRICS_PATH",
        title: "Cron references stale metrics path",
        message: "Cron attempted stale /opt metrics script path which does not exist.",
        rawSnippet: line,
        fingerprintSeed: "cron-stale-path-logwatch",
      });
      continue;
    }

    if (lower.includes("logwatch") && (lower.includes("error") || lower.includes("warning"))) {
      warnings.push({
        source: "logwatch",
        severity: "warning",
        code: "LOGWATCH_WARNING",
        title: "Logwatch warning detected",
        message: "Logwatch produced warning/error output.",
        rawSnippet: line,
        fingerprintSeed: line,
      });
      continue;
    }

    if (lower.includes("fail2ban") && (lower.includes("error") || lower.includes("warning"))) {
      warnings.push({
        source: "fail2ban",
        severity: "warning",
        code: "FAIL2BAN_WARNING",
        title: "Fail2Ban warning detected",
        message: "Fail2Ban logs include warning/error output.",
        rawSnippet: line,
        fingerprintSeed: line,
      });
      continue;
    }

    if (lower.includes("aide") && (lower.includes("error") || lower.includes("warning"))) {
      warnings.push({
        source: "aide",
        severity: "warning",
        code: "AIDE_WARNING",
        title: "AIDE warning detected",
        message: "AIDE logs include warning/error output.",
        rawSnippet: line,
        fingerprintSeed: line,
      });
    }
  }

  return warnings;
}

function summarizeLogWarnings(warnings) {
  const summaryBySource = {};
  const summaryByCode = {};
  for (const warning of warnings) {
    const source = String(warning.source || "unknown");
    const code = String(warning.code || "UNKNOWN");
    summaryBySource[source] = Number(summaryBySource[source] || 0) + 1;
    summaryByCode[code] = Number(summaryByCode[code] || 0) + 1;
  }

  return {
    total: warnings.length,
    bySource: summaryBySource,
    byCode: summaryByCode,
  };
}

function parseFail2banJails(rawStatus) {
  const text = String(rawStatus || "");
  const match = text.match(/Jail list:\s*(.+)$/im);
  if (!match) {
    return [];
  }

  return String(match[1] || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function pickFirstExistingPath(paths) {
  for (const item of paths) {
    if (fs.existsSync(item)) {
      return item;
    }
  }
  return null;
}

function createOpsInsightService({
  env,
  repository,
  mailService,
  alertService,
  logger = console,
}) {
  let lastSnapshot = null;
  let lastCollectedAt = null;
  let inFlight = null;

  const collectIntervalMs = Math.max(30, Number(env.DASHBOARD_OPS_COLLECT_INTERVAL_SECONDS || 300)) * 1000;
  const retentionDays = Number(env.DASHBOARD_OPS_RETENTION_DAYS || env.DASHBOARD_RETENTION_DAYS || 90);
  const logTailLines = Math.max(100, Number(env.DASHBOARD_OPS_LOG_TAIL_LINES || 400));

  function getFreshnessSeconds() {
    if (!lastCollectedAt) {
      return null;
    }
    return Math.max(0, Math.round((Date.now() - new Date(lastCollectedAt).getTime()) / 1000));
  }

  function getControlHealth(controlKey, snapshot) {
    const controls = snapshot?.controls || {};
    if (controlKey === "aide") {
      return controls.aide?.health || "unknown";
    }
    if (controlKey === "fail2ban") {
      return controls.fail2ban?.health || "unknown";
    }
    if (controlKey === "relay") {
      if (controls.relay?.ok === true) {
        return "healthy";
      }
      if (controls.relay?.ok === false) {
        return "critical";
      }
      return "unknown";
    }
    if (controlKey === "postfix") {
      return controls.postfix?.health || "unknown";
    }
    if (controlKey === "crontab") {
      return combineHealth(controls.cron?.health, controls.logwatch?.health);
    }
    return "unknown";
  }

  function getControlDetails(controlKey, snapshot) {
    const controls = snapshot?.controls || {};
    if (controlKey === "aide") {
      return {
        aide: controls.aide || {},
        controlFreshnessMinutes: snapshot?.security?.controlFreshnessMinutes ?? null,
      };
    }

    if (controlKey === "fail2ban") {
      return {
        fail2ban: controls.fail2ban || {},
      };
    }

    if (controlKey === "relay") {
      return {
        relay: controls.relay || {},
        queue: snapshot?.mailRuntime?.queue || {},
        quota: snapshot?.mailRuntime?.quota || {},
      };
    }

    if (controlKey === "postfix") {
      return {
        postfix: controls.postfix || {},
        postfixWarningCounts: snapshot?.mailRuntime?.postfixWarningCounts || {},
      };
    }

    if (controlKey === "crontab") {
      return {
        cron: controls.cron || {},
        logwatch: controls.logwatch || {},
        cronRuntime: snapshot?.cronRuntime || {},
      };
    }

    return {};
  }

  async function collectPostfixConfigIssues() {
    const configPath = String(env.DASHBOARD_POSTFIX_MAIN_CF_PATH || POSTFIX_MAIN_CF_DEFAULT);
    const fileResult = readTextFileSafe(configPath);
    if (!fileResult.ok) {
      return {
        health: fileResult.missing ? "warning" : "unknown",
        path: configPath,
        duplicateCount: 0,
        warningCount: 0,
        issues: [
          {
            key: "main.cf",
            severity: fileResult.missing ? "warning" : "info",
            code: fileResult.missing ? "POSTFIX_CONFIG_MISSING" : "POSTFIX_CONFIG_UNREADABLE",
            title: fileResult.missing ? "Postfix config file missing" : "Postfix config file unreadable",
            message: fileResult.missing
              ? `Postfix config file not found at ${configPath}.`
              : `Postfix config could not be read: ${fileResult.message || "unknown error"}.`,
            lineList: null,
            rawSnippet: fileResult.message || null,
          },
        ],
      };
    }

    const parsed = parsePostfixConfig(fileResult.content);
    const warningCount = parsed.issues.filter((issue) => normalizeSeverity(issue.severity) !== "info").length;
    const health = warningCount > 0 ? "warning" : "healthy";

    return {
      health,
      path: configPath,
      duplicateCount: parsed.issues.length,
      warningCount,
      issues: parsed.issues,
    };
  }

  async function collectPostfixRuntime() {
    const [serviceResult, queueResult] = await Promise.all([
      safeExec("systemctl", ["is-active", "postfix"]),
      safeExec("postqueue", ["-p"], 2500),
    ]);

    const serviceState = resolveSystemdState(serviceResult);
    const queueParsed = parsePostqueueCount(queueResult.stdout || queueResult.stderr || "");

    const queueHealth =
      queueParsed.queueCount == null
        ? queueResult.ok
          ? "unknown"
          : "warning"
        : queueParsed.queueCount > 0
          ? "warning"
          : "healthy";

    return {
      health: combineHealth(serviceState.health, queueHealth),
      serviceState: serviceState.state,
      serviceMessage: serviceState.message,
      queueCount: queueParsed.queueCount,
      queueMessage: queueParsed.message,
      queueCommandError: queueResult.ok ? null : queueResult.stderr || queueResult.message || "postqueue failed",
    };
  }

  async function collectCronRuntime() {
    const scannedEntries = [];
    const staleReferences = [];
    const expectedReferences = [];

    const userCrontab = safeExec("crontab", ["-l"]);
    if (userCrontab.ok && userCrontab.stdout) {
      scannedEntries.push({
        source: "crontab:user",
        lines: userCrontab.stdout.split("\n"),
      });
    }

    const files = listCronFiles();
    for (const cronFile of files) {
      const fileResult = readTextFileSafe(cronFile);
      if (fileResult.ok) {
        scannedEntries.push({
          source: cronFile,
          lines: String(fileResult.content || "").split("\n"),
        });
      }
    }

    for (const entry of scannedEntries) {
      const lines = Array.isArray(entry.lines) ? entry.lines : [];
      for (let index = 0; index < lines.length; index += 1) {
        const line = String(lines[index] || "");
        if (!line.trim() || line.trim().startsWith("#")) {
          continue;
        }

        if (line.includes(STALE_METRICS_SCRIPT_PATH)) {
          staleReferences.push({
            source: entry.source,
            line: index + 1,
            snippet: line.trim(),
          });
        }

        if (line.includes(METRICS_SCRIPT_PATH)) {
          expectedReferences.push({
            source: entry.source,
            line: index + 1,
            snippet: line.trim(),
          });
        }
      }
    }

    const cronService = resolveSystemdState(safeExec("systemctl", ["is-active", "cron"]));
    const staleCount = staleReferences.length;
    const expectedCount = expectedReferences.length;
    const schedulerHealth = cronService.health;
    const metricsJobHealth = staleCount > 0 ? "critical" : expectedCount > 0 ? "healthy" : "warning";
    const health = combineHealth(schedulerHealth, metricsJobHealth);

    return {
      health,
      schedulerStatus: {
        state: cronService.state,
        health: schedulerHealth,
        message: cronService.message,
      },
      metricsJob: {
        expectedPath: METRICS_SCRIPT_PATH,
        stalePath: STALE_METRICS_SCRIPT_PATH,
        expectedReferences: expectedCount,
        staleReferences: staleCount,
        health: metricsJobHealth,
        message:
          staleCount > 0
            ? `Detected ${staleCount} stale cron reference(s) to ${STALE_METRICS_SCRIPT_PATH}.`
            : expectedCount > 0
              ? "Metrics cron path appears correctly configured."
              : `No visible cron reference found for ${METRICS_SCRIPT_PATH}.`,
      },
      staleReferences,
      expectedReferences,
      scannedSources: scannedEntries.map((entry) => entry.source),
    };
  }

  async function collectLogWarnings() {
    const sources = [
      {
        label: "/var/log/mail.log",
        command: "tail",
        args: ["-n", String(logTailLines), "/var/log/mail.log"],
      },
      {
        label: "/var/log/syslog",
        command: "tail",
        args: ["-n", String(logTailLines), "/var/log/syslog"],
      },
      {
        label: "journalctl:postfix+cron+fail2ban",
        command: "journalctl",
        args: [
          "--no-pager",
          "-n",
          String(logTailLines),
          "-u",
          "postfix",
          "-u",
          "cron",
          "-u",
          "fail2ban",
        ],
      },
    ];

    let selectedSource = null;
    let text = "";
    for (const source of sources) {
      const result = safeExec(source.command, source.args, 2600);
      if (result.ok && String(result.stdout || "").trim()) {
        selectedSource = source.label;
        text = result.stdout;
        break;
      }
    }

    const warnings = extractLogWarnings(text);
    const summary = summarizeLogWarnings(warnings);
    const health = warnings.length > 0 ? "warning" : "healthy";

    return {
      health,
      source: selectedSource,
      warningCount: warnings.length,
      summary,
      warnings,
    };
  }

  async function collectFail2banState() {
    const service = resolveSystemdState(safeExec("systemctl", ["is-active", "fail2ban"]));
    const statusResult = safeExec("fail2ban-client", ["status"], 2200);
    const jails = statusResult.ok ? parseFail2banJails(statusResult.stdout) : [];
    const health = combineHealth(service.health, statusResult.ok ? "healthy" : "warning");

    return {
      health,
      serviceState: service.state,
      serviceMessage: service.message,
      jailCount: jails.length,
      jailList: jails,
      summary: statusResult.ok
        ? `Jails active: ${jails.length ? jails.join(", ") : "none"}`
        : statusResult.stderr || statusResult.message || "fail2ban-client status unavailable.",
    };
  }

  async function collectAideState() {
    const baselinePath = pickFirstExistingPath([
      "/var/lib/aide/aide.db",
      "/var/lib/aide/aide.db.gz",
      "/var/lib/aide/aide.db.new",
    ]);

    const lastCheckPath = pickFirstExistingPath([
      "/var/log/aide/aide.log",
      "/var/log/aide.log",
      baselinePath,
    ]);

    let lastCheckAt = null;
    if (lastCheckPath) {
      try {
        const stat = fs.statSync(lastCheckPath);
        lastCheckAt = stat.mtime.toISOString();
      } catch (error) {
        lastCheckAt = null;
      }
    }

    const baselinePresent = Boolean(baselinePath);
    const health = baselinePresent ? "healthy" : "warning";

    return {
      health,
      baselinePresent,
      baselinePath: baselinePath || null,
      lastCheckPath: lastCheckPath || null,
      lastCheckAt,
      lastCheckAgeMinutes: ageMinutesFromIso(lastCheckAt),
      message: baselinePresent
        ? `AIDE baseline present at ${baselinePath}.`
        : "AIDE baseline database is missing.",
    };
  }

  async function collectRelayState() {
    try {
      const snapshot = await mailService.getHealthSnapshot();
      return {
        health: snapshot.relay.ok ? "healthy" : "critical",
        relay: snapshot.relay,
        queue: snapshot.queue,
        quota: snapshot.quota,
      };
    } catch (error) {
      return {
        health: "unknown",
        relay: {
          ok: false,
          host: env.MAIL_RELAY_HOST,
          port: env.MAIL_RELAY_PORT,
          errorCode: "RELAY_HEALTH_UNAVAILABLE",
          errorMessage: error.message || "Unable to collect relay health.",
        },
        queue: {
          pending: 0,
          retrying: 0,
          failed: 0,
        },
        quota: {
          used: 0,
          limit: env.MAIL_DAILY_LIMIT,
          remaining: env.MAIL_DAILY_LIMIT,
        },
      };
    }
  }

  function buildOpsEvents({
    postfixConfig,
    postfixRuntime,
    cronRuntime,
    logWarnings,
    fail2ban,
    aide,
    relayState,
  }) {
    const events = [];

    for (const issue of postfixConfig.issues || []) {
      events.push(
        makeOpsEvent({
          source: "postfix",
          severity: issue.severity,
          code: issue.code,
          title: issue.title,
          message: issue.message,
          rawSnippet: issue.rawSnippet,
          metadata: {
            key: issue.key,
            lineList: issue.lineList,
            configPath: postfixConfig.path,
          },
          fingerprintSeed: `${issue.code}:${issue.key}:${issue.lineList || ""}`,
        })
      );
    }

    if (postfixRuntime.serviceState !== "active") {
      events.push(
        makeOpsEvent({
          source: "postfix",
          severity: "critical",
          code: "POSTFIX_SERVICE_NOT_ACTIVE",
          title: "Postfix service is not active",
          message: `systemctl reports postfix state: ${postfixRuntime.serviceState}.`,
          rawSnippet: postfixRuntime.serviceMessage,
          metadata: {
            serviceState: postfixRuntime.serviceState,
          },
          fingerprintSeed: "postfix-service-state",
        })
      );
    }

    if (Number(postfixRuntime.queueCount || 0) > 0) {
      events.push(
        makeOpsEvent({
          source: "relay",
          severity: Number(postfixRuntime.queueCount || 0) > 20 ? "critical" : "warning",
          code: "POSTFIX_QUEUE_BACKLOG",
          title: "Postfix queue backlog detected",
          message: `Postfix queue contains ${postfixRuntime.queueCount} request(s).`,
          rawSnippet: postfixRuntime.queueMessage,
          metadata: {
            queueCount: postfixRuntime.queueCount,
          },
          fingerprintSeed: "postfix-queue-backlog",
        })
      );
    }

    if (cronRuntime.metricsJob.staleReferences > 0) {
      events.push(
        makeOpsEvent({
          source: "cron",
          severity: "critical",
          code: "CRON_STALE_METRICS_PATH",
          title: "Cron still references stale metrics script path",
          message: `Detected ${cronRuntime.metricsJob.staleReferences} stale cron reference(s) to ${STALE_METRICS_SCRIPT_PATH}.`,
          rawSnippet: cronRuntime.staleReferences[0]?.snippet || null,
          metadata: {
            staleReferences: cronRuntime.staleReferences,
          },
          fingerprintSeed: "cron-stale-metrics-path",
        })
      );
    }

    if (cronRuntime.metricsJob.expectedReferences <= 0) {
      events.push(
        makeOpsEvent({
          source: "cron",
          severity: "warning",
          code: "CRON_METRICS_JOB_MISSING",
          title: "Expected metrics cron entry not visible",
          message: `No visible cron entry found for ${METRICS_SCRIPT_PATH}.`,
          metadata: {
            scannedSources: cronRuntime.scannedSources,
          },
          fingerprintSeed: "cron-metrics-job-missing",
        })
      );
    }

    if (cronRuntime.schedulerStatus.state !== "active") {
      events.push(
        makeOpsEvent({
          source: "cron",
          severity: cronRuntime.schedulerStatus.state === "failed" ? "critical" : "warning",
          code: "CRON_SERVICE_NOT_ACTIVE",
          title: "Cron scheduler is not active",
          message: `Cron service state is ${cronRuntime.schedulerStatus.state}.`,
          rawSnippet: cronRuntime.schedulerStatus.message,
          fingerprintSeed: "cron-service-state",
        })
      );
    }

    for (const warning of logWarnings.warnings || []) {
      events.push(
        makeOpsEvent({
          source: warning.source,
          severity: warning.severity,
          code: warning.code,
          title: warning.title,
          message: warning.message,
          rawSnippet: warning.rawSnippet,
          metadata: {
            logSource: logWarnings.source,
          },
          fingerprintSeed: warning.fingerprintSeed || warning.rawSnippet || warning.code,
        })
      );
    }

    if (!relayState.relay.ok) {
      events.push(
        makeOpsEvent({
          source: "relay",
          severity: "critical",
          code: "RELAY_HEALTH_FAILED",
          title: "Relay verification failed",
          message: relayState.relay.errorMessage || "Relay verification failed.",
          rawSnippet: relayState.relay.errorCode || null,
          metadata: {
            host: relayState.relay.host,
            port: relayState.relay.port,
            errorCode: relayState.relay.errorCode || null,
          },
          fingerprintSeed: "relay-health-failed",
        })
      );
    }

    if (fail2ban.serviceState !== "active") {
      events.push(
        makeOpsEvent({
          source: "fail2ban",
          severity: fail2ban.serviceState === "failed" ? "critical" : "warning",
          code: "FAIL2BAN_NOT_ACTIVE",
          title: "Fail2Ban service is not active",
          message: `Fail2Ban service state is ${fail2ban.serviceState}.`,
          rawSnippet: fail2ban.summary,
          fingerprintSeed: "fail2ban-service-state",
        })
      );
    }

    if (!aide.baselinePresent) {
      events.push(
        makeOpsEvent({
          source: "aide",
          severity: "warning",
          code: "AIDE_BASELINE_MISSING",
          title: "AIDE baseline missing",
          message: "AIDE baseline database is missing on host.",
          rawSnippet: aide.lastCheckPath || null,
          metadata: {
            baselinePath: aide.baselinePath,
          },
          fingerprintSeed: "aide-baseline-missing",
        })
      );
    }

    return events;
  }

  async function persistOpsEvents(events) {
    const bySourceFingerprints = new Map();
    for (const source of KNOWN_OP_SOURCES) {
      bySourceFingerprints.set(source, []);
    }

    for (const event of events) {
      const source = String(event.source || "unknown");
      if (!bySourceFingerprints.has(source)) {
        bySourceFingerprints.set(source, []);
      }
      bySourceFingerprints.get(source).push(event.fingerprint);
      await repository.upsertOpsEvent(event);
    }

    for (const [source, fingerprints] of bySourceFingerprints.entries()) {
      await repository.resolveOpsEventsNotInFingerprints({
        source,
        activeFingerprints: fingerprints,
        resolvedAt: nowIso(),
      });
    }
  }

  async function collectAndPersist({ trigger = "scheduled" } = {}) {
    if (inFlight) {
      return inFlight;
    }

    inFlight = (async () => {
      const collectedAt = nowIso();
      const [postfixConfig, postfixRuntime, cronRuntime, logWarnings, fail2ban, aide, relayState, securitySignals] =
        await Promise.all([
          collectPostfixConfigIssues(),
          collectPostfixRuntime(),
          collectCronRuntime(),
          collectLogWarnings(),
          collectFail2banState(),
          collectAideState(),
          collectRelayState(),
          alertService.getSecuritySignals().catch(() => null),
        ]);

      const events = buildOpsEvents({
        postfixConfig,
        postfixRuntime,
        cronRuntime,
        logWarnings,
        fail2ban,
        aide,
        relayState,
      });

      await persistOpsEvents(events);

      const openIssues = await repository.listOpsEvents({
        status: "open",
        limit: 20,
        offset: 0,
      });

      const overallHealth = combineHealth(
        coerceHealthFromSeverity(openIssues[0]?.severity || "info"),
        postfixConfig.health,
        postfixRuntime.health,
        cronRuntime.health,
        logWarnings.health,
        fail2ban.health,
        aide.health,
        relayState.health
      );

      lastCollectedAt = collectedAt;
      lastSnapshot = {
        timestamp: collectedAt,
        trigger,
        overallHealth,
        controls: {
          aide,
          fail2ban,
          relay: relayState.relay,
          postfix: {
            health: combineHealth(postfixConfig.health, postfixRuntime.health),
            config: postfixConfig,
            runtime: postfixRuntime,
          },
          cron: {
            health: cronRuntime.health,
            ...cronRuntime,
          },
          logwatch: {
            health: logWarnings.health,
            source: logWarnings.source,
            warningCount: logWarnings.warningCount,
            summary: logWarnings.summary,
          },
        },
        mailRuntime: {
          relay: relayState.relay,
          queue: relayState.queue,
          quota: relayState.quota,
          postfixConfigHealth: {
            health: postfixConfig.health,
            duplicateCount: postfixConfig.duplicateCount,
            warningCount: postfixConfig.warningCount,
            issues: postfixConfig.issues,
          },
          cronNoiseHealth: {
            health: cronRuntime.health,
            staleReferences: cronRuntime.metricsJob.staleReferences,
            expectedReferences: cronRuntime.metricsJob.expectedReferences,
            schedulerState: cronRuntime.schedulerStatus.state,
          },
          logwatchSummary: {
            health: logWarnings.health,
            source: logWarnings.source,
            warningCount: logWarnings.warningCount,
            bySource: logWarnings.summary.bySource,
          },
          postfixWarningCounts: {
            total:
              Number(logWarnings.summary.byCode.POSTFIX_DUPLICATE_WARNING || 0) +
              Number(postfixConfig.duplicateCount || 0),
            byCode: {
              POSTFIX_DUPLICATE_WARNING: Number(
                logWarnings.summary.byCode.POSTFIX_DUPLICATE_WARNING || 0
              ),
              POSTFIX_DUPLICATE_KEY: Number(postfixConfig.duplicateCount || 0),
            },
          },
        },
        cronRuntime: {
          health: cronRuntime.health,
          schedulerState: cronRuntime.schedulerStatus.state,
          metricsJobStatus: cronRuntime.metricsJob.health,
          staleReferences: cronRuntime.metricsJob.staleReferences,
        },
        security: {
          aideLastCheckAt: aide.lastCheckAt,
          fail2banJailSummary: fail2ban.summary,
          fail2banJails: fail2ban.jailList,
          controlFreshnessMinutes: ageMinutesFromIso(collectedAt),
          sourceSignals: securitySignals,
        },
        topOpenIssues: openIssues.slice(0, 10),
      };

      return lastSnapshot;
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  async function ensureSnapshotFresh({ force = false } = {}) {
    const ageMs =
      lastCollectedAt == null ? Number.POSITIVE_INFINITY : Date.now() - new Date(lastCollectedAt).getTime();

    if (force || !lastSnapshot || ageMs > collectIntervalMs) {
      return collectAndPersist({ trigger: force ? "manual" : "api" });
    }

    return lastSnapshot;
  }

  async function getOperationsSnapshot({ window = "24h", force = false } = {}) {
    const windowConfig = sanitizeWindow(window);
    const snapshot = await ensureSnapshotFresh({ force });
    const sinceIso = isoHoursAgo(windowConfig.hours);
    const [sourceBreakdown, topOpenIssues] = await Promise.all([
      repository.getOpsSourceBreakdown({ sinceIso }),
      repository.listOpsEvents({ status: "open", limit: 20, offset: 0 }),
    ]);

    const totals = sourceBreakdown.reduce(
      (acc, row) => {
        const status = String(row.status || "open");
        const count = Number(row.count || 0);
        if (status === "open") {
          acc.open += count;
        } else if (status === "resolved") {
          acc.resolved += count;
        }
        return acc;
      },
      { open: 0, resolved: 0 }
    );

    return {
      timestamp: nowIso(),
      snapshotTimestamp: snapshot.timestamp,
      window: windowConfig.window,
      sinceIso,
      freshnessSeconds: getFreshnessSeconds(),
      overallHealth: snapshot.overallHealth,
      controls: snapshot.controls,
      mailRuntime: snapshot.mailRuntime,
      cronRuntime: snapshot.cronRuntime,
      sourceBreakdown: sourceBreakdown.map((row) => ({
        source: row.source,
        severity: row.severity,
        status: row.status,
        count: Number(row.count || 0),
      })),
      totals,
      topOpenIssues: topOpenIssues.slice(0, 15),
    };
  }

  async function getOperationsControlSnapshot({ control, window = "24h", force = false } = {}) {
    const controlKey = sanitizeControl(control);
    if (!controlKey) {
      const error = new Error(
        `Invalid control "${String(control || "")}". Expected one of: ${Object.keys(OPERATIONS_CONTROLS).join(", ")}.`
      );
      error.code = "INVALID_CONTROL";
      error.statusCode = 400;
      throw error;
    }

    const controlConfig = OPERATIONS_CONTROLS[controlKey];
    const windowConfig = sanitizeWindow(window);
    const snapshot = await ensureSnapshotFresh({ force });
    const sinceIso = isoHoursAgo(windowConfig.hours);
    const events = await repository.listOpsEvents({
      sinceIso,
      limit: 200,
      offset: 0,
    });

    const controlEvents = events.filter((event) => controlConfig.sources.includes(event.source));
    const sourceBreakdown = {};
    for (const event of controlEvents) {
      const source = String(event.source || "unknown");
      const status = String(event.status || "open");
      if (!sourceBreakdown[source]) {
        sourceBreakdown[source] = { open: 0, resolved: 0 };
      }
      if (status === "resolved") {
        sourceBreakdown[source].resolved += 1;
      } else {
        sourceBreakdown[source].open += 1;
      }
    }

    const totals = controlEvents.reduce(
      (acc, event) => {
        if (String(event.status || "open") === "resolved") {
          acc.resolved += 1;
        } else {
          acc.open += 1;
        }
        return acc;
      },
      { open: 0, resolved: 0 }
    );

    const topOpenIssues = controlEvents.filter((event) => String(event.status || "open") === "open");

    return {
      timestamp: nowIso(),
      snapshotTimestamp: snapshot.timestamp,
      window: windowConfig.window,
      sinceIso,
      control: controlConfig.key,
      label: controlConfig.label,
      sources: controlConfig.sources,
      freshnessSeconds: getFreshnessSeconds(),
      overallHealth: snapshot.overallHealth,
      controlHealth: getControlHealth(controlKey, snapshot),
      controlData: getControlDetails(controlKey, snapshot),
      sourceBreakdown,
      totals,
      topOpenIssues: topOpenIssues.slice(0, 25),
      fixHints: controlConfig.fixHints.slice(0, 8),
    };
  }

  async function listOpsEvents({
    source = null,
    status = null,
    severity = null,
    window = null,
    sinceIso = null,
    limit = 50,
    offset = 0,
  } = {}) {
    const parsedWindow = window ? sanitizeWindow(window) : null;
    const resolvedSinceIso = sinceIso || (parsedWindow ? isoHoursAgo(parsedWindow.hours) : null);
    return repository.listOpsEvents({
      source,
      status,
      severity,
      sinceIso: resolvedSinceIso,
      limit,
      offset,
    });
  }

  async function triggerRecheck() {
    const snapshot = await collectAndPersist({ trigger: "manual" });
    return {
      ok: true,
      recheckedAt: nowIso(),
      snapshotTimestamp: snapshot.timestamp,
      overallHealth: snapshot.overallHealth,
      topOpenIssues: snapshot.topOpenIssues.slice(0, 10),
      freshnessSeconds: getFreshnessSeconds(),
    };
  }

  async function getMailDiagnostics() {
    const snapshot = await ensureSnapshotFresh();
    return snapshot.mailRuntime;
  }

  async function getSecurityDiagnostics() {
    const snapshot = await ensureSnapshotFresh();
    return snapshot.security;
  }

  async function getProgramDiagnostics() {
    const snapshot = await ensureSnapshotFresh();
    return {
      cronSchedulerStatus: snapshot.controls.cron.schedulerStatus,
      cronMetricsJobStatus: snapshot.controls.cron.metricsJob,
      postfixConfigWarnings: snapshot.controls.postfix.config.issues || [],
    };
  }

  async function cleanupRetention() {
    await repository.cleanupOldOpsEvents(retentionDays);
  }

  function status() {
    return {
      collectIntervalMs,
      retentionDays,
      lastCollectedAt,
      freshnessSeconds: getFreshnessSeconds(),
      hasSnapshot: Boolean(lastSnapshot),
    };
  }

  return {
    collectAndPersist,
    ensureSnapshotFresh,
    getOperationsSnapshot,
    getOperationsControlSnapshot,
    listOpsEvents,
    triggerRecheck,
    getMailDiagnostics,
    getSecurityDiagnostics,
    getProgramDiagnostics,
    cleanupRetention,
    status,
  };
}

module.exports = {
  createOpsInsightService,
  __private: {
    parsePostfixConfig,
    extractLogWarnings,
    makeOpsEvent,
    normalizeSeverity,
    summarizeLogWarnings,
    sanitizeControl,
  },
};
