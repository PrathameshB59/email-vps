export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function fmt(value) {
  if (value == null || value === "") {
    return "-";
  }
  return String(value);
}

export function fmtNumber(value, digits = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "-";
  }
  return numeric.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatTime(iso) {
  if (!iso) return "-";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "-";
  return parsed.toLocaleString();
}

export function formatDurationMinutes(minutes) {
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

export function formatUptimeSeconds(totalSeconds) {
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

export function badgeClass(value) {
  const normalized = String(value || "").toLowerCase();
  if (["critical", "failed", "error", "high"].includes(normalized)) return "badge critical";
  if (
    [
      "warning",
      "warn",
      "retrying",
      "queued",
      "degraded",
      "unknown",
      "unknown_permission",
      "permission_limited",
      "active-warning",
    ].includes(normalized)
  ) {
    return "badge warning";
  }
  return "badge secure";
}

export async function fetchJson(url, options = {}) {
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

export function setSubline(message) {
  const pageSubline = document.getElementById("pageSubline");
  if (pageSubline) {
    pageSubline.textContent = message;
    return;
  }

  const dashboardSubline = document.getElementById("dashboardSubline");
  if (dashboardSubline) {
    dashboardSubline.textContent = message;
  }
}

export function renderSummaryCard({ label, value, sub, tone = "secure" }) {
  return `<article class="summary-item">
    <div class="summary-label">${escapeHtml(label)}</div>
    <div class="summary-value">${escapeHtml(value)}</div>
    <div class="summary-sub">
      <span class="${badgeClass(tone)}">${escapeHtml(String(tone).toUpperCase())}</span>
      ${escapeHtml(sub || "")}
    </div>
  </article>`;
}

export function renderPanel({ title, meta, bodyHtml }) {
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

export function renderKeyValueList(items) {
  const rows = items
    .map(
      (item) =>
        `<div class="kv-row"><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(fmt(item.value))}</strong></div>`
    )
    .join("");
  return `<div class="kv-list">${rows}</div>`;
}

export function renderSimpleTable({ columns, rows, emptyMessage = "No rows available." }) {
  if (!rows.length) {
    return `<div class="empty-state">${escapeHtml(emptyMessage)}</div>`;
  }

  const header = columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("");
  const body = rows
    .map((row) => {
      const cells = columns
        .map((column) => {
          const value = typeof column.render === "function" ? column.render(row) : row[column.key];
          return `<td data-label="${escapeHtml(column.label)}">${value}</td>`;
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

export function bindLogout({ env = null } = {}) {
  const logoutBtn = document.getElementById("logoutBtn");
  if (!logoutBtn) {
    return;
  }

  logoutBtn.addEventListener("click", async () => {
    try {
      await fetchJson("/auth/logout", { method: "POST" });
    } catch (error) {
      void error;
    }
    window.location.href = "/login";
  });

  void env;
}

export async function ensureSession() {
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

export async function runPageLoader(loader, options = {}) {
  const refreshBtn = document.getElementById("refreshBtn");
  const windowSelectors = options.windowSelectors || [];

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

  for (const id of windowSelectors) {
    const select = document.getElementById(id);
    if (select) {
      select.addEventListener("change", run);
    }
  }

  await run();
  return run;
}

export async function ensureSessionAndMountNav() {
  const session = await ensureSession();
  if (!session) {
    return null;
  }

  bindLogout();
  if (typeof window.mountDashboardNav === "function") {
    window.mountDashboardNav();
  }

  return session;
}
