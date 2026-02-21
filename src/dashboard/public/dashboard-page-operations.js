import {
  badgeClass,
  escapeHtml,
  fetchJson,
  fmt,
  formatTime,
  renderPanel,
  renderSimpleTable,
  renderSummaryCard,
  renderKeyValueList,
  runPageLoader,
  setSubline,
  ensureSessionAndMountNav,
} from "./dashboard-pages-runtime.js";

const CONTROL_PAGE_CONFIG = {
  "operations-aide": {
    key: "aide",
    navKey: "aide",
    label: "AIDE Integrity Control",
    loadingLabel: "Loading AIDE baseline, check freshness, and integrity diagnostics...",
  },
  "operations-fail2ban": {
    key: "fail2ban",
    navKey: "fail2ban",
    label: "Fail2Ban Defense Control",
    loadingLabel: "Loading Fail2Ban jail and enforcement diagnostics...",
  },
  "operations-relay": {
    key: "relay",
    navKey: "relay",
    label: "SMTP Relay Control",
    loadingLabel: "Loading relay health, queue pressure, and delivery diagnostics...",
  },
  "operations-postfix": {
    key: "postfix",
    navKey: "postfix",
    label: "Postfix Runtime Control",
    loadingLabel: "Loading postfix config/runtime warnings and remediation guidance...",
  },
  "operations-crontab": {
    key: "crontab",
    navKey: "crontab",
    label: "Cron and Logwatch Control",
    loadingLabel: "Loading cron scheduler health and logwatch warning signatures...",
  },
  "operations-rclone": {
    key: "rclone",
    navKey: "rclone",
    label: "Rclone Backup and Sync Control",
    loadingLabel: "Loading rclone binary, remote connectivity, script wiring, and backup freshness...",
  },
};

function combineStatusTone(...values) {
  const normalized = values.map((value) => String(value || "").trim().toLowerCase());
  if (normalized.some((value) => value === "critical")) {
    return "critical";
  }
  if (normalized.some((value) => value === "warning" || value === "degraded")) {
    return "warning";
  }
  if (normalized.some((value) => value === "unknown")) {
    return "warning";
  }
  return "secure";
}

function mountOperationsSubnav(pageType) {
  const controls = document.querySelectorAll("[data-ops-target]");
  if (!controls.length) {
    return;
  }

  const activeKey = pageType === "operations" ? "all" : CONTROL_PAGE_CONFIG[pageType]?.navKey || "all";
  for (const link of controls) {
    const key = String(link.dataset.opsTarget || "").trim().toLowerCase();
    link.classList.toggle("active", key === activeKey);
  }
}

function renderOpsTimelineTable({ events, emptyMessage }) {
  const rows = events.map((event) => ({
    source: escapeHtml(fmt(event.source)),
    status: `<span class="${badgeClass(`${event.status}-${event.severity}`)}">${escapeHtml(
      `${fmt(event.status)} / ${fmt(event.severity)}`
    )}</span>`,
    code: escapeHtml(fmt(event.code)),
    title: escapeHtml(fmt(event.title)),
    seen: escapeHtml(`${fmt(event.count)}x`),
    firstSeen: escapeHtml(formatTime(event.firstSeenAt)),
    lastSeen: escapeHtml(formatTime(event.lastSeenAt)),
    snippet: `<span class="mono process-command" title="${escapeHtml(fmt(event.rawSnippet || "-"))}">${escapeHtml(
      fmt(event.rawSnippet || "-")
    )}</span>`,
  }));

  return renderSimpleTable({
    columns: [
      { key: "source", label: "Source", render: (row) => row.source },
      { key: "status", label: "Status", render: (row) => row.status },
      { key: "code", label: "Code", render: (row) => row.code },
      { key: "title", label: "Title", render: (row) => row.title },
      { key: "seen", label: "Seen", render: (row) => row.seen },
      { key: "firstSeen", label: "First Seen", render: (row) => row.firstSeen },
      { key: "lastSeen", label: "Last Seen", render: (row) => row.lastSeen },
      { key: "snippet", label: "Raw Snippet", render: (row) => row.snippet },
    ],
    rows,
    emptyMessage,
  });
}

function renderOpsFixHints({ hints }) {
  const list = Array.isArray(hints) ? hints : [];
  if (!list.length) {
    return '<p class="meta">No automated fix hints for current control.</p>';
  }

  return `<div class="ops-hints">${list
    .map((cmd) => {
      const value = String(cmd || "").trim();
      return `<div class="ops-hint-row">
        <code class="mono">${escapeHtml(value)}</code>
        <button type="button" class="ops-copy-btn" data-ops-copy-hint="${escapeHtml(value)}">Copy</button>
      </div>`;
    })
    .join("")}</div>`;
}

function ensureToastMount() {
  let mount = document.getElementById("opsToastMount");
  if (mount) {
    return mount;
  }

  mount = document.createElement("div");
  mount.id = "opsToastMount";
  mount.className = "toast-mount";
  mount.setAttribute("aria-live", "polite");
  mount.setAttribute("aria-atomic", "true");
  document.body.appendChild(mount);
  return mount;
}

function showOpsToast({ tone = "info", message = "", ttlMs = 2600 } = {}) {
  const text = String(message || "").trim();
  if (!text) {
    return;
  }

  const mount = ensureToastMount();
  const node = document.createElement("div");
  node.className = `ops-toast ${escapeHtml(String(tone || "info").toLowerCase())}`;
  node.textContent = text;
  mount.appendChild(node);
  window.setTimeout(() => {
    node.classList.add("hide");
    window.setTimeout(() => node.remove(), 260);
  }, ttlMs);
}

async function copyTextToClipboard(value, label = "Value") {
  const text = String(value || "");
  if (!text.trim()) {
    showOpsToast({ tone: "warning", message: `No ${label.toLowerCase()} to copy.` });
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    showOpsToast({ tone: "secure", message: `${label} copied.` });
  } catch (error) {
    showOpsToast({ tone: "critical", message: `Failed to copy ${label.toLowerCase()}.` });
  }
}

function bindOpsHintCopyButtons(scope = document) {
  for (const btn of scope.querySelectorAll("[data-ops-copy-hint]")) {
    btn.addEventListener("click", () => {
      const hint = String(btn.getAttribute("data-ops-copy-hint") || "");
      void copyTextToClipboard(hint, "Command");
    });
  }
}

function renderAideLivePanel(aideLivePayload) {
  const liveAide = aideLivePayload?.liveAide || {};
  const snapshotAide = aideLivePayload?.snapshotAide || {};
  const liveState = fmt(liveAide.health || "unknown");
  const snapshotState = fmt(snapshotAide.health || "unknown");

  return renderPanel({
    title: "AIDE Live Verification",
    meta: "Compares current host evidence against timeline snapshot to confirm warning is real-time or stale.",
    bodyHtml: renderKeyValueList([
      { label: "Live health", value: liveState },
      { label: "Snapshot health", value: snapshotState },
      { label: "Live matches snapshot", value: aideLivePayload?.matchesSnapshot ? "yes" : "no" },
      { label: "Baseline present (live)", value: liveAide.baselinePresent ? "yes" : "no" },
      { label: "Evidence source", value: fmt(liveAide.evidenceSource || "-") },
      { label: "Confidence", value: fmt(liveAide.confidence || "-") },
      { label: "Permission limited", value: liveAide.permissionLimited ? "yes" : "no" },
      { label: "Live checked at", value: formatTime(liveAide.liveCheckedAt || aideLivePayload?.timestamp) },
      { label: "Snapshot captured at", value: formatTime(aideLivePayload?.snapshotTimestamp) },
      { label: "Message", value: fmt(liveAide.message || "-") },
      { label: "Probe command", value: fmt(liveAide.probe?.command || "-") },
      { label: "Probe message", value: fmt(liveAide.probe?.message || "-") },
    ]),
  });
}

function renderAideCommandConsole(commandsPayload) {
  const commands = Array.isArray(commandsPayload?.commands) ? commandsPayload.commands : [];
  const enabled = Boolean(commandsPayload?.enabled);

  const commandCards = commands
    .map((command) => {
      const cooldown = Number(command.retryAfterSeconds || 0);
      const disabled = !enabled || command.inFlight || cooldown > 0;
      return `<article class="ops-command-card">
        <div class="ops-command-head">
          <strong>${escapeHtml(fmt(command.label))}</strong>
          <span class="${badgeClass(disabled ? "warning" : "secure")}">${disabled ? "WAIT" : "READY"}</span>
        </div>
        <p class="meta">${escapeHtml(fmt(command.description || "-"))}</p>
        <code class="mono">${escapeHtml(fmt(command.preview || "-"))}</code>
        <div class="control-row">
          <button type="button" data-aide-run="${escapeHtml(fmt(command.commandKey))}" ${
        disabled ? "disabled" : ""
      }>Run</button>
          <button type="button" data-aide-copy-command="${escapeHtml(fmt(command.commandKey))}">Copy Command</button>
        </div>
        <p class="meta">${escapeHtml(
          cooldown > 0 ? `Cooldown active (${cooldown}s)` : fmt(command.suggestion || "Safe operator action.")
        )}</p>
      </article>`;
    })
    .join("");

  const disabledText = enabled
    ? "Allowed commands are protected by confirmation, cooldown, and allowlist."
    : "Command runner is disabled by runtime configuration.";

  return renderPanel({
    title: "Live Command Console",
    meta: "Run approved AIDE sudo actions with live output stream. No raw shell access.",
    bodyHtml: `<div class="ops-runner" id="aideRunner">
      <div class="ops-command-list">${commandCards || '<div class="empty-state">No command definitions found.</div>'}</div>
      <div class="ops-console-toolbar">
        <span class="meta">${escapeHtml(disabledText)}</span>
        <span id="aideRunnerState" class="${badgeClass("info")}">IDLE</span>
        <span id="aideRunnerSpinner" class="ops-spinner" aria-hidden="true"></span>
        <button type="button" id="aideCopyOutputBtn">Copy Output</button>
        <button type="button" id="aideClearOutputBtn">Clear Output</button>
      </div>
      <pre id="aideConsoleOutput" class="ops-console-output">Console ready.</pre>
    </div>`,
  });
}

function renderLoadErrorPanel({ title, message }) {
  return renderPanel({
    title,
    meta: "Data request failed. Use refresh after verifying session and backend health.",
    bodyHtml: `<div class="empty-state">${escapeHtml(message || "Unknown error.")}</div>`,
  });
}

function describeRequestError(error, fallbackMessage) {
  if (!error) {
    return fallbackMessage || "Unknown error.";
  }
  const payloadMessage = error?.payload?.message;
  const message = payloadMessage || error?.message;
  return String(message || fallbackMessage || "Unknown error.");
}

function formatWindowLabel(windowValue) {
  const normalized = String(windowValue || "24h").trim().toLowerCase();
  if (normalized === "7d") return "weekly";
  if (normalized === "30d") return "monthly";
  if (normalized === "90d") return "quarterly";
  if (normalized === "365d") return "yearly";
  return "daily";
}

function bucketLabel(isoValue, windowValue) {
  const parsed = new Date(isoValue);
  if (Number.isNaN(parsed.getTime())) {
    return "-";
  }

  const normalized = String(windowValue || "24h").trim().toLowerCase();
  if (normalized === "24h") {
    return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (normalized === "7d") {
    return parsed.toLocaleDateString([], { weekday: "short" });
  }
  if (normalized === "30d" || normalized === "90d") {
    return parsed.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return parsed.toLocaleDateString([], { month: "short", year: "2-digit" });
}

function buildTimelineBuckets(events, windowValue) {
  const rows = Array.isArray(events) ? events : [];
  const maxRows = 18;
  const map = new Map();

  for (const event of rows) {
    const key = bucketLabel(event.lastSeenAt || event.firstSeenAt, windowValue);
    if (!map.has(key)) {
      map.set(key, {
        label: key,
        open: 0,
        resolved: 0,
        critical: 0,
        warning: 0,
        info: 0,
      });
    }

    const bucket = map.get(key);
    const status = String(event.status || "open").toLowerCase();
    const severity = String(event.severity || "info").toLowerCase();
    if (status === "resolved") {
      bucket.resolved += Number(event.count || 1);
    } else {
      bucket.open += Number(event.count || 1);
    }
    if (severity === "critical") {
      bucket.critical += Number(event.count || 1);
    } else if (severity === "warning") {
      bucket.warning += Number(event.count || 1);
    } else {
      bucket.info += Number(event.count || 1);
    }
  }

  return Array.from(map.values()).slice(-maxRows);
}

function renderStackedBars(rows) {
  const data = Array.isArray(rows) ? rows : [];
  if (!data.length) {
    return '<div class="empty-state">No timeline buckets available for selected window.</div>';
  }

  const maxTotal = Math.max(
    1,
    ...data.map((row) => Number(row.open || 0) + Number(row.resolved || 0))
  );

  return `<div class="ops-bar-chart">
    ${data
      .map((row) => {
        const open = Number(row.open || 0);
        const resolved = Number(row.resolved || 0);
        const total = open + resolved;
        const openPct = Math.round((open / maxTotal) * 100);
        const resolvedPct = Math.round((resolved / maxTotal) * 100);
        return `<div class="ops-bar-row">
          <div class="ops-bar-label">${escapeHtml(row.label)}</div>
          <div class="ops-bar-track">
            <span class="ops-bar-segment warning" style="width:${openPct}%"></span>
            <span class="ops-bar-segment secure" style="width:${resolvedPct}%"></span>
          </div>
          <div class="ops-bar-meta">open ${open} | resolved ${resolved} | total ${total}</div>
        </div>`;
      })
      .join("")}
  </div>`;
}

function renderMetricBars(rows) {
  const data = Array.isArray(rows) ? rows : [];
  if (!data.length) {
    return '<div class="empty-state">No metrics available.</div>';
  }

  const max = Math.max(1, ...data.map((row) => Number(row.value || 0)));
  return `<div class="ops-bar-chart">
    ${data
      .map((row) => {
        const value = Number(row.value || 0);
        const width = Math.max(2, Math.round((value / max) * 100));
        const tone = row.tone || "secure";
        return `<div class="ops-bar-row">
          <div class="ops-bar-label">${escapeHtml(row.label)}</div>
          <div class="ops-bar-track"><span class="ops-bar-segment ${escapeHtml(
            tone
          )}" style="width:${width}%"></span></div>
          <div class="ops-bar-meta">${escapeHtml(fmt(value))}</div>
        </div>`;
      })
      .join("")}
  </div>`;
}

function renderRcloneVisualPanels(snapshot, events) {
  const rows = Array.isArray(events) ? events : [];
  const rclone = snapshot.controlData?.rclone || {};
  const trigger = rclone.trigger || {};
  const backupLog = rclone.artifacts?.backupLog || {};
  const syncLog = rclone.artifacts?.syncLog || {};

  const timelineBuckets = buildTimelineBuckets(rows, snapshot.window);
  const severityRows = [
    {
      label: "Critical signatures",
      value: rows.filter((row) => String(row.severity || "").toLowerCase() === "critical").length,
      tone: "critical",
    },
    {
      label: "Warning signatures",
      value: rows.filter((row) => String(row.severity || "").toLowerCase() === "warning").length,
      tone: "warning",
    },
    {
      label: "Info signatures",
      value: rows.filter((row) => String(row.severity || "").toLowerCase() === "info").length,
      tone: "secure",
    },
    {
      label: "Open issues",
      value: Number(snapshot.totals?.open || 0),
      tone: Number(snapshot.totals?.open || 0) > 0 ? "warning" : "secure",
    },
  ];

  const runtimeRows = [
    {
      label: "Backup artifacts",
      value: Number(rclone.artifacts?.backupCount || 0),
      tone: rclone.artifacts?.backupCount > 0 ? "secure" : "warning",
    },
    {
      label: "Backup log errors",
      value: Number(backupLog.errorCount || 0),
      tone: Number(backupLog.errorCount || 0) > 0 ? "warning" : "secure",
    },
    {
      label: "Sync log errors",
      value: Number(syncLog.errorCount || 0),
      tone: Number(syncLog.errorCount || 0) > 0 ? "warning" : "secure",
    },
    {
      label: "Cooldown (s)",
      value: Number(trigger.cooldownSeconds || 0),
      tone: "secure",
    },
    {
      label: "Retry after (s)",
      value: Number(trigger.retryAfterSeconds || 0),
      tone: Number(trigger.retryAfterSeconds || 0) > 0 ? "warning" : "secure",
    },
  ];

  return [
    renderPanel({
      title: `Rclone Event Trend (${formatWindowLabel(snapshot.window)})`,
      meta: "Open vs resolved signatures by time bucket for selected window.",
      bodyHtml: renderStackedBars(timelineBuckets),
    }),
    renderPanel({
      title: "Rclone Health Mix",
      meta: "Severity distribution and runtime error pressure.",
      bodyHtml:
        `<div class="ops-visual-grid">` +
        `<div>${renderMetricBars(severityRows)}</div>` +
        `<div>${renderMetricBars(runtimeRows)}</div>` +
        `</div>`,
    }),
  ];
}

function describeRcloneTrigger(trigger) {
  const state = trigger || {};
  if (!state.enabled) {
    return "Auto-sync trigger is disabled by runtime configuration.";
  }
  if (state.inFlight) {
    return `Auto-sync trigger is running (PID ${fmt(state.lastPid || "-")}).`;
  }
  if (Number.isFinite(Number(state.retryAfterSeconds)) && Number(state.retryAfterSeconds) > 0) {
    return `Cooldown active. Trigger available in ${fmt(Math.max(0, Math.round(Number(state.retryAfterSeconds))))}s.`;
  }
  if (String(state.lastOutcome || "").toLowerCase() === "success") {
    return `Last trigger succeeded at ${formatTime(state.finishedAt)}. Cooldown ${fmt(state.cooldownSeconds || 0)}s.`;
  }
  if (String(state.lastOutcome || "").toLowerCase() === "failed") {
    return `Last trigger failed: ${fmt(state.lastError || "unknown error")}`;
  }
  return `Auto-sync trigger ready. Cooldown ${fmt(state.cooldownSeconds || 0)}s.`;
}

function renderControlDataPanels(controlKey, payload) {
  const data = payload.controlData || {};

  if (controlKey === "aide") {
    const aide = data.aide || {};
    return [
      renderPanel({
        title: "AIDE Baseline and Integrity",
        meta: "File integrity baseline status and latest check telemetry.",
        bodyHtml: renderKeyValueList([
          { label: "Health", value: fmt(payload.controlHealth) },
          { label: "Baseline present", value: aide.baselinePresent ? "yes" : "no" },
          { label: "Last check", value: formatTime(aide.lastCheckAt) },
          { label: "Baseline path", value: fmt(aide.baselinePath || "-") },
          { label: "Message", value: fmt(aide.message || "-") },
          {
            label: "Collector freshness",
            value:
              data.controlFreshnessMinutes == null
                ? "-"
                : `${fmt(data.controlFreshnessMinutes)} minutes`,
          },
        ]),
      }),
    ];
  }

  if (controlKey === "fail2ban") {
    const fail2ban = data.fail2ban || {};
    return [
      renderPanel({
        title: "Fail2Ban Runtime",
        meta: "Jail availability and anti-bruteforce enforcement health.",
        bodyHtml: renderKeyValueList([
          { label: "Health", value: fmt(payload.controlHealth) },
          { label: "Service available", value: fail2ban.available ? "yes" : "no" },
          { label: "Summary", value: fmt(fail2ban.summary || "-") },
          { label: "Jail count", value: fmt(fail2ban.jailCount || 0) },
          {
            label: "Jails",
            value:
              Array.isArray(fail2ban.jailList) && fail2ban.jailList.length
                ? fail2ban.jailList.join(", ")
                : "-",
          },
          { label: "Service message", value: fmt(fail2ban.serviceMessage || "-") },
        ]),
      }),
    ];
  }

  if (controlKey === "relay") {
    const relay = data.relay || {};
    const queue = data.queue || {};
    const quota = data.quota || {};
    return [
      renderPanel({
        title: "Relay and Queue Runtime",
        meta: "SMTP endpoint, queue pressure, and quota posture.",
        bodyHtml: renderKeyValueList([
          { label: "Health", value: fmt(payload.controlHealth) },
          { label: "Relay status", value: relay.ok ? "healthy" : "degraded" },
          { label: "Relay host", value: fmt(relay.host || "-") },
          { label: "Relay port", value: fmt(relay.port || "-") },
          { label: "Relay error code", value: fmt(relay.errorCode || "-") },
          { label: "Relay error message", value: fmt(relay.errorMessage || "-") },
          { label: "Queue pending", value: fmt(queue.pending || 0) },
          { label: "Queue retrying", value: fmt(queue.retrying || 0) },
          { label: "Queue failed", value: fmt(queue.failed || 0) },
          { label: "Quota used", value: fmt(quota.used || 0) },
          { label: "Quota limit", value: fmt(quota.limit || 0) },
        ]),
      }),
    ];
  }

  if (controlKey === "postfix") {
    const postfix = data.postfix || {};
    const config = postfix.config || {};
    const runtime = postfix.runtime || {};
    const warningCounts = data.postfixWarningCounts || {};

    const issueRows = (config.issues || []).map((issue) => ({
      key: escapeHtml(fmt(issue.key)),
      severity: `<span class="${badgeClass(issue.severity)}">${escapeHtml(fmt(issue.severity))}</span>`,
      lines: escapeHtml(fmt(issue.lineList || "-")),
      message: escapeHtml(fmt(issue.message)),
    }));

    return [
      renderPanel({
        title: "Postfix Config and Runtime",
        meta: "Duplicate main.cf keys, service state, and queue checks.",
        bodyHtml:
          renderKeyValueList([
            { label: "Health", value: fmt(payload.controlHealth) },
            { label: "Config path", value: fmt(config.path || "-") },
            { label: "Duplicate key count", value: fmt(config.duplicateCount || 0) },
            { label: "Warning count", value: fmt(config.warningCount || 0) },
            { label: "Service state", value: fmt(runtime.serviceState || "-") },
            { label: "Service message", value: fmt(runtime.serviceMessage || "-") },
            { label: "Queue count", value: fmt(runtime.queueCount == null ? "-" : runtime.queueCount) },
            { label: "Queue message", value: fmt(runtime.queueMessage || "-") },
            {
              label: "Postfix warning total",
              value: fmt(warningCounts.total || 0),
            },
          ]) +
          renderSimpleTable({
            columns: [
              { key: "key", label: "Key", render: (row) => row.key },
              { key: "severity", label: "Severity", render: (row) => row.severity },
              { key: "lines", label: "Lines", render: (row) => row.lines },
              { key: "message", label: "Message", render: (row) => row.message },
            ],
            rows: issueRows,
            emptyMessage: "No postfix config issues detected.",
          }),
      }),
    ];
  }

  if (controlKey === "crontab") {
    const cron = data.cron || {};
    const scheduler = cron.schedulerStatus || {};
    const metricsJob = cron.metricsJob || {};
    const logwatch = data.logwatch || {};

    const staleRows = (cron.staleReferences || []).map((row) => ({
      source: escapeHtml(fmt(row.source)),
      line: escapeHtml(fmt(row.line)),
      snippet: `<span class="mono process-command">${escapeHtml(fmt(row.snippet || "-"))}</span>`,
    }));

    return [
      renderPanel({
        title: "Cron Scheduler and Job Wiring",
        meta: "Cron daemon state and metrics-job path verification.",
        bodyHtml:
          renderKeyValueList([
            { label: "Health", value: fmt(payload.controlHealth) },
            { label: "Scheduler state", value: fmt(scheduler.state || "-") },
            { label: "Scheduler health", value: fmt(scheduler.health || "-") },
            { label: "Scheduler message", value: fmt(scheduler.message || "-") },
            { label: "Expected path", value: fmt(metricsJob.expectedPath || "-") },
            { label: "Stale path", value: fmt(metricsJob.stalePath || "-") },
            { label: "Expected references", value: fmt(metricsJob.expectedReferences || 0) },
            { label: "Stale references", value: fmt(metricsJob.staleReferences || 0) },
            { label: "Logwatch source", value: fmt(logwatch.source || "-") },
            { label: "Logwatch warning count", value: fmt(logwatch.warningCount || 0) },
          ]) +
          renderSimpleTable({
            columns: [
              { key: "source", label: "Source", render: (row) => row.source },
              { key: "line", label: "Line", render: (row) => row.line },
              { key: "snippet", label: "Snippet", render: (row) => row.snippet },
            ],
            rows: staleRows,
            emptyMessage: "No stale /opt metrics references detected.",
          }),
      }),
    ];
  }

  if (controlKey === "rclone") {
    const rclone = data.rclone || {};
    const binary = rclone.binary || {};
    const remote = rclone.remote || {};
    const scripts = rclone.scripts || {};
    const cron = rclone.cron || {};
    const artifacts = rclone.artifacts || {};
    const backupLog = artifacts.backupLog || {};
    const syncLog = artifacts.syncLog || {};
    const trigger = rclone.trigger || {};
    const brokenRows = (cron.references?.broken || []).map((row) => ({
      source: escapeHtml(fmt(row.source)),
      line: escapeHtml(fmt(row.line)),
      expectedPath: `<span class="mono process-command">${escapeHtml(fmt(row.expectedPath || "-"))}</span>`,
      snippet: `<span class="mono process-command">${escapeHtml(fmt(row.snippet || "-"))}</span>`,
    }));

    const logErrorRows = [
      ...(backupLog.recentErrors || []).map((line) => ({
        source: "backup.log",
        snippet: `<span class="mono process-command">${escapeHtml(fmt(line))}</span>`,
      })),
      ...(syncLog.recentErrors || []).map((line) => ({
        source: "sync.log",
        snippet: `<span class="mono process-command">${escapeHtml(fmt(line))}</span>`,
      })),
    ];

    return [
      renderPanel({
        title: "Rclone Runtime and Remote Connectivity",
        meta: "Monitor-only diagnostics for binary/config/remote and hybrid backup workflow wiring.",
        bodyHtml:
          renderKeyValueList([
            { label: "Health", value: fmt(payload.controlHealth) },
            { label: "Mode", value: fmt(rclone.mode || "monitor-only") },
            { label: "Profile mode", value: fmt(rclone.profileMode || "-") },
            { label: "Workflow coverage", value: fmt(rclone.scriptCoverage || "-") },
            { label: "Remote name", value: fmt(remote.name || rclone.remoteName || "-") },
            { label: "Remote target", value: fmt(remote.target || rclone.target || "-") },
            { label: "Rclone binary", value: binary.available ? `yes (${fmt(binary.version || "-")})` : "no" },
            { label: "Binary message", value: fmt(binary.message || "-") },
            { label: "Config path", value: fmt(rclone.config?.path || "-") },
            { label: "Config exists", value: rclone.config?.exists ? "yes" : "no" },
            { label: "Remote configured", value: remote.configured ? "yes" : "no" },
            { label: "Remote reachable", value: remote.reachable ? "yes" : "no" },
            { label: "Nightly script", value: scripts.nightly?.exists ? fmt(scripts.nightly.path) : "missing" },
            { label: "Auto-sync script", value: scripts.autosync?.exists ? fmt(scripts.autosync.path) : "missing" },
            { label: "Nightly cron refs", value: fmt(cron.nightlyReferences || 0) },
            { label: "Auto-sync cron refs", value: fmt(cron.autosyncReferences || 0) },
            { label: "Broken cron refs", value: fmt(cron.brokenReferences || 0) },
            { label: "Backup dir", value: fmt(artifacts.backupDir || "-") },
            { label: "Backup artifacts", value: fmt(artifacts.backupCount || 0) },
            { label: "Latest artifact", value: fmt(artifacts.latestArtifactPath || "-") },
            {
              label: "Latest artifact age",
              value:
                artifacts.latestArtifactAgeHours == null
                  ? "-"
                  : `${fmt(artifacts.latestArtifactAgeHours)}h (stale > ${fmt(
                      artifacts.staleThresholdHours || rclone.staleHours || 24
                    )}h)`,
            },
            { label: "Backup log", value: backupLog.exists ? fmt(backupLog.path) : "missing" },
            { label: "Backup log errors", value: fmt(backupLog.errorCount || 0) },
            { label: "Sync log", value: syncLog.exists ? fmt(syncLog.path) : "missing" },
            { label: "Sync log errors", value: fmt(syncLog.errorCount || 0) },
            { label: "Trigger enabled", value: trigger.enabled ? "yes" : "no" },
            { label: "Trigger state", value: trigger.inFlight ? "running" : fmt(trigger.lastOutcome || "idle") },
            {
              label: "Trigger retry-after",
              value:
                Number.isFinite(Number(trigger.retryAfterSeconds)) && Number(trigger.retryAfterSeconds) > 0
                  ? `${fmt(Math.max(0, Math.round(Number(trigger.retryAfterSeconds))))}s`
                  : "0s",
            },
            { label: "Last trigger finish", value: formatTime(trigger.finishedAt) },
            { label: "Last trigger error", value: fmt(trigger.lastError || "-") },
          ]) +
          renderSimpleTable({
            columns: [
              { key: "source", label: "Source", render: (row) => row.source },
              { key: "line", label: "Line", render: (row) => row.line },
              { key: "expectedPath", label: "Expected Path", render: (row) => row.expectedPath },
              { key: "snippet", label: "Cron Snippet", render: (row) => row.snippet },
            ],
            rows: brokenRows,
            emptyMessage: "No broken rclone cron references detected.",
          }) +
          renderSimpleTable({
            columns: [
              { key: "source", label: "Log Source", render: (row) => row.source },
              { key: "snippet", label: "Recent Error", render: (row) => row.snippet },
            ],
            rows: logErrorRows,
            emptyMessage: "No recent rclone log errors detected.",
          }),
      }),
    ];
  }

  return [
    renderPanel({
      title: "Control Diagnostics",
      meta: "No dedicated renderer for selected control.",
      bodyHtml: '<p class="meta">Unsupported control renderer.</p>',
    }),
  ];
}

async function loadOperationsPage() {
  const opsWindowSelect = document.getElementById("opsWindow");
  const sourceFilterSelect = document.getElementById("opsSourceFilter");
  const statusFilterSelect = document.getElementById("opsStatusFilter");
  const severityFilterSelect = document.getElementById("opsSeverityFilter");
  const windowValue = String(opsWindowSelect?.value || "24h");
  const sourceFilter = String(sourceFilterSelect?.value || "").trim().toLowerCase();
  const statusFilter = String(statusFilterSelect?.value || "").trim().toLowerCase();
  const severityFilter = String(severityFilterSelect?.value || "").trim().toLowerCase();

  const eventQuery = new URLSearchParams({
    window: windowValue,
    limit: "120",
    offset: "0",
  });
  if (sourceFilter) {
    eventQuery.set("source", sourceFilter);
  }
  if (statusFilter) {
    eventQuery.set("status", statusFilter);
  }
  if (severityFilter) {
    eventQuery.set("severity", severityFilter);
  }

  const activeFilters = [];
  if (sourceFilter) activeFilters.push(`source:${sourceFilter}`);
  if (statusFilter) activeFilters.push(`status:${statusFilter}`);
  if (severityFilter) activeFilters.push(`severity:${severityFilter}`);

  let operations = null;
  let eventsPayload = null;
  try {
    [operations, eventsPayload] = await Promise.all([
      fetchJson(`/api/v1/dashboard/operations?window=${encodeURIComponent(windowValue)}`),
      fetchJson(`/api/v1/dashboard/ops-events?${eventQuery.toString()}`),
    ]);
  } catch (error) {
    const message = error?.message || "Operations page failed to load.";
    setSubline(`Operations load failed: ${message}`);

    const failHtml = renderLoadErrorPanel({
      title: "Operations Data Load Failed",
      message,
    });
    for (const mountId of [
      "operationsSummary",
      "operationsControls",
      "operationsIssues",
      "operationsTimeline",
      "operationsHints",
    ]) {
      const mount = document.getElementById(mountId);
      if (mount) {
        mount.innerHTML = failHtml;
      }
    }
    return;
  }

  const events = Array.isArray(eventsPayload.events) ? eventsPayload.events : [];
  const controls = operations.controls || {};
  const postfix = controls.postfix || {};
  const cron = controls.cron || {};
  const fail2ban = controls.fail2ban || {};
  const aide = controls.aide || {};
  const logwatch = controls.logwatch || {};
  const rclone = controls.rclone || {};
  const topOpenIssues = Array.isArray(operations.topOpenIssues) ? operations.topOpenIssues : [];

  setSubline(
    `Last refresh ${formatTime(operations.snapshotTimestamp || operations.timestamp)} | Window ${
      operations.window || windowValue
    } | Open issues ${fmt(operations.totals?.open || 0)} | Freshness ${fmt(operations.freshnessSeconds)}s${
      activeFilters.length ? ` | Filters ${activeFilters.join(", ")}` : ""
    }`
  );

  const summaryMount = document.getElementById("operationsSummary");
  if (summaryMount) {
    summaryMount.innerHTML = [
      renderSummaryCard({
        label: "Overall Health",
        value: fmt(operations.overallHealth || "unknown"),
        sub: `${fmt(operations.totals?.open || 0)} open / ${fmt(operations.totals?.resolved || 0)} resolved`,
        tone: operations.overallHealth || "unknown",
      }),
      renderSummaryCard({
        label: "Postfix",
        value: fmt(postfix.health || "unknown"),
        sub: `${fmt(postfix.config?.duplicateCount || 0)} duplicate key warning(s)`,
        tone: postfix.health || "unknown",
      }),
      renderSummaryCard({
        label: "Cron + Logwatch",
        value: fmt(cron.health || "unknown"),
        sub: `${fmt(logwatch.warningCount || 0)} warning(s) in parsed logs`,
        tone: combineStatusTone(cron.health, logwatch.health),
      }),
      renderSummaryCard({
        label: "Fail2Ban + AIDE",
        value: `${fmt(fail2ban.health || "unknown")} / ${fmt(aide.health || "unknown")}`,
        sub: `Jails ${fmt(fail2ban.jailCount || 0)} | AIDE baseline ${aide.baselinePresent ? "present" : "missing"}`,
        tone: combineStatusTone(fail2ban.health, aide.health),
      }),
      renderSummaryCard({
        label: "Rclone",
        value: fmt(rclone.health || "unknown"),
        sub: `${fmt(rclone.profileMode || "none")} | cron ${fmt(rclone.cron?.nightlyReferences || 0)}/${fmt(
          rclone.cron?.autosyncReferences || 0
        )}`,
        tone: rclone.health || "unknown",
      }),
    ].join("");
  }

  const controlsMount = document.getElementById("operationsControls");
  if (controlsMount) {
    controlsMount.innerHTML = [
      renderPanel({
        title: "Control Health Matrix",
        meta: "AIDE, Fail2Ban, relay, postfix, cron/logwatch, and rclone state in one view.",
        bodyHtml: renderKeyValueList([
          { label: "AIDE", value: `${fmt(aide.health)} | ${fmt(aide.message || "-")}` },
          { label: "AIDE last check", value: formatTime(aide.lastCheckAt) },
          {
            label: "Fail2Ban",
            value: `${fmt(fail2ban.health)} | ${fmt(fail2ban.summary || fail2ban.serviceMessage || "-")}`,
          },
          {
            label: "Fail2Ban jails",
            value: Array.isArray(fail2ban.jailList) && fail2ban.jailList.length ? fail2ban.jailList.join(", ") : "-",
          },
          {
            label: "Relay",
            value: controls.relay?.ok ? "healthy" : `degraded (${fmt(controls.relay?.errorCode || "-")})`,
          },
          { label: "Postfix service", value: fmt(postfix.runtime?.serviceState || "-") },
          { label: "Postfix queue", value: fmt(postfix.runtime?.queueCount == null ? "-" : postfix.runtime.queueCount) },
          { label: "Cron scheduler", value: fmt(cron.schedulerStatus?.state || "-") },
          { label: "Metrics cron job", value: fmt(cron.metricsJob?.message || "-") },
          { label: "Log source", value: fmt(logwatch.source || "-") },
          { label: "Rclone health", value: fmt(rclone.health || "-") },
          { label: "Rclone profile", value: fmt(rclone.profileMode || "-") },
          { label: "Rclone remote", value: fmt(rclone.remoteName || rclone.remote?.name || "-") },
          { label: "Rclone artifacts", value: fmt(rclone.artifacts?.backupCount || 0) },
        ]),
      }),
      renderPanel({
        title: "Mail and Cron Runtime",
        meta: "Live mail runtime + cron/logwatch counters from the latest collector cycle.",
        bodyHtml: renderKeyValueList([
          { label: "Queue pending", value: fmt(operations.mailRuntime?.queue?.pending || 0) },
          { label: "Queue retrying", value: fmt(operations.mailRuntime?.queue?.retrying || 0) },
          { label: "Queue failed", value: fmt(operations.mailRuntime?.queue?.failed || 0) },
          { label: "Quota used", value: fmt(operations.mailRuntime?.quota?.used || 0) },
          { label: "Quota limit", value: fmt(operations.mailRuntime?.quota?.limit || 0) },
          { label: "Postfix warning total", value: fmt(operations.mailRuntime?.postfixWarningCounts?.total || 0) },
          { label: "Cron stale references", value: fmt(operations.mailRuntime?.cronNoiseHealth?.staleReferences || 0) },
          { label: "Logwatch warning count", value: fmt(operations.mailRuntime?.logwatchSummary?.warningCount || 0) },
          { label: "Rclone stale threshold", value: `${fmt(rclone.staleHours || 24)}h` },
          {
            label: "Rclone latest artifact age",
            value:
              rclone.artifacts?.latestArtifactAgeHours == null
                ? "-"
                : `${fmt(rclone.artifacts.latestArtifactAgeHours)}h`,
          },
        ]),
      }),
    ].join("");
  }

  const issuesMount = document.getElementById("operationsIssues");
  if (issuesMount) {
    const issueRows = topOpenIssues.map((issue) => ({
      source: escapeHtml(fmt(issue.source)),
      severity: `<span class="${badgeClass(issue.severity)}">${escapeHtml(fmt(issue.severity))}</span>`,
      code: escapeHtml(fmt(issue.code)),
      title: escapeHtml(fmt(issue.title)),
      message: escapeHtml(fmt(issue.message)),
      lastSeen: escapeHtml(formatTime(issue.lastSeenAt)),
    }));

    issuesMount.innerHTML = renderPanel({
      title: "Top Open Issues",
      meta: "Highest-severity unresolved operational events.",
      bodyHtml: renderSimpleTable({
        columns: [
          { key: "source", label: "Source", render: (row) => row.source },
          { key: "severity", label: "Severity", render: (row) => row.severity },
          { key: "code", label: "Code", render: (row) => row.code },
          { key: "title", label: "Title", render: (row) => row.title },
          { key: "message", label: "Message", render: (row) => row.message },
          { key: "lastSeen", label: "Last Seen", render: (row) => row.lastSeen },
        ],
        rows: issueRows,
        emptyMessage: "No open operational issues in current window.",
      }),
    });
  }

  const timelineMount = document.getElementById("operationsTimeline");
  if (timelineMount) {
    timelineMount.innerHTML = renderPanel({
      title: "Operations Event Timeline",
      meta: activeFilters.length
        ? `Live + timeline diagnostics with active filters (${activeFilters.join(", ")}).`
        : "Live + timeline diagnostics across cron, postfix, relay, fail2ban, aide, logwatch, and rclone.",
      bodyHtml: renderOpsTimelineTable({
        events,
        emptyMessage: "No operations timeline rows in current window.",
      }),
    });
  }

  const hintsMount = document.getElementById("operationsHints");
  if (hintsMount) {
    const hints = [
      "sudo bash /home/devuser/dev/email-vps/deploy/ops/fix_postfix_config.sh audit",
      "sudo bash /home/devuser/dev/email-vps/deploy/ops/fix_postfix_config.sh apply",
      "sudo postconf -n | grep -E 'relayhost|smtp_tls_security_level'",
      "sudo tail -n 120 /var/log/mail.log | grep -E 'overriding earlier entry|postfix|cron|logwatch'",
      "sudo crontab -l | grep -n 'generate_metrics.sh'",
      "sudo systemctl status postfix fail2ban cron --no-pager",
      "rclone version && rclone listremotes",
      "rclone lsd gdrive:",
      "ls -lah /home/devuser/backups | tail -n 20",
      "tail -n 80 /home/devuser/backups/backup.log",
      "tail -n 80 /home/devuser/backups/sync.log",
    ];

    hintsMount.innerHTML = renderPanel({
      title: "Fix Hints",
      meta: "Safe command-level checks to validate and remediate active operations issues.",
      bodyHtml: renderOpsFixHints({ hints }),
    });
    bindOpsHintCopyButtons(hintsMount);
  }
}

async function loadDedicatedControlPage(pageConfig) {
  const reloadPage = () => loadDedicatedControlPage(pageConfig);
  const windowSelect = document.getElementById("controlWindow");
  const statusFilterSelect = document.getElementById("controlStatusFilter");
  const severityFilterSelect = document.getElementById("controlSeverityFilter");
  const windowValue = String(windowSelect?.value || "24h");
  const statusFilter = String(statusFilterSelect?.value || "").trim().toLowerCase();
  const severityFilter = String(severityFilterSelect?.value || "").trim().toLowerCase();

  const eventQuery = new URLSearchParams({
    window: windowValue,
    limit: "160",
    offset: "0",
  });
  if (statusFilter) {
    eventQuery.set("status", statusFilter);
  }
  if (severityFilter) {
    eventQuery.set("severity", severityFilter);
  }

  let snapshot = null;
  let eventsPayload = null;
  let aideLivePayload = null;
  let aideCommandsPayload = null;
  let aideLiveError = null;
  let aideCommandsError = null;
  try {
    const requests = [
      fetchJson(
        `/api/v1/dashboard/operations/control/${encodeURIComponent(pageConfig.key)}?window=${encodeURIComponent(windowValue)}`
      ),
      fetchJson(`/api/v1/dashboard/ops-events?${eventQuery.toString()}`),
    ];
    const responses = await Promise.all(requests);
    snapshot = responses[0];
    eventsPayload = responses[1];
  } catch (error) {
    const message = describeRequestError(error, `${pageConfig.label} failed to load.`);
    setSubline(`${pageConfig.label} load failed: ${message}`);
    const summaryMount = document.getElementById("controlSummary");
    if (summaryMount) {
      summaryMount.innerHTML = renderLoadErrorPanel({
        title: `${pageConfig.label} Load Failed`,
        message,
      });
    }
    for (const mountId of ["controlVisuals", "controlLive", "controlStatus", "controlConsole", "controlTimeline", "controlHints"]) {
      const mount = document.getElementById(mountId);
      if (mount) {
        mount.innerHTML = "";
      }
    }
    const triggerBtn = document.getElementById("rcloneTriggerBtn");
    if (triggerBtn) {
      triggerBtn.disabled = true;
    }
    const triggerMeta = document.getElementById("rcloneTriggerMeta");
    if (triggerMeta) {
      triggerMeta.textContent = message;
    }
    return;
  }

  if (pageConfig.key === "aide") {
    const aideRequests = await Promise.allSettled([
      fetchJson("/api/v1/dashboard/operations/control/aide/live"),
      fetchJson("/api/v1/dashboard/operations/commands?control=aide"),
    ]);

    if (aideRequests[0].status === "fulfilled") {
      aideLivePayload = aideRequests[0].value;
    } else {
      aideLiveError = aideRequests[0].reason;
    }

    if (aideRequests[1].status === "fulfilled") {
      aideCommandsPayload = aideRequests[1].value;
    } else {
      aideCommandsError = aideRequests[1].reason;
    }
  }

  const events = (Array.isArray(eventsPayload.events) ? eventsPayload.events : []).filter((event) =>
    Array.isArray(snapshot.sources) ? snapshot.sources.includes(String(event.source || "")) : true
  );

  setSubline(
    `Last refresh ${formatTime(snapshot.snapshotTimestamp || snapshot.timestamp)} | ${pageConfig.label} | Open ${fmt(
      snapshot.totals?.open || 0
    )} | Freshness ${fmt(snapshot.freshnessSeconds)}s`
  );

  const summaryMount = document.getElementById("controlSummary");
  if (summaryMount) {
    summaryMount.innerHTML = [
      renderSummaryCard({
        label: "Control Health",
        value: fmt(snapshot.controlHealth || "unknown"),
        sub: `${fmt(snapshot.label || pageConfig.label)} | ${fmt(snapshot.window)}`,
        tone: snapshot.controlHealth || "unknown",
      }),
      renderSummaryCard({
        label: "Open Issues",
        value: fmt(snapshot.totals?.open || 0),
        sub: `Sources ${fmt((snapshot.sources || []).join(", "))}`,
        tone: Number(snapshot.totals?.open || 0) > 0 ? "warning" : "secure",
      }),
      renderSummaryCard({
        label: "Resolved",
        value: fmt(snapshot.totals?.resolved || 0),
        sub: "Within selected window",
        tone: "secure",
      }),
      renderSummaryCard({
        label: "Collector Freshness",
        value: `${fmt(snapshot.freshnessSeconds)}s`,
        sub: `Snapshot ${formatTime(snapshot.snapshotTimestamp)}`,
        tone: Number(snapshot.freshnessSeconds || 0) > 600 ? "warning" : "secure",
      }),
    ].join("");
  }

  const statusMount = document.getElementById("controlStatus");
  if (statusMount) {
    statusMount.innerHTML = renderControlDataPanels(pageConfig.key, snapshot).join("");
  }

  const liveMount = document.getElementById("controlLive");
  if (liveMount) {
    if (pageConfig.key === "aide" && aideLivePayload) {
      liveMount.innerHTML = renderAideLivePanel(aideLivePayload);
    } else if (pageConfig.key === "aide" && aideLiveError) {
      liveMount.innerHTML = renderLoadErrorPanel({
        title: "AIDE Live Verification Unavailable",
        message: describeRequestError(aideLiveError, "Live AIDE endpoint is unavailable on this deployment."),
      });
    } else {
      liveMount.innerHTML = "";
    }
  }

  const consoleMount = document.getElementById("controlConsole");
  if (consoleMount) {
    if (pageConfig.key === "aide" && aideCommandsPayload) {
      consoleMount.innerHTML = renderAideCommandConsole(aideCommandsPayload);
      bindAideCommandConsole({ commandsPayload: aideCommandsPayload, reloadPage });
    } else if (pageConfig.key === "aide" && aideCommandsError) {
      consoleMount.innerHTML = renderLoadErrorPanel({
        title: "AIDE Command Console Unavailable",
        message: describeRequestError(
          aideCommandsError,
          "Command runner endpoint is unavailable on this deployment."
        ),
      });
    } else {
      consoleMount.innerHTML = "";
    }
  }

  const timelineMount = document.getElementById("controlTimeline");
  if (timelineMount) {
    timelineMount.innerHTML = renderPanel({
      title: `${snapshot.label || pageConfig.label} Timeline`,
      meta: "Source-filtered operational events for the selected control.",
      bodyHtml: renderOpsTimelineTable({
        events,
        emptyMessage: "No matching control events in current window.",
      }),
    });
  }

  const hintsMount = document.getElementById("controlHints");
  if (hintsMount) {
    hintsMount.innerHTML = renderPanel({
      title: "Control Fix Hints",
      meta: "Operator-safe diagnostics and remediation commands.",
      bodyHtml: renderOpsFixHints({ hints: snapshot.fixHints }),
    });
    bindOpsHintCopyButtons(hintsMount);
  }

  const visualsMount = document.getElementById("controlVisuals");
  if (visualsMount) {
    if (pageConfig.key === "rclone") {
      visualsMount.innerHTML = renderRcloneVisualPanels(snapshot, events).join("");
    } else {
      visualsMount.innerHTML = "";
    }
  }

  const triggerMeta = document.getElementById("rcloneTriggerMeta");
  if (triggerMeta) {
    const trigger = snapshot.controlData?.rclone?.trigger || {};
    triggerMeta.textContent = describeRcloneTrigger(trigger);
  }

  const triggerBtn = document.getElementById("rcloneTriggerBtn");
  if (triggerBtn) {
    const trigger = snapshot.controlData?.rclone?.trigger || {};
    const blocked =
      !trigger.enabled ||
      Boolean(trigger.inFlight) ||
      (Number.isFinite(Number(trigger.retryAfterSeconds)) && Number(trigger.retryAfterSeconds) > 0);
    triggerBtn.disabled = blocked;
  }
}

function bindOperationsRecheck(reloadPage) {
  const recheckBtn = document.getElementById("opsRecheckBtn");
  if (!recheckBtn) {
    return;
  }

  recheckBtn.addEventListener("click", async () => {
    recheckBtn.disabled = true;
    const previous = recheckBtn.textContent;
    recheckBtn.textContent = "Rechecking...";
    try {
      const result = await fetchJson("/api/v1/dashboard/operations/recheck", { method: "POST" });
      recheckBtn.textContent = result.ok ? "Recheck Complete" : "Recheck Failed";
      if (reloadPage) {
        setTimeout(reloadPage, 1000);
      }
    } catch (error) {
      recheckBtn.textContent = "Recheck Failed";
    } finally {
      setTimeout(() => {
        recheckBtn.textContent = previous || "Recheck";
        recheckBtn.disabled = false;
      }, 1800);
    }
  });
}

function bindOperationsFilters(reloadPage) {
  const resetBtn = document.getElementById("opsFilterResetBtn");
  if (!resetBtn) {
    return;
  }

  resetBtn.addEventListener("click", () => {
    const sourceFilter = document.getElementById("opsSourceFilter");
    const statusFilter = document.getElementById("opsStatusFilter");
    const severityFilter = document.getElementById("opsSeverityFilter");

    if (sourceFilter) sourceFilter.value = "";
    if (statusFilter) statusFilter.value = "";
    if (severityFilter) severityFilter.value = "";

    if (typeof reloadPage === "function") {
      reloadPage();
    }
  });
}

function bindControlFilters(reloadPage) {
  const resetBtn = document.getElementById("controlFilterResetBtn");
  if (!resetBtn) {
    return;
  }

  resetBtn.addEventListener("click", () => {
    const statusFilter = document.getElementById("controlStatusFilter");
    const severityFilter = document.getElementById("controlSeverityFilter");

    if (statusFilter) statusFilter.value = "";
    if (severityFilter) severityFilter.value = "";

    if (typeof reloadPage === "function") {
      reloadPage();
    }
  });
}

function bindRcloneTrigger(reloadPage) {
  const triggerBtn = document.getElementById("rcloneTriggerBtn");
  const triggerMeta = document.getElementById("rcloneTriggerMeta");
  if (!triggerBtn) {
    return;
  }

  triggerBtn.addEventListener("click", async () => {
    if (triggerBtn.disabled) {
      return;
    }
    const previous = triggerBtn.textContent;
    triggerBtn.disabled = true;
    triggerBtn.textContent = "Triggering...";
    if (triggerMeta) {
      triggerMeta.textContent = "Submitting rclone auto-sync trigger...";
    }

    try {
      const response = await fetchJson("/api/v1/dashboard/operations/control/rclone/trigger-sync", {
        method: "POST",
      });
      if (triggerMeta) {
        triggerMeta.textContent = fmt(response.message || "Auto-sync trigger accepted.");
      }
    } catch (error) {
      const retryAfter = error?.payload?.retryAfterSeconds;
      const retryText =
        Number.isFinite(Number(retryAfter)) && Number(retryAfter) > 0
          ? ` Retry in ${Math.max(0, Math.round(Number(retryAfter)))}s.`
          : "";
      if (triggerMeta) {
        triggerMeta.textContent = `${error.message || "Trigger failed."}${retryText}`;
      }
    } finally {
      setTimeout(() => {
        triggerBtn.textContent = previous || "Trigger Auto-Sync";
        if (typeof reloadPage === "function") {
          void reloadPage();
        } else {
          triggerBtn.disabled = false;
        }
      }, 1200);
    }
  });
}

function appendAideOutput(text) {
  const outputEl = document.getElementById("aideConsoleOutput");
  if (!outputEl) {
    return;
  }
  const line = String(text || "");
  if (!line) {
    return;
  }
  if (outputEl.textContent === "Console ready.") {
    outputEl.textContent = "";
  }
  outputEl.textContent += `${line}\n`;
  outputEl.scrollTop = outputEl.scrollHeight;
}

function setAideRunnerState({ label, running = false, tone = "info" } = {}) {
  const stateEl = document.getElementById("aideRunnerState");
  const spinnerEl = document.getElementById("aideRunnerSpinner");
  const runnerEl = document.getElementById("aideRunner");
  if (stateEl) {
    stateEl.className = badgeClass(tone);
    stateEl.textContent = String(label || "IDLE").toUpperCase();
  }
  if (spinnerEl) {
    spinnerEl.classList.toggle("active", Boolean(running));
  }
  if (runnerEl) {
    runnerEl.classList.toggle("running", Boolean(running));
  }
}

function bindAideCommandConsole({ commandsPayload, reloadPage }) {
  const commands = Array.isArray(commandsPayload?.commands) ? commandsPayload.commands : [];
  if (!commands.length) {
    return;
  }

  const commandMap = new Map(commands.map((command) => [String(command.commandKey), command]));

  const copyOutputBtn = document.getElementById("aideCopyOutputBtn");
  if (copyOutputBtn) {
    copyOutputBtn.addEventListener("click", () => {
      const outputEl = document.getElementById("aideConsoleOutput");
      void copyTextToClipboard(outputEl?.textContent || "", "Output");
    });
  }

  const clearOutputBtn = document.getElementById("aideClearOutputBtn");
  if (clearOutputBtn) {
    clearOutputBtn.addEventListener("click", () => {
      const outputEl = document.getElementById("aideConsoleOutput");
      if (outputEl) {
        outputEl.textContent = "Console ready.";
      }
      setAideRunnerState({ label: "idle", running: false, tone: "info" });
    });
  }

  for (const btn of document.querySelectorAll("[data-aide-copy-command]")) {
    btn.addEventListener("click", () => {
      const key = String(btn.getAttribute("data-aide-copy-command") || "");
      const command = commandMap.get(key);
      void copyTextToClipboard(command?.preview || "", "Command");
    });
  }

  for (const btn of document.querySelectorAll("[data-aide-run]")) {
    btn.addEventListener("click", async () => {
      const key = String(btn.getAttribute("data-aide-run") || "");
      const command = commandMap.get(key);
      if (!command) {
        showOpsToast({ tone: "critical", message: "Unknown command key." });
        return;
      }

      const confirmed = window.confirm(`Run "${command.label}" now?\n\n${command.preview}`);
      if (!confirmed) {
        return;
      }

      setAideRunnerState({ label: "queued", running: true, tone: "warning" });
      appendAideOutput(`$ ${command.preview}`);
      appendAideOutput("[queued] requesting secure command run...");

      let runResponse = null;
      try {
        runResponse = await fetchJson("/api/v1/dashboard/operations/commands/run", {
          method: "POST",
          body: JSON.stringify({
            control: "aide",
            commandKey: command.commandKey,
            confirm: true,
          }),
        });
        showOpsToast({ tone: "secure", message: `${command.label} accepted.` });
      } catch (error) {
        appendAideOutput(`[error] ${error.message || "Command request failed."}`);
        setAideRunnerState({ label: "failed", running: false, tone: "critical" });
        showOpsToast({ tone: "critical", message: error.message || "Command request failed." });
        if (typeof reloadPage === "function") {
          setTimeout(() => {
            void reloadPage();
          }, 900);
        }
        return;
      }

      const runId = String(runResponse?.runId || "");
      if (!runId) {
        appendAideOutput("[error] Missing run id in response.");
        setAideRunnerState({ label: "failed", running: false, tone: "critical" });
        return;
      }

      const streamUrl = `/api/v1/dashboard/operations/commands/run/${encodeURIComponent(runId)}/stream`;
      const stream = new EventSource(streamUrl, { withCredentials: true });

      stream.addEventListener("snapshot", (event) => {
        try {
          const payload = JSON.parse(event.data || "{}");
          const lines = Array.isArray(payload.output) ? payload.output : [];
          if (lines.length) {
            appendAideOutput("[snapshot] replaying recent output...");
          }
          for (const row of lines) {
            appendAideOutput(String(row.line || ""));
          }
          const status = String(payload.run?.status || "running");
          setAideRunnerState({
            label: status,
            running: status !== "success" && status !== "failed",
            tone: status === "failed" ? "critical" : status === "success" ? "secure" : "warning",
          });
        } catch (error) {
          void error;
        }
      });

      stream.addEventListener("line", (event) => {
        try {
          const payload = JSON.parse(event.data || "{}");
          appendAideOutput(String(payload.line || ""));
        } catch (error) {
          void error;
        }
      });

      stream.addEventListener("status", (event) => {
        try {
          const payload = JSON.parse(event.data || "{}");
          if (payload.message) {
            appendAideOutput(`[${payload.status || "status"}] ${payload.message}`);
          }
          setAideRunnerState({
            label: payload.status || "running",
            running: true,
            tone: "warning",
          });
        } catch (error) {
          void error;
        }
      });

      stream.addEventListener("done", (event) => {
        try {
          const payload = JSON.parse(event.data || "{}");
          const status = String(payload.status || "failed");
          appendAideOutput(
            status === "success"
              ? `[done] Command completed in ${fmt(payload.durationMs || 0)}ms.`
              : `[failed] ${fmt(payload.errorMessage || payload.errorCode || "Command failed.")}`
          );
          setAideRunnerState({
            label: status,
            running: false,
            tone: status === "success" ? "secure" : "critical",
          });
          showOpsToast({
            tone: status === "success" ? "secure" : "critical",
            message: status === "success" ? "AIDE command completed." : "AIDE command failed.",
          });
        } catch (error) {
          setAideRunnerState({ label: "failed", running: false, tone: "critical" });
        } finally {
          stream.close();
          if (typeof reloadPage === "function") {
            setTimeout(() => {
              void reloadPage();
            }, 1400);
          }
        }
      });

      stream.onerror = async () => {
        stream.close();
        try {
          const run = await fetchJson(
            `/api/v1/dashboard/operations/commands/run/${encodeURIComponent(runId)}?outputLimit=500`
          );
          const rows = Array.isArray(run.output) ? run.output : [];
          for (const row of rows) {
            appendAideOutput(String(row.line || ""));
          }
          const status = String(run.run?.status || "unknown");
          setAideRunnerState({
            label: status,
            running: status !== "success" && status !== "failed",
            tone: status === "success" ? "secure" : status === "failed" ? "critical" : "warning",
          });
        } catch (error) {
          appendAideOutput(`[error] stream disconnected and polling failed: ${error.message || "unknown error"}`);
          setAideRunnerState({ label: "failed", running: false, tone: "critical" });
        }
      };
    });
  }
}

async function boot() {
  const pageType = String(document.body?.dataset?.dashboardPage || "").trim().toLowerCase();
  if (pageType !== "operations" && !CONTROL_PAGE_CONFIG[pageType]) {
    return;
  }

  mountOperationsSubnav(pageType);

  const session = await ensureSessionAndMountNav();
  if (!session) {
    return;
  }

  const pageConfig = CONTROL_PAGE_CONFIG[pageType];
  if (!pageConfig) {
    const reloadPage = await runPageLoader(loadOperationsPage, {
      windowSelectors: ["opsWindow", "opsSourceFilter", "opsStatusFilter", "opsSeverityFilter"],
    });
    bindOperationsRecheck(reloadPage);
    bindOperationsFilters(reloadPage);
    return;
  }

  const reloadPage = await runPageLoader(() => loadDedicatedControlPage(pageConfig), {
    windowSelectors: ["controlWindow", "controlStatusFilter", "controlSeverityFilter"],
  });
  bindOperationsRecheck(reloadPage);
  bindControlFilters(reloadPage);
  if (pageConfig.key === "rclone") {
    bindRcloneTrigger(reloadPage);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  void boot();
}
