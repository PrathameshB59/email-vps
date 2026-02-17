const express = require("express");
const { createAuthTokenMiddleware } = require("./middleware/authToken");
const { createLocalOnlyMiddleware } = require("./middleware/localOnly");
const { createMailRouter } = require("./routes/mailRoutes");
const { createDashboardSessionManager } = require("./dashboard/auth/session");
const { createDashboardLoginRateLimiter } = require("./dashboard/middleware/loginRateLimit");
const { createIpAllowlistMiddleware } = require("./dashboard/middleware/ipAllowlist");
const {
  createDashboardApiAuthMiddleware,
  createDashboardPageAuthMiddleware,
} = require("./dashboard/middleware/dashboardAuth");
const { createDashboardRouter } = require("./dashboard/routes/dashboardRoutes");

function createApp({ env, mailService, rateLimiter, repository, dashboardService }) {
  const app = express();

  if (env.DASHBOARD_TRUST_PROXY) {
    app.set("trust proxy", 1);
  }

  const sessionManager = createDashboardSessionManager({
    secret: env.DASHBOARD_SESSION_SECRET,
    ttlHours: env.DASHBOARD_SESSION_TTL_HOURS,
  });

  const loginRateLimiter = createDashboardLoginRateLimiter({
    maxAttempts: env.DASHBOARD_LOGIN_RATE_LIMIT,
    windowMs: env.DASHBOARD_LOGIN_RATE_WINDOW_MS,
    lockoutMinutes: env.DASHBOARD_LOGIN_LOCKOUT_MINUTES,
  });

  const ipAllowlistMiddleware = createIpAllowlistMiddleware({
    allowedIps: env.DASHBOARD_ALLOWED_IPS,
  });

  const dashboardApiAuthMiddleware = createDashboardApiAuthMiddleware({
    sessionManager,
  });

  const dashboardPageAuthMiddleware = createDashboardPageAuthMiddleware({
    sessionManager,
  });

  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  app.use((req, res, next) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    next();
  });

  app.get("/health", (req, res) => {
    res.status(200).json({
      ok: true,
      service: "email-vps",
      timestamp: new Date().toISOString(),
    });
  });

  app.use(
    "/api/v1/mail",
    createLocalOnlyMiddleware({
      allowNonLocal: env.MAIL_ALLOW_NON_LOCAL,
      allowTestHeader: env.NODE_ENV === "test",
    }),
    createAuthTokenMiddleware(env.MAIL_API_TOKEN),
    createMailRouter({ mailService, rateLimiter, repository })
  );

  app.use(
    createDashboardRouter({
      env,
      repository,
      dashboardService,
      sessionManager,
      loginRateLimiter,
      ipAllowlistMiddleware,
      dashboardApiAuthMiddleware,
      dashboardPageAuthMiddleware,
    })
  );

  app.use("/api/v1/admin", (req, res) => {
    return res.status(410).json({
      error: "ADMIN_API_DEPRECATED",
      message: "Use /api/v1/dashboard/* routes in the unified dashboard service.",
    });
  });

  app.use("/admin", (req, res) => {
    return res.redirect(302, "/dashboard");
  });

  app.get("/", (req, res) => {
    return res.redirect(302, "/dashboard");
  });

  app.use((err, req, res, next) => {
    console.error("[http] unhandled error:", err);
    res.status(500).json({
      error: "INTERNAL_SERVER_ERROR",
      message: "Unexpected server error.",
    });
  });

  return app;
}

module.exports = {
  createApp,
};
