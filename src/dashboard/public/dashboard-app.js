const dashboardState = {
  charts: {
    delivery: null,
    riskQuota: null,
    errors: null,
  },
  filters: {
    status: "",
    category: "",
    severity: "",
    query: "",
  },
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    credentials: "same-origin",
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.message || `Request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return payload;
}

function fmt(value) {
  if (value == null || value === "") {
    return "-";
  }
  return String(value);
}

function fmtNumber(value, digits = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "-";
  }

  return numeric.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function fmtSigned(value, digits = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) {
    return "0";
  }

  const sign = numeric > 0 ? "+" : "";
  return `${sign}${numeric.toFixed(digits)}`;
}

function badgeClass(value) {
  const normalized = String(value || "").toLowerCase();
  if (["critical", "high", "failed", "err", "active-critical"].includes(normalized)) {
    return "badge critical";
  }

  if (["warning", "warn", "retrying", "processing", "queued", "active-warning"].includes(normalized)) {
    return "badge warning";
  }

  return "badge secure";
}

function deltaClass(metric, delta) {
  if (!Number.isFinite(Number(delta)) || Number(delta) === 0) {
    return "delta flat";
  }

  const isIncrease = Number(delta) > 0;

  if (["failed", "risk", "retrying"].includes(metric)) {
    return isIncrease ? "delta up bad" : "delta down good";
  }

  return isIncrease ? "delta up good" : "delta down bad";
}

function formatTime(iso, includeDate = true) {
  if (!iso) {
    return "-";
  }

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return includeDate ? date.toLocaleString() : date.toLocaleTimeString();
}

function formatDurationMinutes(minutes) {
  const numeric = Number(minutes);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return "-";
  }

  if (numeric < 60) {
    return `${Math.round(numeric)}m`;
  }

  const hours = Math.floor(numeric / 60);
  const mins = Math.round(numeric % 60);
  return `${hours}h ${mins}m`;
}

function renderHealthStrip(overview, insights, security) {
  const strip = document.getElementById("healthStrip");
  if (!strip) return;

  const snapshotAge = overview.latestSnapshot?.captured_at
    ? (Date.now() - new Date(overview.latestSnapshot.captured_at).getTime()) / 60000
    : null;

  const items = [
    {
      label: "Relay Health",
      value: overview.relay.ok ? "Healthy" : "Degraded",
      sub: `${overview.relay.host}:${overview.relay.port}`,
      tone: overview.relay.ok ? "secure" : "critical",
    },
    {
      label: "Risk Posture",
      value: `${fmtNumber(insights.risk.score)} / 100`,
      sub: `Level: ${insights.risk.level}`,
      tone: insights.risk.level,
    },
    {
      label: "Quota Burn Projection",
      value: `${fmtNumber(insights.quota.projectedQuotaPct, 1)}%`,
      sub: `${fmtNumber(insights.quota.burnPerHour, 2)}/hour projected`,
      tone: insights.quota.projectedQuotaPct >= 90 ? "warning" : "secure",
    },
    {
      label: "Oldest Queue Age",
      value: formatDurationMinutes(insights.queue.oldestAgeMinutes),
      sub: `Pending ${insights.queue.pending} | Retrying ${insights.queue.retrying}`,
      tone: insights.queue.oldestAgeMinutes >= 30 ? "warning" : "secure",
    },
    {
      label: "Snapshot Freshness",
      value: snapshotAge == null ? "n/a" : `${fmtNumber(snapshotAge, 1)}m`,
      sub: `Metrics freshness ${fmt(security.metrics.freshnessMinutes)}m`,
      tone: snapshotAge != null && snapshotAge > 10 ? "warning" : "secure",
    },
  ];

  strip.innerHTML = items
    .map(
      (item) => `<article class="health-item">
        <div class="health-label">${escapeHtml(item.label)}</div>
        <div class="health-value">${escapeHtml(item.value)}</div>
        <div class="health-sub">
          <span class="${badgeClass(item.tone)}">${escapeHtml(String(item.tone).toUpperCase())}</span>
          ${escapeHtml(item.sub)}
        </div>
      </article>`
    )
    .join("");
}

function renderKpis(overview, insights) {
  const grid = document.getElementById("kpiGrid");
  if (!grid) return;

  const cards = [
    {
      metric: "sent",
      label: "Sent (24h)",
      value: overview.sent24h,
      delta: insights.kpiDeltas.sent,
      sub: `Success rate ${fmtNumber(insights.deliveryFunnel.successRatePct, 1)}%`,
    },
    {
      metric: "failed",
      label: "Failed (24h)",
      value: overview.failed24h,
      delta: insights.kpiDeltas.failed,
      sub: `Failure rate ${fmtNumber(insights.deliveryFunnel.failureRatePct, 1)}%`,
    },
    {
      metric: "retrying",
      label: "Retry Queue",
      value: overview.queue.retrying,
      delta: insights.kpiDeltas.retrying,
      sub: `Pressure ${insights.queue.pressureLevel}`,
    },
    {
      metric: "risk",
      label: "Risk Score",
      value: overview.risk.score,
      delta: insights.kpiDeltas.risk,
      sub: `Quota used ${fmtNumber(insights.quota.usedPct, 1)}%`,
    },
  ];

  grid.innerHTML = cards
    .map(
      (card) => `<article class="kpi-item">
        <div class="kpi-label">${escapeHtml(card.label)}</div>
        <div class="kpi-value">${fmtNumber(card.value)}
          <span class="${deltaClass(card.metric, card.delta)}">${fmtSigned(card.delta)}</span>
        </div>
        <div class="kpi-sub">${escapeHtml(card.sub)}</div>
      </article>`
    )
    .join("");
}

function renderActionPlan(insights) {
  const panel = document.getElementById("actionPlan");
  if (!panel) return;

  panel.innerHTML = `
    <div class="focus-line">
      <span class="${badgeClass(insights.actionPlan.severity)}">${escapeHtml(insights.actionPlan.severity)}</span>
      <div class="title">${escapeHtml(insights.actionPlan.topIssue)}</div>
    </div>
    <div class="body"><strong>Suggested action:</strong> ${escapeHtml(insights.actionPlan.suggestedAction)}</div>
    <div class="body"><strong>Why this matters:</strong> ${escapeHtml(insights.actionPlan.whyThisMatters)}</div>
    <div class="body"><strong>Quota remaining:</strong> ${fmtNumber(insights.quota.remaining)} / ${fmtNumber(
      insights.quota.limit
    )}</div>
  `;
}

function renderSecurity(security, overview) {
  const securityGrid = document.getElementById("securityGrid");
  const diagnostics = document.getElementById("diagnostics");
  if (!securityGrid || !diagnostics) return;

  const items = [
    { label: "Relay", value: security.relay.ok ? "Healthy" : "Down" },
    { label: "Disk Usage", value: security.metrics.diskPct == null ? "-" : `${security.metrics.diskPct}%` },
    { label: "SSH Failures (24h)", value: fmt(security.metrics.sshFails24h) },
    { label: "PM2 Online", value: fmt(security.metrics.pm2Online) },
  ];

  securityGrid.innerHTML = items
    .map(
      (item) => `<div class="mini-item">
        <p>${escapeHtml(item.label)}</p>
        <p class="value">${escapeHtml(item.value)}</p>
      </div>`
    )
    .join("");

  const lines = [
    `Risk source tag: ${fmt(overview.risk.sourceTag)}`,
    `Metrics freshness: ${fmt(
      security.metrics.freshnessMinutes != null ? `${security.metrics.freshnessMinutes} minutes` : null
    )}`,
    `Fail2Ban status: ${security.controls.fail2banAvailable ? "available" : "unavailable"}`,
    `AIDE baseline: ${security.controls.aideBaselinePresent ? "present" : "missing"}`,
    `Daily report path: ${fmt(security.controls.lastDailyReportPath)}`,
  ];

  diagnostics.innerHTML = lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
}

function renderAlerts(alerts) {
  const list = document.getElementById("alertList");
  const summary = document.getElementById("alertSummary");
  if (!list || !summary) return;

  const counts = {
    critical: 0,
    warning: 0,
    info: 0,
  };

  for (const alert of alerts) {
    const severity = String(alert.severity || "info").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(counts, severity)) {
      counts[severity] += 1;
    }
  }

  summary.innerHTML = Object.entries(counts)
    .map(
      ([key, value]) =>
        `<span class="${badgeClass(key)}">${escapeHtml(key)}: ${fmtNumber(value)}</span>`
    )
    .join("");

  if (!alerts.length) {
    list.innerHTML = '<li class="empty-state">No alerts available.</li>';
    return;
  }

  list.innerHTML = alerts
    .slice(0, 20)
    .map((alert) => {
      const tone = `${alert.status}-${alert.severity}`;
      return `<li class="alert-item">
        <div class="top">
          <strong>${escapeHtml(alert.alert_type)}</strong>
          <span class="${badgeClass(tone)}">${escapeHtml(alert.status)} / ${escapeHtml(alert.severity)}</span>
        </div>
        <p>${escapeHtml(fmt(alert.message))}</p>
      </li>`;
    })
    .join("");
}

function upsertCategoryOptions(categoryMix) {
  const select = document.getElementById("logCategoryFilter");
  if (!select) return;

  const existing = new Set(Array.from(select.options).map((opt) => opt.value));
  for (const item of categoryMix || []) {
    if (!item.category || existing.has(item.category)) {
      continue;
    }

    const option = document.createElement("option");
    option.value = item.category;
    option.textContent = item.category;
    select.appendChild(option);
    existing.add(item.category);
  }
}

function truncateId(requestId) {
  const value = String(requestId || "");
  if (value.length <= 16) {
    return value;
  }

  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function renderLogs(logs) {
  const body = document.getElementById("logsTableBody");
  if (!body) return;

  if (!logs.length) {
    body.innerHTML =
      '<tr><td colspan="7" class="empty-state">No logs found for current filters.</td></tr>';
    return;
  }

  body.innerHTML = logs
    .map((row) => {
      const errorText = row.error_message || row.error_code || "-";
      return `<tr>
        <td>${escapeHtml(formatTime(row.created_at))}</td>
        <td>${escapeHtml(fmt(row.to_email))}</td>
        <td class="mono" title="${escapeHtml(fmt(row.request_id))}">${escapeHtml(
        truncateId(row.request_id)
      )}</td>
        <td>${escapeHtml(fmt(row.category))}</td>
        <td><span class="${badgeClass(row.status)}">${escapeHtml(fmt(row.status))}</span></td>
        <td>${escapeHtml(fmt(row.attempt))}</td>
        <td title="${escapeHtml(fmt(errorText))}">${escapeHtml(fmt(errorText))}</td>
      </tr>`;
    })
    .join("");
}

function chartReadyLabel(iso, windowValue) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  if (windowValue === "24h") {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  if (windowValue === "7d") {
    return `${date.getMonth() + 1}/${date.getDate()} ${date
      .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      .replace(/\s/g, "")}`;
  }

  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function destroyChartInstance(key) {
  const chart = dashboardState.charts[key];
  if (chart && typeof chart.destroy === "function") {
    chart.destroy();
  }
  dashboardState.charts[key] = null;
}

function ensureChartJsDefaults() {
  if (typeof window.Chart === "undefined") {
    throw new Error("Chart.js failed to load from local assets.");
  }

  window.Chart.defaults.color = "#b8d0e4";
  window.Chart.defaults.borderColor = "rgba(130, 179, 217, 0.14)";
  window.Chart.defaults.font.family = '"Space Grotesk", "Trebuchet MS", sans-serif';
}

function renderCharts(timeseries, insights, windowValue) {
  ensureChartJsDefaults();

  const labels = (timeseries.points || []).map((point) => chartReadyLabel(point.bucketStart, windowValue));

  destroyChartInstance("delivery");
  const deliveryContext = document.getElementById("deliveryChart")?.getContext("2d");
  if (deliveryContext) {
    dashboardState.charts.delivery = new window.Chart(deliveryContext, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Sent",
            data: timeseries.series?.sent || [],
            borderColor: "#22d4a9",
            backgroundColor: "rgba(34, 212, 169, 0.22)",
            tension: 0.28,
            fill: true,
          },
          {
            label: "Retrying",
            data: timeseries.series?.retrying || [],
            borderColor: "#f4ba53",
            backgroundColor: "rgba(244, 186, 83, 0.15)",
            tension: 0.28,
            fill: true,
          },
          {
            label: "Failed",
            data: timeseries.series?.failed || [],
            borderColor: "#ff6c73",
            backgroundColor: "rgba(255, 108, 115, 0.15)",
            tension: 0.28,
            fill: true,
          },
        ],
      },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { position: "top" },
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: { precision: 0 },
          },
        },
      },
    });
  }

  destroyChartInstance("riskQuota");
  const riskQuotaContext = document.getElementById("riskQuotaChart")?.getContext("2d");
  if (riskQuotaContext) {
    dashboardState.charts.riskQuota = new window.Chart(riskQuotaContext, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Risk Score",
            data: timeseries.series?.riskScore || [],
            borderColor: "#ff6c73",
            backgroundColor: "rgba(255, 108, 115, 0.14)",
            tension: 0.24,
            yAxisID: "yRisk",
          },
          {
            label: "Quota Used %",
            data: timeseries.series?.quotaPct || [],
            borderColor: "#62c5ff",
            backgroundColor: "rgba(98, 197, 255, 0.15)",
            tension: 0.24,
            yAxisID: "yQuota",
          },
        ],
      },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { position: "top" },
        },
        scales: {
          yRisk: {
            position: "left",
            min: 0,
            max: 100,
            ticks: { callback: (value) => `${value}` },
          },
          yQuota: {
            position: "right",
            min: 0,
            max: 100,
            grid: { drawOnChartArea: false },
            ticks: { callback: (value) => `${value}%` },
          },
        },
      },
    });
  }

  destroyChartInstance("errors");
  const errorContext = document.getElementById("errorChart")?.getContext("2d");
  if (errorContext) {
    const labels = (insights.topErrors || []).map((item) => item.code);
    const values = (insights.topErrors || []).map((item) => item.count);
    const hasData = values.some((value) => Number(value) > 0);

    dashboardState.charts.errors = new window.Chart(errorContext, {
      type: "doughnut",
      data: {
        labels: hasData ? labels : ["No errors"],
        datasets: [
          {
            data: hasData ? values : [1],
            backgroundColor: hasData
              ? ["#ff6c73", "#f4ba53", "#62c5ff", "#889ef8", "#22d4a9", "#ab6cff"]
              : ["rgba(120, 154, 182, 0.45)"],
            borderColor: "rgba(6, 24, 42, 0.35)",
            borderWidth: 1,
          },
        ],
      },
      options: {
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: "bottom",
            labels: {
              boxWidth: 12,
            },
          },
        },
      },
    });
  }
}

function collectFilters() {
  dashboardState.filters.status = String(document.getElementById("logStatusFilter")?.value || "").trim();
  dashboardState.filters.category = String(document.getElementById("logCategoryFilter")?.value || "").trim();
  dashboardState.filters.severity = String(document.getElementById("logSeverityFilter")?.value || "").trim();
  dashboardState.filters.query = String(document.getElementById("logSearch")?.value || "").trim();
}

function buildLogsQuery() {
  const params = new URLSearchParams();
  params.set("limit", "100");

  if (dashboardState.filters.status) params.set("status", dashboardState.filters.status);
  if (dashboardState.filters.category) params.set("category", dashboardState.filters.category);
  if (dashboardState.filters.severity) params.set("severity", dashboardState.filters.severity);
  if (dashboardState.filters.query) params.set("q", dashboardState.filters.query);

  return params.toString();
}

async function loadDashboard(windowValue) {
  const [overview, insights, timeseries, logsData, alertsData, security] = await Promise.all([
    fetchJson("/api/v1/dashboard/overview"),
    fetchJson(`/api/v1/dashboard/insights?window=${encodeURIComponent(windowValue)}`),
    fetchJson(`/api/v1/dashboard/timeseries?window=${encodeURIComponent(windowValue)}`),
    fetchJson(`/api/v1/dashboard/logs?${buildLogsQuery()}`),
    fetchJson("/api/v1/dashboard/alerts"),
    fetchJson("/api/v1/dashboard/security"),
  ]);

  const subline = document.getElementById("dashboardSubline");
  if (subline) {
    subline.textContent = `Last refresh ${formatTime(new Date().toISOString())} | Window ${windowValue} | Relay ${
      overview.relay.ok ? "healthy" : "degraded"
    }`;
  }

  renderHealthStrip(overview, insights, security);
  renderKpis(overview, insights);
  renderActionPlan(insights);
  renderSecurity(security, overview);
  renderAlerts(alertsData.alerts || []);
  upsertCategoryOptions(insights.categoryMix || []);
  renderLogs(logsData.logs || []);
  renderCharts(timeseries, insights, windowValue);
}

async function handleLoginPage() {
  const form = document.getElementById("loginForm");
  if (!form) return;

  try {
    const session = await fetchJson("/auth/session");
    if (session.authenticated) {
      window.location.href = "/dashboard";
      return;
    }
  } catch (error) {
    // user remains on login page
  }

  const errorEl = document.getElementById("errorMessage");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (errorEl) {
      errorEl.textContent = "";
    }

    const formData = new FormData(form);
    const username = String(formData.get("username") || "").trim();
    const password = String(formData.get("password") || "");

    try {
      await fetchJson("/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      window.location.href = "/dashboard";
    } catch (error) {
      if (errorEl) {
        errorEl.textContent = error.message;
      }
    }
  });
}

async function handleDashboardPage() {
  const refreshBtn = document.getElementById("refreshBtn");
  if (!refreshBtn) return;

  const windowSelect = document.getElementById("trendWindow");
  const logoutBtn = document.getElementById("logoutBtn");
  const logApplyBtn = document.getElementById("logApplyBtn");
  const logSearch = document.getElementById("logSearch");

  try {
    const session = await fetchJson("/auth/session");
    if (!session.authenticated) {
      window.location.href = "/login";
      return;
    }
  } catch (error) {
    window.location.href = "/login";
    return;
  }

  const refresh = async () => {
    try {
      refreshBtn.disabled = true;
      collectFilters();
      await loadDashboard(windowSelect.value);
    } catch (error) {
      const subline = document.getElementById("dashboardSubline");
      if (subline) {
        subline.textContent = `Dashboard load failed: ${error.message}`;
      }
    } finally {
      refreshBtn.disabled = false;
    }
  };

  refreshBtn.addEventListener("click", refresh);
  windowSelect.addEventListener("change", refresh);

  if (logApplyBtn) {
    logApplyBtn.addEventListener("click", refresh);
  }

  if (logSearch) {
    logSearch.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        refresh();
      }
    });
  }

  logoutBtn.addEventListener("click", async () => {
    try {
      await fetchJson("/auth/logout", { method: "POST" });
    } catch (error) {
      // best-effort logout
    }

    window.location.href = "/login";
  });

  await refresh();
}

(function boot() {
  if (document.getElementById("loginForm")) {
    handleLoginPage();
    return;
  }

  if (document.getElementById("deliveryChart")) {
    handleDashboardPage();
  }
})();
