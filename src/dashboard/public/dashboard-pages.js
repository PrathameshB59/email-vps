(function dashboardPagesBoot() {
  const pageState = {
    charts: {
      performanceDelivery: null,
      performanceRisk: null,
    },
    activity: {
      timer: null,
      enabled: true,
      refreshSeconds: 5,
      setRefreshSeconds: null,
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
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function formatTime(iso) {
    if (!iso) return "-";
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) return "-";
    return parsed.toLocaleString();
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

  function formatUptimeSeconds(totalSeconds) {
    const value = Number(totalSeconds);
    if (!Number.isFinite(value) || value < 0) {
      return "-";
    }

    const days = Math.floor(value / 86400);
    const hours = Math.floor((value % 86400) / 3600);
    const mins = Math.floor((value % 3600) / 60);

    const chunks = [];
    if (days > 0) chunks.push(`${days}d`);
    if (hours > 0 || days > 0) chunks.push(`${hours}h`);
    chunks.push(`${mins}m`);
    return chunks.join(" ");
  }

  function badgeClass(value) {
    const normalized = String(value || "").toLowerCase();
    if (["critical", "failed", "error", "high"].includes(normalized)) return "badge critical";
    if (
      ["warning", "warn", "retrying", "queued", "degraded", "unknown", "active-warning"].includes(
        normalized
      )
    ) {
      return "badge warning";
    }
    return "badge secure";
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
      error.payload = payload;
      throw error;
    }

    return payload;
  }

  function setSubline(message) {
    const el = document.getElementById("pageSubline");
    if (el) {
      el.textContent = message;
    }
  }

  function renderSummaryCard({ label, value, sub, tone = "secure" }) {
    return `<article class="summary-item">
      <div class="summary-label">${escapeHtml(label)}</div>
      <div class="summary-value">${escapeHtml(value)}</div>
      <div class="summary-sub">
        <span class="${badgeClass(tone)}">${escapeHtml(String(tone).toUpperCase())}</span>
        ${escapeHtml(sub || "")}
      </div>
    </article>`;
  }

  function renderPanel({ title, meta, bodyHtml }) {
    return `<article class="panel">
      <div class="panel-head">
        <div>
          <h2>${escapeHtml(title)}</h2>
          <p class="meta">${escapeHtml(meta || "")}</p>
        </div>
      </div>
      <div class="panel-body">
        ${bodyHtml}
      </div>
    </article>`;
  }

  function bindLogout() {
    const logoutBtn = document.getElementById("logoutBtn");
    if (!logoutBtn) {
      return;
    }

    logoutBtn.addEventListener("click", async () => {
      try {
        await fetchJson("/auth/logout", { method: "POST" });
      } catch (error) {
        // best-effort logout
      }
      window.location.href = "/login";
    });
  }

  async function ensureSession() {
    let session = null;
    try {
      session = await fetchJson("/auth/session");
    } catch (error) {
      window.location.href = "/login";
      return null;
    }

    if (!session.authenticated) {
      window.location.href = "/login";
      return null;
    }

    return session;
  }

  function renderKeyValueList(items) {
    const rows = items
      .map(
        (item) =>
          `<div class="kv-row"><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(fmt(item.value))}</strong></div>`
      )
      .join("");
    return `<div class="kv-list">${rows}</div>`;
  }

  function renderSimpleTable({ columns, rows, emptyMessage = "No rows available." }) {
    if (!rows.length) {
      return `<div class="empty-state">${escapeHtml(emptyMessage)}</div>`;
    }

    const header = columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("");
    const body = rows
      .map((row) => {
        const cells = columns
          .map((column) => {
            const value = typeof column.render === "function" ? column.render(row) : row[column.key];
            return `<td>${value}</td>`;
          })
          .join("");
        return `<tr>${cells}</tr>`;
      })
      .join("");

    return `<div class="table-wrap page-table-wrap">
      <table>
        <thead><tr>${header}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
  }

  function destroyPerformanceCharts() {
    const keys = ["performanceDelivery", "performanceRisk"];
    for (const key of keys) {
      const instance = pageState.charts[key];
      if (instance && typeof instance.destroy === "function") {
        instance.destroy();
      }
      pageState.charts[key] = null;
    }
  }

  function renderPerformanceCharts(timeseries, windowValue) {
    if (typeof window.Chart === "undefined") {
      return;
    }

    destroyPerformanceCharts();

    const labels = (timeseries.points || []).map((point) => {
      const date = new Date(point.bucketStart);
      if (Number.isNaN(date.getTime())) return "";
      if (windowValue === "24h") {
        return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      }
      return `${date.getMonth() + 1}/${date.getDate()} ${date
        .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        .replace(/\s/g, "")}`;
    });

    const compact = Number(window.innerWidth || 1280) <= 820;
    const maxTicksLimit = compact ? 6 : 12;

    const deliveryCtx = document.getElementById("performanceDeliveryChart")?.getContext("2d");
    if (deliveryCtx) {
      pageState.charts.performanceDelivery = new window.Chart(deliveryCtx, {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: "Sent",
              data: timeseries.series?.sent || [],
              borderColor: "#22d4a9",
              backgroundColor: "rgba(34,212,169,0.16)",
              borderWidth: 2,
              pointRadius: compact ? 0 : 2,
              tension: 0.24,
              fill: true,
            },
            {
              label: "Retrying",
              data: timeseries.series?.retrying || [],
              borderColor: "#f4ba53",
              backgroundColor: "rgba(244,186,83,0.15)",
              borderWidth: 2,
              pointRadius: compact ? 0 : 2,
              tension: 0.24,
              fill: true,
            },
            {
              label: "Failed",
              data: timeseries.series?.failed || [],
              borderColor: "#ff6c73",
              backgroundColor: "rgba(255,108,115,0.14)",
              borderWidth: 2,
              pointRadius: compact ? 0 : 2,
              tension: 0.24,
              fill: true,
            },
          ],
        },
        options: {
          maintainAspectRatio: false,
          plugins: {
            legend: { position: compact ? "bottom" : "top" },
          },
          scales: {
            x: {
              ticks: { autoSkip: true, maxTicksLimit, maxRotation: 0, minRotation: 0 },
            },
            y: {
              beginAtZero: true,
              ticks: { precision: 0 },
            },
          },
        },
      });
    }

    const riskCtx = document.getElementById("performanceRiskChart")?.getContext("2d");
    if (riskCtx) {
      pageState.charts.performanceRisk = new window.Chart(riskCtx, {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: "Risk Score",
              data: timeseries.series?.riskScore || [],
              borderColor: "#ff6c73",
              backgroundColor: "rgba(255,108,115,0.16)",
              borderWidth: 2,
              pointRadius: compact ? 0 : 2,
              tension: 0.24,
              yAxisID: "risk",
            },
            {
              label: "Quota Used %",
              data: timeseries.series?.quotaPct || [],
              borderColor: "#62c5ff",
              backgroundColor: "rgba(98,197,255,0.16)",
              borderWidth: 2,
              pointRadius: compact ? 0 : 2,
              tension: 0.24,
              yAxisID: "quota",
            },
          ],
        },
        options: {
          maintainAspectRatio: false,
          plugins: {
            legend: { position: compact ? "bottom" : "top" },
          },
          scales: {
            x: {
              ticks: { autoSkip: true, maxTicksLimit, maxRotation: 0, minRotation: 0 },
            },
            risk: {
              type: "linear",
              position: "left",
              min: 0,
              max: 100,
            },
            quota: {
              type: "linear",
              position: "right",
              min: 0,
              max: 100,
              grid: { drawOnChartArea: false },
            },
          },
        },
      });
    }
  }

  async function loadSecurityPage() {
    const [security, alertsPayload] = await Promise.all([
      fetchJson("/api/v1/dashboard/security"),
      fetchJson("/api/v1/dashboard/alerts"),
    ]);

    setSubline(
      `Last refresh ${formatTime(new Date().toISOString())} | Risk ${security.risk.level} | Relay ${
        security.relay.ok ? "healthy" : "degraded"
      }`
    );

    const summaryMount = document.getElementById("securitySummary");
    if (summaryMount) {
      summaryMount.innerHTML = [
        renderSummaryCard({
          label: "Risk Score",
          value: `${fmtNumber(security.risk.score)} / 100`,
          sub: `Source ${fmt(security.risk.sourceTag)}`,
          tone: security.risk.level,
        }),
        renderSummaryCard({
          label: "Relay",
          value: security.relay.ok ? "Healthy" : "Degraded",
          sub: `${security.relay.host}:${security.relay.port}`,
          tone: security.relay.ok ? "secure" : "critical",
        }),
        renderSummaryCard({
          label: "Fail2Ban",
          value: security.controls.fail2banAvailable ? "Available" : "Unavailable",
          sub: "Host control visibility",
          tone: security.controls.fail2banAvailable ? "secure" : "warning",
        }),
        renderSummaryCard({
          label: "AIDE Baseline",
          value: security.controls.aideBaselinePresent ? "Present" : "Missing",
          sub: fmt(security.controls.lastDailyReportPath),
          tone: security.controls.aideBaselinePresent ? "secure" : "warning",
        }),
      ].join("");
    }

    const controlsMount = document.getElementById("securityControls");
    if (controlsMount) {
      controlsMount.innerHTML = [
        renderPanel({
          title: "Control Signals",
          meta: "Current hardening and telemetry control states.",
          bodyHtml: renderKeyValueList([
            { label: "Metrics freshness", value: `${fmt(security.metrics.freshnessMinutes)} minutes` },
            { label: "Disk usage", value: `${fmt(security.metrics.diskPct)}%` },
            { label: "SSH failures (24h)", value: security.metrics.sshFails24h },
            { label: "PM2 online", value: security.metrics.pm2Online },
            { label: "Metrics file", value: security.metrics.metricsPath },
          ]),
        }),
        renderPanel({
          title: "Relay Diagnostics",
          meta: "SMTP relay verification and error visibility.",
          bodyHtml: renderKeyValueList([
            { label: "Relay status", value: security.relay.ok ? "healthy" : "degraded" },
            { label: "Relay host", value: security.relay.host },
            { label: "Relay port", value: security.relay.port },
            { label: "Error code", value: security.relay.errorCode || "-" },
            { label: "Error message", value: security.relay.errorMessage || "-" },
          ]),
        }),
      ].join("");
    }

    const alertsMount = document.getElementById("securityAlerts");
    if (alertsMount) {
      const alerts = alertsPayload.alerts || [];
      const alertRows = alerts
        .slice(0, 25)
        .map((alert) => ({
          type: alert.alert_type,
          status: `<span class="${badgeClass(`${alert.status}-${alert.severity}`)}">${escapeHtml(
            `${alert.status} / ${alert.severity}`
          )}</span>`,
          value: escapeHtml(fmt(alert.value)),
          message: escapeHtml(fmt(alert.message)),
          seen: escapeHtml(formatTime(alert.last_seen_at)),
        }));

      alertsMount.innerHTML = renderPanel({
        title: "Alert State Matrix",
        meta: "Latest persisted system alerts for security and stability controls.",
        bodyHtml: renderSimpleTable({
          columns: [
            { key: "type", label: "Type", render: (row) => row.type },
            { key: "status", label: "Status", render: (row) => row.status },
            { key: "value", label: "Value", render: (row) => row.value },
            { key: "message", label: "Message", render: (row) => row.message },
            { key: "seen", label: "Last Seen", render: (row) => row.seen },
          ],
          rows: alertRows,
          emptyMessage: "No alerts present.",
        }),
      });
    }
  }

  async function loadHealthPage() {
    const [overview, security, mailCheck] = await Promise.all([
      fetchJson("/api/v1/dashboard/overview"),
      fetchJson("/api/v1/dashboard/security"),
      fetchJson("/api/v1/dashboard/mail-check"),
    ]);

    setSubline(
      `Last refresh ${formatTime(new Date().toISOString())} | Relay ${
        mailCheck.relay.ok ? "healthy" : "degraded"
      } | Queue pending ${fmt(overview.queue.pending)}`
    );

    const summaryMount = document.getElementById("healthSummary");
    if (summaryMount) {
      summaryMount.innerHTML = [
        renderSummaryCard({
          label: "Sent (24h)",
          value: fmtNumber(overview.sent24h),
          sub: "Recent successful deliveries",
          tone: "secure",
        }),
        renderSummaryCard({
          label: "Failed (24h)",
          value: fmtNumber(overview.failed24h),
          sub: `Failure rate ${fmtNumber(mailCheck.delivery24h.failureRatePct, 1)}%`,
          tone: mailCheck.delivery24h.failed > 0 ? "warning" : "secure",
        }),
        renderSummaryCard({
          label: "Quota Remaining",
          value: fmtNumber(overview.quota.remaining),
          sub: `${fmtNumber(overview.quota.used)} / ${fmtNumber(overview.quota.limit)} used`,
          tone: overview.quota.remaining < 100 ? "warning" : "secure",
        }),
        renderSummaryCard({
          label: "Queue Oldest Age",
          value: formatDurationMinutes(overview.queueAging.oldestOpenAgeMinutes),
          sub: `Pending ${fmt(overview.queue.pending)} | Retrying ${fmt(overview.queue.retrying)}`,
          tone: Number(overview.queueAging.oldestOpenAgeMinutes || 0) >= 30 ? "warning" : "secure",
        }),
      ].join("");
    }

    const signalsMount = document.getElementById("healthSignals");
    if (signalsMount) {
      signalsMount.innerHTML = [
        renderPanel({
          title: "Host Runtime Signals",
          meta: "System and process telemetry from latest capture.",
          bodyHtml: renderKeyValueList([
            { label: "CPU", value: overview.metrics.cpu },
            { label: "Memory used", value: overview.metrics.memoryUsed },
            { label: "Memory total", value: overview.metrics.memoryTotal },
            { label: "Disk", value: overview.metrics.disk },
            { label: "Load", value: overview.metrics.load },
            { label: "Top SSH IP", value: overview.metrics.topIp },
          ]),
        }),
        renderPanel({
          title: "Mail Runtime Signals",
          meta: "Live relay, queue, and quota health.",
          bodyHtml: renderKeyValueList([
            { label: "Relay", value: mailCheck.relay.ok ? "healthy" : "degraded" },
            { label: "Relay host", value: `${mailCheck.relay.host}:${mailCheck.relay.port}` },
            { label: "Queue pending", value: mailCheck.queue.pending },
            { label: "Queue retrying", value: mailCheck.queue.retrying },
            { label: "Queue failed", value: mailCheck.queue.failed },
            { label: "Last successful delivery", value: formatTime(mailCheck.lastSuccessfulDeliveryAt) },
          ]),
        }),
      ].join("");
    }

    const timelineMount = document.getElementById("healthTimeline");
    if (timelineMount) {
      const rows = (mailCheck.recentProblems || []).map((event) => ({
        createdAt: escapeHtml(formatTime(event.createdAt)),
        requestId: escapeHtml(fmt(event.requestId)),
        status: `<span class="${badgeClass(event.status)}">${escapeHtml(fmt(event.status))}</span>`,
        error: escapeHtml(fmt(event.errorMessage || event.errorCode)),
      }));

      timelineMount.innerHTML = renderPanel({
        title: "Recent Health Exceptions",
        meta: "Latest retry/failed events requiring operator attention.",
        bodyHtml: renderSimpleTable({
          columns: [
            { key: "createdAt", label: "Time", render: (row) => row.createdAt },
            { key: "requestId", label: "Request ID", render: (row) => row.requestId },
            { key: "status", label: "Status", render: (row) => row.status },
            { key: "error", label: "Error", render: (row) => row.error },
          ],
          rows,
          emptyMessage: "No exceptions in recent event stream.",
        }),
      });
    }
  }

  async function loadPerformancePage() {
    const windowSelect = document.getElementById("trendWindow");
    const windowValue = String(windowSelect?.value || "24h");
    const [timeseries, insights, overview] = await Promise.all([
      fetchJson(`/api/v1/dashboard/timeseries?window=${encodeURIComponent(windowValue)}`),
      fetchJson(`/api/v1/dashboard/insights?window=${encodeURIComponent(windowValue)}`),
      fetchJson("/api/v1/dashboard/overview"),
    ]);

    setSubline(
      `Last refresh ${formatTime(new Date().toISOString())} | Window ${windowValue} | Queue pressure ${
        insights.queue.pressureLevel
      }`
    );

    const summaryMount = document.getElementById("performanceSummary");
    if (summaryMount) {
      summaryMount.innerHTML = [
        renderSummaryCard({
          label: "Success Rate",
          value: `${fmtNumber(insights.deliveryFunnel.successRatePct, 1)}%`,
          sub: `${fmtNumber(insights.deliveryFunnel.sentRequests)} sent of ${fmtNumber(
            insights.deliveryFunnel.totalRequests
          )}`,
          tone: insights.deliveryFunnel.successRatePct >= 95 ? "secure" : "warning",
        }),
        renderSummaryCard({
          label: "Failure Rate",
          value: `${fmtNumber(insights.deliveryFunnel.failureRatePct, 1)}%`,
          sub: `${fmtNumber(insights.deliveryFunnel.failedRequests)} failed`,
          tone: insights.deliveryFunnel.failureRatePct > 5 ? "warning" : "secure",
        }),
        renderSummaryCard({
          label: "Quota Burn / Hour",
          value: fmtNumber(insights.quota.burnPerHour, 2),
          sub: `Projected ${fmtNumber(insights.quota.projectedQuotaPct, 1)}%`,
          tone: insights.quota.projectedQuotaPct > 85 ? "warning" : "secure",
        }),
        renderSummaryCard({
          label: "Risk Score",
          value: `${fmtNumber(insights.risk.score)} / 100`,
          sub: `Current level ${insights.risk.level}`,
          tone: insights.risk.level,
        }),
      ].join("");
    }

    renderPerformanceCharts(timeseries, windowValue);

    const tableMount = document.getElementById("performanceTable");
    if (tableMount) {
      const rows = (timeseries.points || [])
        .slice(-24)
        .map((point) => ({
          bucket: escapeHtml(formatTime(point.bucketStart)),
          sent: escapeHtml(fmt(point.sent)),
          failed: escapeHtml(fmt(point.failed)),
          retrying: escapeHtml(fmt(point.retrying)),
          risk: escapeHtml(fmt(point.riskScore)),
          quota: escapeHtml(point.quotaPct == null ? "-" : `${point.quotaPct}%`),
          relay: `<span class="${badgeClass(point.relayOk ? "secure" : "warning")}">${escapeHtml(
            point.relayOk == null ? "unknown" : point.relayOk ? "ok" : "down"
          )}</span>`,
        }));

      tableMount.innerHTML = renderPanel({
        title: "Recent Performance Buckets",
        meta: "Most recent time buckets for throughput and risk signals.",
        bodyHtml: renderSimpleTable({
          columns: [
            { key: "bucket", label: "Bucket", render: (row) => row.bucket },
            { key: "sent", label: "Sent", render: (row) => row.sent },
            { key: "failed", label: "Failed", render: (row) => row.failed },
            { key: "retrying", label: "Retrying", render: (row) => row.retrying },
            { key: "risk", label: "Risk", render: (row) => row.risk },
            { key: "quota", label: "Quota", render: (row) => row.quota },
            { key: "relay", label: "Relay", render: (row) => row.relay },
          ],
          rows,
          emptyMessage: "No timeseries points available yet.",
        }),
      });
    }

    const unused = overview;
    void unused;
  }

  async function loadStabilityPage() {
    const [insights, alertsPayload, logsPayload] = await Promise.all([
      fetchJson("/api/v1/dashboard/insights?window=24h"),
      fetchJson("/api/v1/dashboard/alerts"),
      fetchJson("/api/v1/dashboard/logs?limit=60"),
    ]);

    const alerts = alertsPayload.alerts || [];
    const activeAlerts = alerts.filter((alert) => String(alert.status || "").toLowerCase() === "active");
    const problemLogs = (logsPayload.logs || []).filter((row) => ["failed", "retrying"].includes(String(row.status)));

    setSubline(
      `Last refresh ${formatTime(new Date().toISOString())} | Queue pressure ${insights.queue.pressureLevel} | Active alerts ${activeAlerts.length}`
    );

    const summaryMount = document.getElementById("stabilitySummary");
    if (summaryMount) {
      summaryMount.innerHTML = [
        renderSummaryCard({
          label: "Queue Pressure",
          value: fmtNumber(insights.queue.pressureScore, 1),
          sub: `Level ${insights.queue.pressureLevel}`,
          tone: insights.queue.pressureLevel === "high" ? "critical" : insights.queue.pressureLevel,
        }),
        renderSummaryCard({
          label: "Oldest Queue Age",
          value: formatDurationMinutes(insights.queue.oldestAgeMinutes),
          sub: `Pending ${fmt(insights.queue.pending)} | Retrying ${fmt(insights.queue.retrying)}`,
          tone: Number(insights.queue.oldestAgeMinutes || 0) >= 30 ? "warning" : "secure",
        }),
        renderSummaryCard({
          label: "Active Alerts",
          value: fmtNumber(activeAlerts.length),
          sub: "Current unresolved system alerts",
          tone: activeAlerts.length > 0 ? "warning" : "secure",
        }),
        renderSummaryCard({
          label: "Top Error Code",
          value: fmt(insights.topErrors?.[0]?.code || "none"),
          sub: fmt(insights.topErrors?.[0]?.count || 0) + " recent events",
          tone: insights.topErrors?.length ? "warning" : "secure",
        }),
      ].join("");
    }

    const actionMount = document.getElementById("stabilityActionPlan");
    if (actionMount) {
      actionMount.innerHTML = renderPanel({
        title: "Stability Action Plan",
        meta: "Current top issue and recommended operator response.",
        bodyHtml: `<div class="action-plan">
          <div class="focus-line">
            <span class="${badgeClass(insights.actionPlan.severity)}">${escapeHtml(insights.actionPlan.severity)}</span>
            <div class="title">${escapeHtml(insights.actionPlan.topIssue)}</div>
          </div>
          <div class="body"><strong>Suggested action:</strong> ${escapeHtml(insights.actionPlan.suggestedAction)}</div>
          <div class="body"><strong>Why this matters:</strong> ${escapeHtml(insights.actionPlan.whyThisMatters)}</div>
        </div>`,
      });
    }

    const problemsMount = document.getElementById("stabilityProblems");
    if (problemsMount) {
      const errorRows = (insights.topErrors || []).map((item) => ({
        code: escapeHtml(item.code),
        count: escapeHtml(fmt(item.count)),
      }));

      const logRows = problemLogs.slice(0, 20).map((row) => ({
        createdAt: escapeHtml(formatTime(row.created_at)),
        requestId: escapeHtml(fmt(row.request_id)),
        status: `<span class="${badgeClass(row.status)}">${escapeHtml(fmt(row.status))}</span>`,
        error: escapeHtml(fmt(row.error_message || row.error_code)),
      }));

      problemsMount.innerHTML = [
        renderPanel({
          title: "Top Delivery Error Codes",
          meta: "Most frequent retry/failure signatures in current window.",
          bodyHtml: renderSimpleTable({
            columns: [
              { key: "code", label: "Error Code", render: (row) => row.code },
              { key: "count", label: "Count", render: (row) => row.count },
            ],
            rows: errorRows,
            emptyMessage: "No failure or retry error codes in active window.",
          }),
        }),
        renderPanel({
          title: "Recent Unstable Events",
          meta: "Latest failed or retrying mail events.",
          bodyHtml: renderSimpleTable({
            columns: [
              { key: "createdAt", label: "Time", render: (row) => row.createdAt },
              { key: "requestId", label: "Request ID", render: (row) => row.requestId },
              { key: "status", label: "Status", render: (row) => row.status },
              { key: "error", label: "Error", render: (row) => row.error },
            ],
            rows: logRows,
            emptyMessage: "No failed/retrying events found.",
          }),
        }),
      ].join("");
    }
  }

  async function loadProgramsPage() {
    const programs = await fetchJson("/api/v1/dashboard/programs");

    setSubline(
      `Last refresh ${formatTime(new Date().toISOString())} | Overall ${programs.overall.health} | Issues ${programs.overall.issueCount}`
    );

    const summaryMount = document.getElementById("programsSummary");
    if (summaryMount) {
      summaryMount.innerHTML = [
        renderSummaryCard({
          label: "Overall State",
          value: fmt(programs.overall.health),
          sub: `${fmt(programs.overall.issueCount)} issue(s) detected`,
          tone: programs.overall.health,
        }),
        renderSummaryCard({
          label: "Systemd Services",
          value: fmt(programs.systemd.checks.length),
          sub: `Health ${programs.systemd.health}`,
          tone: programs.systemd.health,
        }),
        renderSummaryCard({
          label: "PM2 Apps",
          value: fmt(programs.pm2.summary.total),
          sub: `Online ${fmt(programs.pm2.summary.online)}`,
          tone: programs.pm2.health,
        }),
        renderSummaryCard({
          label: "Docker Containers",
          value: fmt(programs.docker.summary.running),
          sub: `Health ${programs.docker.health}`,
          tone: programs.docker.health,
        }),
      ].join("");
    }

    const servicesMount = document.getElementById("programsServices");
    if (servicesMount) {
      const systemRows = (programs.systemd.checks || []).map((item) => ({
        unit: escapeHtml(item.unit),
        state: `<span class="${badgeClass(item.health)}">${escapeHtml(item.state)}</span>`,
        health: `<span class="${badgeClass(item.health)}">${escapeHtml(item.health)}</span>`,
        message: escapeHtml(fmt(item.message)),
      }));

      const pm2Rows = (programs.pm2.apps || []).map((app) => ({
        name: escapeHtml(app.name),
        status: `<span class="${badgeClass(app.health)}">${escapeHtml(app.status)}</span>`,
        restarts: escapeHtml(fmt(app.restarts)),
        startedAt: escapeHtml(formatTime(app.startedAt)),
      }));

      servicesMount.innerHTML = [
        renderPanel({
          title: "Systemd Service Checks",
          meta: "Nginx, Postfix, and Fail2Ban runtime states.",
          bodyHtml: renderSimpleTable({
            columns: [
              { key: "unit", label: "Unit", render: (row) => row.unit },
              { key: "state", label: "State", render: (row) => row.state },
              { key: "health", label: "Health", render: (row) => row.health },
              { key: "message", label: "Message", render: (row) => row.message },
            ],
            rows: systemRows,
            emptyMessage: "No systemd service checks available.",
          }),
        }),
        renderPanel({
          title: "PM2 Process Inventory",
          meta: "All PM2 apps with status and restart activity.",
          bodyHtml: renderSimpleTable({
            columns: [
              { key: "name", label: "App", render: (row) => row.name },
              { key: "status", label: "Status", render: (row) => row.status },
              { key: "restarts", label: "Restarts", render: (row) => row.restarts },
              { key: "startedAt", label: "Started", render: (row) => row.startedAt },
            ],
            rows: pm2Rows,
            emptyMessage: "No PM2 apps returned.",
          }),
        }),
      ].join("");
    }

    const infraMount = document.getElementById("programsInfra");
    if (infraMount) {
      const listenerRows = (programs.listeners.checks || []).map((check) => ({
        label: escapeHtml(check.label),
        expected: escapeHtml(check.expected),
        found: `<span class="${badgeClass(check.found ? "secure" : "warning")}">${escapeHtml(
          check.found ? "yes" : "no"
        )}</span>`,
        health: `<span class="${badgeClass(check.health)}">${escapeHtml(check.health)}</span>`,
      }));

      const issueRows = (programs.overall.issues || []).map((issue) => ({
        component: escapeHtml(issue.component),
        health: `<span class="${badgeClass(issue.health)}">${escapeHtml(issue.health)}</span>`,
        message: escapeHtml(fmt(issue.message)),
      }));

      infraMount.innerHTML = [
        renderPanel({
          title: "Listener and Infra Checks",
          meta: "Critical sockets and telemetry freshness checks.",
          bodyHtml:
            renderSimpleTable({
              columns: [
                { key: "label", label: "Check", render: (row) => row.label },
                { key: "expected", label: "Expected", render: (row) => row.expected },
                { key: "found", label: "Found", render: (row) => row.found },
                { key: "health", label: "Health", render: (row) => row.health },
              ],
              rows: listenerRows,
              emptyMessage: "No listener checks available.",
            }) +
            renderKeyValueList([
              { label: "metrics.json path", value: programs.metrics.path },
              { label: "metrics freshness", value: `${fmt(programs.metrics.freshnessMinutes)} minutes` },
              { label: "snapshot latest", value: formatTime(programs.snapshotWorker.latestCapturedAt) },
              { label: "snapshot age", value: `${fmt(programs.snapshotWorker.ageMinutes)} minutes` },
            ]),
        }),
        renderPanel({
          title: "Program Checker Issues",
          meta: "Aggregated non-healthy checks requiring operator review.",
          bodyHtml: renderSimpleTable({
            columns: [
              { key: "component", label: "Component", render: (row) => row.component },
              { key: "health", label: "Health", render: (row) => row.health },
              { key: "message", label: "Message", render: (row) => row.message },
            ],
            rows: issueRows,
            emptyMessage: "No active issues detected by program checker.",
          }),
        }),
      ].join("");
    }
  }

  async function loadMailPage() {
    const mailCheck = await fetchJson("/api/v1/dashboard/mail-check");
    setSubline(
      `Last refresh ${formatTime(new Date().toISOString())} | Relay ${
        mailCheck.relay.ok ? "healthy" : "degraded"
      } | Probe cooldown ${fmt(mailCheck.probe.remainingCooldownSeconds)}s`
    );

    const summaryMount = document.getElementById("mailSummary");
    if (summaryMount) {
      summaryMount.innerHTML = [
        renderSummaryCard({
          label: "Relay",
          value: mailCheck.relay.ok ? "Healthy" : "Degraded",
          sub: `${mailCheck.relay.host}:${mailCheck.relay.port}`,
          tone: mailCheck.relay.ok ? "secure" : "critical",
        }),
        renderSummaryCard({
          label: "Queue Pending",
          value: fmtNumber(mailCheck.queue.pending),
          sub: `Retrying ${fmt(mailCheck.queue.retrying)} | Failed ${fmt(mailCheck.queue.failed)}`,
          tone: Number(mailCheck.queue.failed || 0) > 0 ? "warning" : "secure",
        }),
        renderSummaryCard({
          label: "Success (24h)",
          value: `${fmtNumber(mailCheck.delivery24h.successRatePct, 1)}%`,
          sub: `${fmt(mailCheck.delivery24h.sent)} sent`,
          tone: mailCheck.delivery24h.successRatePct >= 95 ? "secure" : "warning",
        }),
        renderSummaryCard({
          label: "Quota Remaining",
          value: fmtNumber(mailCheck.quota.remaining),
          sub: `${fmt(mailCheck.quota.used)} / ${fmt(mailCheck.quota.limit)} used`,
          tone: Number(mailCheck.quota.remaining || 0) < 100 ? "warning" : "secure",
        }),
      ].join("");
    }

    const diagnosticsMount = document.getElementById("mailDiagnostics");
    if (diagnosticsMount) {
      const topErrorsRows = (mailCheck.topErrors || []).map((item) => ({
        code: escapeHtml(item.code),
        count: escapeHtml(fmt(item.count)),
      }));

      diagnosticsMount.innerHTML = [
        renderPanel({
          title: "Mail Runtime Diagnostics",
          meta: "Live relay and queue diagnostics from mail service.",
          bodyHtml: renderKeyValueList([
            { label: "Relay status", value: mailCheck.relay.ok ? "healthy" : "degraded" },
            { label: "Relay error code", value: mailCheck.relay.errorCode || "-" },
            { label: "Relay error message", value: mailCheck.relay.errorMessage || "-" },
            { label: "Last successful delivery", value: formatTime(mailCheck.lastSuccessfulDeliveryAt) },
            { label: "Probe recipient", value: mailCheck.probe.recipient || "not configured" },
            { label: "Probe cooldown", value: `${fmt(mailCheck.probe.cooldownSeconds)} seconds` },
          ]),
        }),
        renderPanel({
          title: "Top Error Codes (24h)",
          meta: "Most frequent retry/failure signatures in recent events.",
          bodyHtml: renderSimpleTable({
            columns: [
              { key: "code", label: "Code", render: (row) => row.code },
              { key: "count", label: "Count", render: (row) => row.count },
            ],
            rows: topErrorsRows,
            emptyMessage: "No top error codes in current 24h window.",
          }),
        }),
      ].join("");
    }

    const problemsMount = document.getElementById("mailProblems");
    if (problemsMount) {
      const rows = (mailCheck.recentProblems || []).map((event) => ({
        createdAt: escapeHtml(formatTime(event.createdAt)),
        requestId: escapeHtml(fmt(event.requestId)),
        status: `<span class="${badgeClass(event.status)}">${escapeHtml(fmt(event.status))}</span>`,
        to: escapeHtml(fmt(event.to)),
        error: escapeHtml(fmt(event.errorMessage || event.errorCode)),
      }));

      problemsMount.innerHTML = renderPanel({
        title: "Recent Mail Problems",
        meta: "Latest failed/retrying events with metadata-only diagnostics.",
        bodyHtml: renderSimpleTable({
          columns: [
            { key: "createdAt", label: "Time", render: (row) => row.createdAt },
            { key: "requestId", label: "Request ID", render: (row) => row.requestId },
            { key: "status", label: "Status", render: (row) => row.status },
            { key: "to", label: "Recipient", render: (row) => row.to },
            { key: "error", label: "Error", render: (row) => row.error },
          ],
          rows,
          emptyMessage: "No recent failed/retrying mail events.",
        }),
      });
    }

    const probeMount = document.getElementById("mailProbeResult");
    if (probeMount) {
      const probeConfigured = mailCheck.probe.recipientConfigured;
      probeMount.innerHTML = renderPanel({
        title: "Manual Probe Status",
        meta: "Trigger one controlled probe mail to validate end-to-end delivery.",
        bodyHtml: `<div class="probe-status">
          <p><strong>Recipient configured:</strong> ${probeConfigured ? "yes" : "no"}</p>
          <p><strong>Recipient:</strong> ${escapeHtml(fmt(mailCheck.probe.recipient || "-"))}</p>
          <p><strong>Cooldown remaining:</strong> ${escapeHtml(fmt(mailCheck.probe.remainingCooldownSeconds))} seconds</p>
          <p id="probeMessage" class="meta">No manual probe has been triggered in this session.</p>
        </div>`,
      });
    }

    const healthMount = document.getElementById("mailHealthCheck");
    if (healthMount) {
      try {
        const hcStatus = await fetchJson("/api/v1/dashboard/health-check-status");
        const lastCheck = hcStatus.lastCheck || {};
        const lastSent = lastCheck.sentAt ? formatTime(lastCheck.sentAt) : "never";
        const lastStatus = lastCheck.status || "-";
        const lastFrequency = lastCheck.category || "-";
        const cooldown = hcStatus.manual?.remainingCooldownSeconds || 0;
        const scheduleRows = (hcStatus.schedule || []).map((s) => ({
          frequency: escapeHtml(s.frequency),
          cron: escapeHtml(s.cron),
          description: escapeHtml(s.description),
        }));

        healthMount.innerHTML = renderPanel({
          title: "Scheduled Health Checks",
          meta: "Cron-scheduled and manual health check probes via system-alert template.",
          bodyHtml: `<div class="probe-status">
            <p><strong>Last sent:</strong> ${escapeHtml(lastSent)}</p>
            <p><strong>Last status:</strong> <span class="${badgeClass(lastStatus)}">${escapeHtml(lastStatus)}</span></p>
            <p><strong>Last frequency:</strong> ${escapeHtml(fmt(lastFrequency))}</p>
            <p><strong>Manual cooldown:</strong> ${escapeHtml(fmt(cooldown))} seconds</p>
            <p id="healthCheckMessage" class="meta">Click "Health Check" to send a manual health check email.</p>
          </div>
          ${renderSimpleTable({
            columns: [
              { key: "frequency", label: "Frequency", render: (row) => row.frequency },
              { key: "cron", label: "Cron", render: (row) => row.cron },
              { key: "description", label: "Schedule", render: (row) => row.description },
            ],
            rows: scheduleRows,
            emptyMessage: "No scheduled health checks configured.",
          })}`,
        });
      } catch (error) {
        healthMount.innerHTML = renderPanel({
          title: "Scheduled Health Checks",
          meta: "Cron-scheduled and manual health check probes.",
          bodyHtml: `<p class="meta">Failed to load health check status: ${escapeHtml(error.message)}</p>`,
        });
      }
    }
  }

  function stopActivityAutoRefresh() {
    if (pageState.activity.timer) {
      clearInterval(pageState.activity.timer);
      pageState.activity.timer = null;
    }
  }

  function setActivityToggleLabel() {
    const toggleBtn = document.getElementById("toggleAutoRefreshBtn");
    if (!toggleBtn) {
      return;
    }

    const enabled = Boolean(pageState.activity.enabled);
    toggleBtn.dataset.active = enabled ? "true" : "false";
    toggleBtn.textContent = enabled ? "Pause Auto" : "Resume Auto";
  }

  function scheduleActivityAutoRefresh(run) {
    stopActivityAutoRefresh();
    if (!pageState.activity.enabled) {
      return;
    }

    const refreshSeconds = Math.max(2, Number(pageState.activity.refreshSeconds || 5));
    pageState.activity.timer = setInterval(run, refreshSeconds * 1000);
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
        { key: "state", label: "State", render: (row) => `<span class="${badgeClass(row.state)}">${escapeHtml(fmt(row.state))}</span>` },
        { key: "threads", label: "Threads", render: (row) => escapeHtml(fmt(row.threads)) },
        { key: "elapsed", label: "Elapsed", render: (row) => escapeHtml(formatUptimeSeconds(row.elapsedSec)) },
        {
          key: "command",
          label: "Command",
          render: (row) => `<span class="mono process-command" title="${formatCommand(row)}">${formatCommand(row)}</span>`,
        },
      ],
      rows: safeRows,
      emptyMessage,
    });
  }

  async function loadActivityPage() {
    const snapshot = await fetchJson("/api/v1/dashboard/activity");

    const limits = snapshot.limits || {};
    const refreshSeconds = Math.max(2, Number(limits.refreshSeconds || pageState.activity.refreshSeconds || 5));
    pageState.activity.refreshSeconds = refreshSeconds;
    if (typeof pageState.activity.setRefreshSeconds === "function") {
      pageState.activity.setRefreshSeconds(refreshSeconds);
    }

    setSubline(
      `Last refresh ${formatTime(snapshot.timestamp)} | Auto ${refreshSeconds}s | Health ${fmt(
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
          sub: `${fmtNumber((Number(snapshot.memoryUsedBytes || 0) / (1024 ** 3)), 2)} GiB used`,
          tone: Number(snapshot.memoryUsedPct || 0) >= 85 ? "warning" : "secure",
        }),
        renderSummaryCard({
          label: "Tasks",
          value: `${fmt(snapshot.tasks?.running || 0)} / ${fmt(snapshot.tasks?.total || 0)}`,
          sub: `Running / total`,
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
            { label: "Memory used percent", value: snapshot.memoryUsedPct == null ? "n/a" : `${fmtNumber(snapshot.memoryUsedPct, 1)}%` },
            { label: "Memory used", value: `${fmtNumber((Number(snapshot.memoryUsedBytes || 0) / (1024 ** 3)), 2)} GiB` },
            { label: "Memory total", value: `${fmtNumber((Number(snapshot.memoryTotalBytes || 0) / (1024 ** 3)), 2)} GiB` },
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
            `<div class="diagnostics">${errors.length ? errors.map((value) => `<p>${escapeHtml(String(value))}</p>`).join("") : "<p>No diagnostics errors.</p>"}</div>`,
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

    pageState.activity.enabled = true;
    pageState.activity.setRefreshSeconds = (seconds) => {
      const nextSeconds = Math.max(2, Number(seconds || 5));
      if (nextSeconds === pageState.activity.refreshSeconds && pageState.activity.timer) {
        return;
      }
      pageState.activity.refreshSeconds = nextSeconds;
      scheduleActivityAutoRefresh(run);
      setActivityToggleLabel();
    };

    if (refreshBtn) {
      refreshBtn.addEventListener("click", run);
    }

    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        pageState.activity.enabled = !pageState.activity.enabled;
        if (pageState.activity.enabled) {
          scheduleActivityAutoRefresh(run);
        } else {
          stopActivityAutoRefresh();
        }
        setActivityToggleLabel();
      });
    }

    window.addEventListener("beforeunload", stopActivityAutoRefresh, { once: true });

    await run();
    scheduleActivityAutoRefresh(run);
    setActivityToggleLabel();
  }

  async function runPageLoader(loader) {
    const refreshBtn = document.getElementById("refreshBtn");

    const run = async () => {
      if (refreshBtn) refreshBtn.disabled = true;
      try {
        await loader();
      } catch (error) {
        setSubline(`Page load failed: ${error.message}`);
      } finally {
        if (refreshBtn) refreshBtn.disabled = false;
      }
    };

    if (refreshBtn) {
      refreshBtn.addEventListener("click", run);
    }

    const windowSelect = document.getElementById("trendWindow");
    if (windowSelect) {
      windowSelect.addEventListener("change", run);
    }

    await run();
  }

  function bindProbeAction() {
    const probeBtn = document.getElementById("probeBtn");
    if (!probeBtn) {
      return;
    }

    probeBtn.addEventListener("click", async () => {
      const probeMessage = document.getElementById("probeMessage");
      probeBtn.disabled = true;
      if (probeMessage) {
        probeMessage.textContent = "Triggering manual probe...";
      }

      try {
        const result = await fetchJson("/api/v1/dashboard/mail-probe", { method: "POST" });
        if (probeMessage) {
          probeMessage.textContent = `Probe sent to ${result.recipient} at ${formatTime(
            result.triggeredAt
          )}. Result: ${fmt(result.result?.status)} (attempts: ${fmt(result.result?.attempts)}).`;
        }
      } catch (error) {
        if (probeMessage) {
          const retryAfter = error?.payload?.retryAfterSeconds;
          probeMessage.textContent = retryAfter
            ? `${error.message} Retry in ${retryAfter} seconds.`
            : error.message;
        }
      } finally {
        probeBtn.disabled = false;
      }
    });
  }

  function bindHealthCheckAction(reloadPage) {
    const healthCheckBtn = document.getElementById("healthCheckBtn");
    if (!healthCheckBtn) {
      return;
    }

    healthCheckBtn.addEventListener("click", async () => {
      const healthCheckMessage = document.getElementById("healthCheckMessage");
      healthCheckBtn.disabled = true;
      if (healthCheckMessage) {
        healthCheckMessage.textContent = "Sending manual health check...";
      }

      try {
        const result = await fetchJson("/api/v1/dashboard/health-check-send", { method: "POST" });
        if (healthCheckMessage) {
          if (result.ok) {
            healthCheckMessage.textContent = `Health check sent to ${fmt(result.recipient)} at ${formatTime(result.triggeredAt)}. Status: ${fmt(result.result?.status || "sent")}.`;
          } else {
            healthCheckMessage.textContent = result.error || "Health check failed.";
          }
        }
        if (reloadPage) {
          setTimeout(reloadPage, 2000);
        }
      } catch (error) {
        if (healthCheckMessage) {
          const retryAfter = error?.payload?.retryAfterSeconds;
          healthCheckMessage.textContent = retryAfter
            ? `${error.message} Retry in ${retryAfter} seconds.`
            : error.message;
        }
      } finally {
        healthCheckBtn.disabled = false;
      }
    });
  }

  function bindQueueActions(reloadPage) {
    const retryBtn = document.getElementById("retryStuckBtn");
    const failBtn = document.getElementById("failStuckBtn");

    if (retryBtn) {
      retryBtn.addEventListener("click", async () => {
        retryBtn.disabled = true;
        try {
          const result = await fetchJson("/api/v1/dashboard/mail-retry-stuck", { method: "POST" });
          retryBtn.textContent = `Retried ${result.affected}`;
          if (reloadPage) {
            setTimeout(reloadPage, 1500);
          }
        } catch (error) {
          retryBtn.textContent = "Retry failed";
        } finally {
          setTimeout(() => {
            retryBtn.textContent = "Retry Stuck";
            retryBtn.disabled = false;
          }, 3000);
        }
      });
    }

    if (failBtn) {
      failBtn.addEventListener("click", async () => {
        failBtn.disabled = true;
        try {
          const result = await fetchJson("/api/v1/dashboard/mail-fail-stuck", { method: "POST" });
          failBtn.textContent = `Failed ${result.affected}`;
          if (reloadPage) {
            setTimeout(reloadPage, 1500);
          }
        } catch (error) {
          failBtn.textContent = "Action failed";
        } finally {
          setTimeout(() => {
            failBtn.textContent = "Fail Stuck";
            failBtn.disabled = false;
          }, 3000);
        }
      });
    }
  }

  async function boot() {
    const pageType = String(document.body?.dataset?.dashboardPage || "").trim();
    if (!pageType || pageType === "overview") {
      return;
    }

    const session = await ensureSession();
    if (!session) {
      return;
    }

    bindLogout();
    bindProbeAction();

    if (typeof window.mountDashboardNav === "function") {
      window.mountDashboardNav();
    }

    if (pageType === "security") {
      await runPageLoader(loadSecurityPage);
      return;
    }

    if (pageType === "health") {
      await runPageLoader(loadHealthPage);
      return;
    }

    if (pageType === "performance") {
      await runPageLoader(loadPerformancePage);
      return;
    }

    if (pageType === "stability") {
      await runPageLoader(loadStabilityPage);
      return;
    }

    if (pageType === "programs") {
      await runPageLoader(loadProgramsPage);
      return;
    }

    if (pageType === "mail") {
      bindQueueActions(() => runPageLoader(loadMailPage));
      bindHealthCheckAction(() => runPageLoader(loadMailPage));
      await runPageLoader(loadMailPage);
      return;
    }

    if (pageType === "activity") {
      await runActivityPageLoader();
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
