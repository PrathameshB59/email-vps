(function dashboardNavBoot() {
  const navItems = [
    { href: "/dashboard", key: "overview", label: "Overview" },
    { href: "/dashboard/activity", key: "activity", label: "Activity" },
    { href: "/dashboard/security", key: "security", label: "Security" },
    { href: "/dashboard/health", key: "health", label: "Health" },
    { href: "/dashboard/performance", key: "performance", label: "Performance" },
    { href: "/dashboard/stability", key: "stability", label: "Stability" },
    { href: "/dashboard/programs", key: "programs", label: "Programs" },
    { href: "/dashboard/operations", key: "operations", label: "Operations" },
    { href: "/dashboard/mail", key: "mail", label: "Mail" },
  ];

  function resolveCurrentKey(pathname) {
    const path = String(pathname || "/dashboard")
      .trim()
      .replace(/\/+$/, "");

    if (!path || path === "/dashboard" || path === "/dashboard/overview") {
      return "overview";
    }

    if (path.startsWith("/dashboard/operations/")) {
      return "operations";
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
    const hasStaticShell =
      mount.classList.contains("console-nav-shell") && Boolean(mount.querySelector("[data-nav-key]"));
    if (!hasStaticShell) {
      const links = navItems
        .map(
          (item) =>
            `<a class="console-tab" data-nav-key="${escapeHtml(item.key)}" href="${escapeHtml(
              item.href
            )}">${escapeHtml(item.label)}</a>`
        )
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

    const navRoot = mount.classList.contains("console-nav-shell")
      ? mount
      : mount.querySelector(".console-nav-shell");
    if (!navRoot) {
      return;
    }

    for (const link of navRoot.querySelectorAll("a.console-tab")) {
      const keyFromHref = resolveCurrentKey(link.getAttribute("href") || "");
      const key = String(link.dataset.navKey || keyFromHref || "").toLowerCase();
      link.dataset.navKey = key;
      link.classList.toggle("active", key === currentKey);
    }

    mount.dataset.ready = "true";
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", renderNav);
  } else {
    renderNav();
  }
  window.mountDashboardNav = renderNav;
})();
