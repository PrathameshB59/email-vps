const ADMIN_API_BASE = "/api/v1/admin";

function setTokens(tokens) {
  if (tokens.accessToken) {
    localStorage.setItem("adminAccessToken", tokens.accessToken);
  }
  if (tokens.refreshToken) {
    localStorage.setItem("adminRefreshToken", tokens.refreshToken);
  }
}

function clearTokens() {
  localStorage.removeItem("adminAccessToken");
  localStorage.removeItem("adminRefreshToken");
}

async function refreshTokens() {
  const refreshToken = localStorage.getItem("adminRefreshToken");
  if (!refreshToken) {
    return false;
  }

  const res = await fetch(`${ADMIN_API_BASE}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });

  if (!res.ok) {
    clearTokens();
    return false;
  }

  const data = await res.json();
  setTokens(data);
  return true;
}

async function apiFetch(path, options = {}) {
  const method = options.method || "GET";
  const headers = {
    ...(options.headers || {}),
  };

  const accessToken = localStorage.getItem("adminAccessToken");
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${ADMIN_API_BASE}${path}`, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 401 && !options._retried) {
    const refreshed = await refreshTokens();
    if (refreshed) {
      return apiFetch(path, { ...options, _retried: true });
    }
  }

  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    const message = payload.message || `Request failed with status ${res.status}`;
    throw new Error(message);
  }

  return res.json();
}

function requireAdminAuth() {
  const accessToken = localStorage.getItem("adminAccessToken");
  const refreshToken = localStorage.getItem("adminRefreshToken");

  if (!accessToken || !refreshToken) {
    window.location.href = "/admin/login";
  }
}

async function adminLogout() {
  const refreshToken = localStorage.getItem("adminRefreshToken");
  if (refreshToken) {
    try {
      await fetch(`${ADMIN_API_BASE}/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
    } catch (error) {
      // best effort logout
    }
  }

  clearTokens();
  window.location.href = "/admin/login";
}

window.AdminClient = {
  apiFetch,
  setTokens,
  clearTokens,
  requireAdminAuth,
  adminLogout,
};
