const PAGE_MODULE_MAP = {
  activity: "/dashboard/assets/dashboard-page-activity.js",
  operations: "/dashboard/assets/dashboard-page-operations.js",
  "operations-aide": "/dashboard/assets/dashboard-page-operations.js",
  "operations-fail2ban": "/dashboard/assets/dashboard-page-operations.js",
  "operations-relay": "/dashboard/assets/dashboard-page-operations.js",
  "operations-postfix": "/dashboard/assets/dashboard-page-operations.js",
  "operations-crontab": "/dashboard/assets/dashboard-page-operations.js",
};

function resolvePageType() {
  return String(document.body?.dataset?.dashboardPage || "").trim().toLowerCase();
}

async function bootDashboardPage() {
  const pageType = resolvePageType();
  if (!pageType || pageType === "overview") {
    return;
  }

  const modulePath = PAGE_MODULE_MAP[pageType] || "/dashboard/assets/dashboard-pages-core.js";

  try {
    await import(modulePath);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[dashboard-pages] failed to load route module", {
      pageType,
      modulePath,
      error,
    });

    const subline = document.getElementById("pageSubline");
    if (subline) {
      subline.textContent = "Page module failed to load. Please refresh.";
    }
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootDashboardPage);
} else {
  void bootDashboardPage();
}
