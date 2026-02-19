const express = require("express");
const { createAuthTokenMiddleware } = require("./middleware/authToken");
const { createLocalOnlyMiddleware } = require("./middleware/localOnly");
const { createMailRouter } = require("./routes/mailRoutes");
const { createDashboardSessionManager } = require("./dashboard/auth/session");
const { createDashboardPreAuthManager } = require("./dashboard/auth/preauth");
const { createDashboardLoginRateLimiter } = require("./dashboard/middleware/loginRateLimit");
const { createIpAllowlistMiddleware } = require("./dashboard/middleware/ipAllowlist");
const {
  createDashboardApiAuthMiddleware,
  createDashboardPageAuthMiddleware,
} = require("./dashboard/middleware/dashboardAuth");
const { createDashboardRouter } = require("./dashboard/routes/dashboardRoutes");

function buildSecurityHeaders({ env, isSecureRequest }) {
  const cspDirectives = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join("; ");

  const headers = {
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy-Report-Only": cspDirectives,
  };

  if (env.DASHBOARD_CSP_ENFORCE) {
    headers["Content-Security-Policy"] = cspDirectives;
  }

  if (isSecureRequest && Number(env.DASHBOARD_HSTS_MAX_AGE || 0) > 0) {
    headers["Strict-Transport-Security"] = `max-age=${Number(
      env.DASHBOARD_HSTS_MAX_AGE
    )}; includeSubDomains`;
  }

  return headers;
}

function createApp({
  env,
  mailService,
  rateLimiter,
  repository,
  dashboardService,
  opsInsightService = {
    async getOperationsSnapshot() {
      return {
        timestamp: new Date().toISOString(),
        snapshotTimestamp: null,
        window: "24h",
        sinceIso: null,
        freshnessSeconds: null,
        overallHealth: "unknown",
        controls: {},
        mailRuntime: {},
        cronRuntime: {},
        sourceBreakdown: [],
        totals: { open: 0, resolved: 0 },
        topOpenIssues: [],
      };
    },
    async getOperationsControlSnapshot({ control } = {}) {
      const validControls = new Set(["aide", "fail2ban", "relay", "postfix", "crontab"]);
      const controlKey = String(control || "").trim().toLowerCase();
      if (!validControls.has(controlKey)) {
        const error = new Error(
          `Invalid control "${String(control || "")}". Expected one of: ${Array.from(
            validControls
          ).join(", ")}.`
        );
        error.code = "INVALID_CONTROL";
        error.statusCode = 400;
        throw error;
      }

      return {
        timestamp: new Date().toISOString(),
        snapshotTimestamp: null,
        window: "24h",
        sinceIso: null,
        control: controlKey,
        label: controlKey.toUpperCase(),
        sources: [controlKey],
        freshnessSeconds: null,
        overallHealth: "unknown",
        controlHealth: "unknown",
        controlData: {},
        sourceBreakdown: {},
        totals: { open: 0, resolved: 0 },
        topOpenIssues: [],
        fixHints: [],
      };
    },
    async listOpsEvents() {
      return [];
    },
    async triggerRecheck() {
      return {
        ok: false,
        recheckedAt: new Date().toISOString(),
        error: "OPS_INSIGHT_NOT_CONFIGURED",
      };
    },
  },
  programCheckerService = {
    async getProgramsSnapshot() {
      return {
        timestamp: new Date().toISOString(),
        overall: {
          health: "unknown",
          issueCount: 1,
          issues: [
            {
              component: "program-checker",
              health: "unknown",
              message: "Program checker service is not configured.",
            },
          ],
        },
      };
    },
  },
  mailCheckerService = {
    async getMailCheck() {
      return {
        timestamp: new Date().toISOString(),
        error: "MAIL_CHECKER_NOT_CONFIGURED",
      };
    },
    async sendProbe() {
      return {
        ok: false,
        error: "MAIL_CHECKER_NOT_CONFIGURED",
      };
    },
  },
  activityCheckerService = {
    async getActivitySnapshot() {
      return {
        timestamp: new Date().toISOString(),
        health: "unknown",
        diagnostics: {
          errors: ["ACTIVITY_CHECKER_NOT_CONFIGURED"],
        },
      };
    },
  },
  otpAuthService = {
    readChallengeIdFromRequest() {
      return null;
    },
    setChallengeCookie() {},
    clearChallengeCookie() {},
    async requestOtp() {
      throw new Error("OTP_AUTH_NOT_CONFIGURED");
    },
    async verifyOtp() {
      throw new Error("OTP_AUTH_NOT_CONFIGURED");
    },
    async getDeliveryDiagnostics() {
      return {
        events: [],
        failureSummary: [],
      };
    },
  },
  healthCheckService = {
    async getStatus() {
      return { error: "HEALTH_CHECK_NOT_CONFIGURED" };
    },
    async sendManual() {
      return { ok: false, error: "HEALTH_CHECK_NOT_CONFIGURED" };
    },
  },
}) {
  const app = express();

  if (env.DASHBOARD_TRUST_PROXY) {
    app.set("trust proxy", 1);
  }

  const sessionManager = createDashboardSessionManager({
    secret: env.DASHBOARD_SESSION_SECRET,
    ttlHours: env.DASHBOARD_SESSION_TTL_HOURS,
  });

  const preAuthManager = createDashboardPreAuthManager({
    secret: env.DASHBOARD_SESSION_SECRET,
    ttlMinutes: env.DASHBOARD_PREAUTH_TTL_MINUTES,
  });

  const loginRateLimiter = createDashboardLoginRateLimiter({
    maxAttempts: env.DASHBOARD_LOGIN_RATE_LIMIT,
    windowMs: env.DASHBOARD_LOGIN_RATE_WINDOW_MS,
    lockoutMinutes: env.DASHBOARD_LOGIN_LOCKOUT_MINUTES,
  });

  const ipAllowlistMiddleware = createIpAllowlistMiddleware({
    enabled: env.DASHBOARD_IP_ALLOWLIST_ENABLED,
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
    const isSecureRequest =
      req.secure || String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https";

    const headers = buildSecurityHeaders({
      env,
      isSecureRequest,
    });
    for (const [name, value] of Object.entries(headers)) {
      if (value != null && value !== "") {
        res.setHeader(name, value);
      }
    }

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
      opsInsightService,
      programCheckerService,
      mailCheckerService,
      activityCheckerService,
      otpAuthService,
      healthCheckService,
      sessionManager,
      preAuthManager,
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
  __private: {
    buildSecurityHeaders,
  },
};
