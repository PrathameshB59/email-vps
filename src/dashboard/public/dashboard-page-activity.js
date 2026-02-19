import {
  badgeClass,
  escapeHtml,
  fetchJson,
  fmt,
  fmtNumber,
  formatTime,
  formatUptimeSeconds,
  renderPanel,
  renderSimpleTable,
  renderSummaryCard,
  renderKeyValueList,
  setSubline,
  ensureSessionAndMountNav,
} from "./dashboard-pages-runtime.js";

const activityState = {
  timer: null,
  enabled: true,
  refreshSeconds: 5,
};

function stopAutoRefresh() {
  if (activityState.timer) {
    clearInterval(activityState.timer);
    activityState.timer = null;
  }
}

function setToggleLabel() {
  const toggleBtn = document.getElementById("toggleAutoRefreshBtn");
  if (!toggleBtn) {
    return;
  }

  toggleBtn.dataset.active = activityState.enabled ? "true" : "false";
  toggleBtn.textContent = activityState.enabled ? "Pause Auto" : "Resume Auto";
}

function scheduleAutoRefresh(run) {
  stopAutoRefresh();
  if (!activityState.enabled) {
    return;
  }

  const refreshSeconds = Math.max(2, Number(activityState.refreshSeconds || 5));
  activityState.timer = setInterval(run, refreshSeconds * 1000);
}

function formatLoadAverage(values) {
  if (!Array.isArray(values) || !values.length) {
    return "-";
  }

  return values
    .map((value) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric.toFixed(2) : "-";
    })
    .join(" / ");
}

function formatCommand(row) {
  const command = String(row?.command || "");
  const args = String(row?.args || "").trim();
  if (!args || args === command) {
    return escapeHtml(command || "-");
  }
  return escapeHtml(`${command} ${args}`);
}

function renderActivityTable(rows, emptyMessage) {
  const safeRows = Array.isArray(rows) ? rows : [];
  return renderSimpleTable({
    columns: [
      { key: "pid", label: "PID", render: (row) => escapeHtml(fmt(row.pid)) },
      { key: "user", label: "User", render: (row) => escapeHtml(fmt(row.user)) },
      { key: "cpu", label: "CPU%", render: (row) => escapeHtml(fmtNumber(row.cpuPct, 1)) },
      { key: "mem", label: "MEM%", render: (row) => escapeHtml(fmtNumber(row.memPct, 1)) },
      {
        key: "state",
        label: "State",
        render: (row) => `<span class="${badgeClass(row.state)}">${escapeHtml(fmt(row.state))}</span>`,
      },
      { key: "threads", label: "Threads", render: (row) => escapeHtml(fmt(row.threads)) },
      { key: "elapsed", label: "Elapsed", render: (row) => escapeHtml(formatUptimeSeconds(row.elapsedSec)) },
      {
        key: "command",
        label: "Command",
        render: (row) => `<span class="mono process-command" title="${formatCommand(row)}">${formatCommand(
          row
        )}</span>`,
      },
    ],
    rows: safeRows,
    emptyMessage,
  });
}

async function loadActivityPage() {
  const snapshot = await fetchJson("/api/v1/dashboard/activity");

  const limits = snapshot.limits || {};
  activityState.refreshSeconds = Math.max(2, Number(limits.refreshSeconds || activityState.refreshSeconds || 5));

  setSubline(
    `Last refresh ${formatTime(snapshot.timestamp)} | Auto ${activityState.refreshSeconds}s | Health ${fmt(
      snapshot.health
    )}`
  );

  const summaryMount = document.getElementById("activitySummary");
  if (summaryMount) {
    summaryMount.innerHTML = [
      renderSummaryCard({
        label: "CPU Usage",
        value: snapshot.cpuPct == null ? "n/a" : `${fmtNumber(snapshot.cpuPct, 1)}%`,
        sub: `Load ${formatLoadAverage(snapshot.loadAverage)}`,
        tone: Number(snapshot.cpuPct || 0) >= 80 ? "warning" : "secure",
      }),
      renderSummaryCard({
        label: "Memory Used",
        value: snapshot.memoryUsedPct == null ? "n/a" : `${fmtNumber(snapshot.memoryUsedPct, 1)}%`,
        sub: `${fmtNumber(Number(snapshot.memoryUsedBytes || 0) / 1024 ** 3, 2)} GiB used`,
        tone: Number(snapshot.memoryUsedPct || 0) >= 85 ? "warning" : "secure",
      }),
      renderSummaryCard({
        label: "Tasks",
        value: `${fmt(snapshot.tasks?.running || 0)} / ${fmt(snapshot.tasks?.total || 0)}`,
        sub: "Running / total",
        tone: Number(snapshot.tasks?.zombie || 0) > 0 ? "warning" : "secure",
      }),
      renderSummaryCard({
        label: "Uptime",
        value: formatUptimeSeconds(snapshot.uptimeSec),
        sub: `Zombies ${fmt(snapshot.tasks?.zombie || 0)}`,
        tone: snapshot.health,
      }),
    ].join("");
  }

  const hostMount = document.getElementById("activityHost");
  if (hostMount) {
    const errors = Array.isArray(snapshot.diagnostics?.errors) ? snapshot.diagnostics.errors : [];
    hostMount.innerHTML = [
      renderPanel({
        title: "Host Activity Summary",
        meta: "htop-like aggregate view from host and metrics sources.",
        bodyHtml: renderKeyValueList([
          { label: "Load average", value: formatLoadAverage(snapshot.loadAverage) },
          { label: "CPU percent", value: snapshot.cpuPct == null ? "n/a" : `${fmtNumber(snapshot.cpuPct, 1)}%` },
          {
            label: "Memory used percent",
            value: snapshot.memoryUsedPct == null ? "n/a" : `${fmtNumber(snapshot.memoryUsedPct, 1)}%`,
          },
          { label: "Memory used", value: `${fmtNumber(Number(snapshot.memoryUsedBytes || 0) / 1024 ** 3, 2)} GiB` },
          { label: "Memory total", value: `${fmtNumber(Number(snapshot.memoryTotalBytes || 0) / 1024 ** 3, 2)} GiB` },
          { label: "Uptime", value: formatUptimeSeconds(snapshot.uptimeSec) },
          { label: "Snapshot timestamp", value: formatTime(snapshot.timestamp) },
        ]),
      }),
      renderPanel({
        title: "Task State Breakdown",
        meta: "Task scheduler states comparable to htop counters.",
        bodyHtml:
          renderKeyValueList([
            { label: "Total", value: snapshot.tasks?.total || 0 },
            { label: "Running", value: snapshot.tasks?.running || 0 },
            { label: "Sleeping", value: snapshot.tasks?.sleeping || 0 },
            { label: "Stopped", value: snapshot.tasks?.stopped || 0 },
            { label: "Zombie", value: snapshot.tasks?.zombie || 0 },
            { label: "Collection health", value: snapshot.health || "unknown" },
          ]) +
          `<div class="diagnostics">${
            errors.length
              ? errors.map((value) => `<p>${escapeHtml(String(value))}</p>`).join("")
              : "<p>No diagnostics errors.</p>"
          }</div>`,
      }),
    ].join("");
  }

  const processMount = document.getElementById("activityProcesses");
  if (processMount) {
    processMount.innerHTML = [
      renderPanel({
        title: `Top CPU Processes (Top ${fmt(limits.topN || snapshot.topCpu?.length || 0)})`,
        meta: "Live process ranking sorted by CPU utilization.",
        bodyHtml: renderActivityTable(snapshot.topCpu, "No CPU process rows available."),
      }),
      renderPanel({
        title: `Top Memory Processes (Top ${fmt(limits.topN || snapshot.topMemory?.length || 0)})`,
        meta: "Live process ranking sorted by memory utilization.",
        bodyHtml: renderActivityTable(snapshot.topMemory, "No memory process rows available."),
      }),
    ].join("");
  }
}

async function runActivityPageLoader() {
  const refreshBtn = document.getElementById("refreshBtn");
  const toggleBtn = document.getElementById("toggleAutoRefreshBtn");
  let inFlight = false;

  const run = async () => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    if (refreshBtn) refreshBtn.disabled = true;
    try {
      await loadActivityPage();
    } catch (error) {
      setSubline(`Activity load failed: ${error.message}`);
    } finally {
      if (refreshBtn) refreshBtn.disabled = false;
      inFlight = false;
    }
  };

  if (refreshBtn) {
    refreshBtn.addEventListener("click", run);
  }

  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      activityState.enabled = !activityState.enabled;
      if (activityState.enabled) {
        scheduleAutoRefresh(run);
      } else {
        stopAutoRefresh();
      }
      setToggleLabel();
    });
  }

  window.addEventListener("beforeunload", stopAutoRefresh, { once: true });

  await run();
  scheduleAutoRefresh(run);
  setToggleLabel();
}

async function boot() {
  const pageType = String(document.body?.dataset?.dashboardPage || "").trim().toLowerCase();
  if (pageType !== "activity") {
    return;
  }

  const session = await ensureSessionAndMountNav();
  if (!session) {
    return;
  }

  await runActivityPageLoader();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  void boot();
}
