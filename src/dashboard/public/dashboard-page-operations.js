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
    .map((cmd) => `<code class="mono">${escapeHtml(String(cmd))}</code>`)
    .join("")}</div>`;
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

  const [operations, eventsPayload] = await Promise.all([
    fetchJson(`/api/v1/dashboard/operations?window=${encodeURIComponent(windowValue)}`),
    fetchJson(`/api/v1/dashboard/ops-events?${eventQuery.toString()}`),
  ]);

  const events = Array.isArray(eventsPayload.events) ? eventsPayload.events : [];
  const controls = operations.controls || {};
  const postfix = controls.postfix || {};
  const cron = controls.cron || {};
  const fail2ban = controls.fail2ban || {};
  const aide = controls.aide || {};
  const logwatch = controls.logwatch || {};
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
    ].join("");
  }

  const controlsMount = document.getElementById("operationsControls");
  if (controlsMount) {
    controlsMount.innerHTML = [
      renderPanel({
        title: "Control Health Matrix",
        meta: "AIDE, Fail2Ban, relay, postfix, cron, and logwatch state in one view.",
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
        : "Live + timeline diagnostics across cron, postfix, relay, fail2ban, aide, and logwatch.",
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
    ];

    hintsMount.innerHTML = renderPanel({
      title: "Fix Hints",
      meta: "Safe command-level checks to validate and remediate active operations issues.",
      bodyHtml: renderOpsFixHints({ hints }),
    });
  }
}

async function loadDedicatedControlPage(pageConfig) {
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

  const [snapshot, eventsPayload] = await Promise.all([
    fetchJson(`/api/v1/dashboard/operations/control/${encodeURIComponent(pageConfig.key)}?window=${encodeURIComponent(windowValue)}`),
    fetchJson(`/api/v1/dashboard/ops-events?${eventQuery.toString()}`),
  ]);

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
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  void boot();
}
