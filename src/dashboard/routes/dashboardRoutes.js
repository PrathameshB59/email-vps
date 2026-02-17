const crypto = require("crypto");
const express = require("express");
const path = require("path");

let chartDistDir = null;
try {
  const chartAutoPath = require.resolve("chart.js/auto");
  chartDistDir = path.resolve(path.dirname(chartAutoPath), "..", "dist");
} catch (error) {
  chartDistDir = null;
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function shouldUseSecureCookie(env, req) {
  if (env.NODE_ENV === "test" || env.NODE_ENV === "development") {
    return false;
  }

  return req.secure || String(req.get("x-forwarded-proto") || "").toLowerCase() === "https";
}

function parseIntParam(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.trunc(parsed);
}

function createDashboardRouter({
  env,
  repository,
  dashboardService,
  sessionManager,
  loginRateLimiter,
  ipAllowlistMiddleware,
  dashboardApiAuthMiddleware,
  dashboardPageAuthMiddleware,
}) {
  const router = express.Router();
  const publicDir = path.resolve(__dirname, "..", "public");

  router.use("/dashboard/assets", ipAllowlistMiddleware, express.static(publicDir));
  if (chartDistDir) {
    router.use("/dashboard/assets/vendor", ipAllowlistMiddleware, express.static(chartDistDir));
  }

  router.get("/login", ipAllowlistMiddleware, (req, res) => {
    const session = sessionManager.readSessionFromRequest(req);
    if (session) {
      return res.redirect(302, "/dashboard");
    }

    return res.sendFile(path.join(publicDir, "login.html"));
  });

  router.post("/auth/login", ipAllowlistMiddleware, async (req, res, next) => {
    try {
      const requestIp = req.dashboardClientIp || req.ip || req.socket?.remoteAddress || null;

      const allowed = loginRateLimiter.assertAllowed(requestIp);
      if (!allowed.allowed) {
        await repository.recordAdminAuthEvent({
          email: req.body?.username || null,
          ip: requestIp,
          status: "blocked",
          reason: "dashboard_login_lockout",
        });

        res.set("Retry-After", String(allowed.retryAfterSeconds || 60));
        return res.status(429).json({
          error: "LOGIN_RATE_LIMITED",
          message: "Too many login attempts. Try again later.",
        });
      }

      const username = String(req.body?.username || "").trim();
      const password = String(req.body?.password || "");

      const userOk = username && timingSafeEqual(username, env.DASHBOARD_LOGIN_USER);
      const passOk = password && timingSafeEqual(password, env.DASHBOARD_LOGIN_PASS);

      if (!userOk || !passOk) {
        const state = loginRateLimiter.recordFailure(requestIp);

        await repository.recordAdminAuthEvent({
          email: username || null,
          ip: requestIp,
          status: state.lockedUntil ? "blocked" : "failed",
          reason: state.lockedUntil ? "dashboard_lockout_triggered" : "dashboard_invalid_credentials",
        });

        return res.status(401).json({
          error: "INVALID_CREDENTIALS",
          message: "Invalid login credentials.",
        });
      }

      loginRateLimiter.recordSuccess(requestIp);

      const session = sessionManager.createSession({ username: env.DASHBOARD_LOGIN_USER });
      const secureCookie = shouldUseSecureCookie(env, req);
      sessionManager.setSessionCookie(res, session.token, { secure: secureCookie });

      await repository.recordAdminAuthEvent({
        email: env.DASHBOARD_LOGIN_USER,
        ip: requestIp,
        status: "success",
        reason: "dashboard_login_success",
      });

      return res.status(200).json({
        ok: true,
        user: {
          username: env.DASHBOARD_LOGIN_USER,
        },
        expiresAt: new Date(session.payload.exp).toISOString(),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/auth/logout", ipAllowlistMiddleware, async (req, res, next) => {
    try {
      const requestIp = req.dashboardClientIp || req.ip || req.socket?.remoteAddress || null;
      const secureCookie = shouldUseSecureCookie(env, req);

      sessionManager.clearSessionCookie(res, { secure: secureCookie });

      await repository.recordAdminAuthEvent({
        email: env.DASHBOARD_LOGIN_USER,
        ip: requestIp,
        status: "success",
        reason: "dashboard_logout",
      });

      return res.status(200).json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/auth/session", ipAllowlistMiddleware, (req, res) => {
    const session = sessionManager.readSessionFromRequest(req);

    if (!session) {
      return res.status(200).json({
        authenticated: false,
      });
    }

    return res.status(200).json({
      authenticated: true,
      user: {
        username: String(session.payload.sub || ""),
      },
      expiresAt: new Date(session.payload.exp).toISOString(),
    });
  });

  router.get("/dashboard", ipAllowlistMiddleware, dashboardPageAuthMiddleware, (req, res) => {
    return res.sendFile(path.join(publicDir, "dashboard.html"));
  });

  router.get("/dashboard.html", (req, res) => {
    return res.redirect(302, "/dashboard");
  });

  router.use(
    "/api/v1/dashboard",
    ipAllowlistMiddleware,
    dashboardApiAuthMiddleware,
    async (req, res, next) => {
      try {
        if (req.method === "GET" && req.path === "/overview") {
          const overview = await dashboardService.getOverview();
          return res.status(200).json(overview);
        }

        if (req.method === "GET" && req.path === "/trends") {
          const trends = await dashboardService.getTrends(req.query.window);
          return res.status(200).json(trends);
        }

        if (req.method === "GET" && req.path === "/timeseries") {
          const timeseries = await dashboardService.getTimeseries(req.query.window);
          return res.status(200).json(timeseries);
        }

        if (req.method === "GET" && req.path === "/insights") {
          const insights = await dashboardService.getInsights(req.query.window);
          return res.status(200).json(insights);
        }

        if (req.method === "GET" && req.path === "/logs") {
          const limit = Math.min(Math.max(parseIntParam(req.query.limit, 50), 1), 500);
          const offset = Math.max(parseIntParam(req.query.offset, 0), 0);
          const status = req.query.status ? String(req.query.status) : null;
          const category = req.query.category ? String(req.query.category) : null;
          const severity = req.query.severity ? String(req.query.severity) : null;
          const query = req.query.q || req.query.query ? String(req.query.q || req.query.query) : null;

          const logs = await dashboardService.getLogs({
            limit,
            offset,
            status,
            category,
            severity,
            query,
          });
          return res.status(200).json({
            logs,
            limit,
            offset,
            filters: {
              status,
              category,
              severity,
              query,
            },
          });
        }

        if (req.method === "GET" && req.path === "/alerts") {
          const alerts = await dashboardService.getAlerts();
          return res.status(200).json({ alerts });
        }

        if (req.method === "GET" && req.path === "/security") {
          const security = await dashboardService.getSecurity();
          return res.status(200).json(security);
        }

        return res.status(404).json({
          error: "NOT_FOUND",
          message: "Dashboard endpoint not found.",
        });
      } catch (error) {
        return next(error);
      }
    }
  );

  return router;
}

module.exports = {
  createDashboardRouter,
};
