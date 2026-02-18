(function dashboardNavBoot() {
  const navItems = [
    { href: "/dashboard", key: "overview", label: "Overview" },
    { href: "/dashboard/activity", key: "activity", label: "Activity" },
    { href: "/dashboard/security", key: "security", label: "Security" },
    { href: "/dashboard/health", key: "health", label: "Health" },
    { href: "/dashboard/performance", key: "performance", label: "Performance" },
    { href: "/dashboard/stability", key: "stability", label: "Stability" },
    { href: "/dashboard/programs", key: "programs", label: "Programs" },
    { href: "/dashboard/mail", key: "mail", label: "Mail" },
  ];

  function resolveCurrentKey(pathname) {
    const path = String(pathname || "/dashboard")
      .trim()
      .replace(/\/+$/, "");

    if (!path || path === "/dashboard" || path === "/dashboard/overview") {
      return "overview";
    }

    const lastSegment = path.split("/").filter(Boolean).pop() || "overview";
    return lastSegment.toLowerCase();
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function renderNav() {
    const mount = document.getElementById("dashboardNavMount");
    if (!mount) {
      return;
    }

    const currentKey = resolveCurrentKey(window.location.pathname);
    const links = navItems
      .map((item) => {
        const active = item.key === currentKey;
        return `<a class="console-tab${active ? " active" : ""}" href="${escapeHtml(item.href)}">${escapeHtml(
          item.label
        )}</a>`;
      })
      .join("");

    mount.innerHTML = `
      <nav class="console-nav-shell" aria-label="Dashboard sections">
        <div class="console-brand">
          <span class="console-dot"></span>
          Email-VPS Operations Console
        </div>
        <div class="console-tabs">
          ${links}
        </div>
      </nav>
    `;
  }

  document.addEventListener("DOMContentLoaded", renderNav);
  window.mountDashboardNav = renderNav;
})();
