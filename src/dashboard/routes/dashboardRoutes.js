const crypto = require("crypto");
const express = require("express");
const path = require("path");
const { MailProbeError } = require("../services/mailCheckerService");
const { OtpAuthError } = require("../services/otpAuthService");

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

function isLoopbackIp(ip) {
  const value = String(ip || "").trim();
  return value === "127.0.0.1" || value === "::1";
}

function createDashboardRouter({
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
}) {
  const router = express.Router();
  const publicDir = path.resolve(__dirname, "..", "public");
  const staticShortCache = "60m";
  const staticVendorCache = "7d";

  router.use(
    "/dashboard/assets",
    ipAllowlistMiddleware,
    express.static(publicDir, {
      maxAge: staticShortCache,
      etag: true,
      lastModified: true,
      setHeaders(res) {
        res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=60");
      },
    })
  );
  if (chartDistDir) {
    router.use(
      "/dashboard/assets/vendor",
      ipAllowlistMiddleware,
      express.static(chartDistDir, {
        maxAge: staticVendorCache,
        etag: true,
        lastModified: true,
        setHeaders(res) {
          res.setHeader("Cache-Control", "public, max-age=604800, immutable");
        },
      })
    );
  }

  router.get("/favicon.ico", ipAllowlistMiddleware, (req, res) => {
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.sendFile(path.join(publicDir, "favicon.svg"));
  });

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
      const secureCookie = shouldUseSecureCookie(env, req);
      const otpSecondFactorRequired =
        env.DASHBOARD_OTP_PRIMARY_ENABLED && env.DASHBOARD_AUTH_FLOW === "otp_then_credentials";
      const localFallbackAllowed =
        Boolean(env.DASHBOARD_LOCAL_FALLBACK_ENABLED) && isLoopbackIp(requestIp);
      const preAuth = preAuthManager.readPreAuthFromRequest(req);

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

      if (otpSecondFactorRequired && !localFallbackAllowed && !preAuth) {
        await repository.recordAdminAuthEvent({
          email: req.body?.username || null,
          ip: requestIp,
          status: "blocked",
          reason: "dashboard_otp_required_before_credentials",
        });

        return res.status(403).json({
          error: "OTP_REQUIRED",
          message: "OTP verification is required before credential sign-in.",
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
      sessionManager.setSessionCookie(res, session.token, { secure: secureCookie });
      preAuthManager.clearPreAuthCookie(res, { secure: secureCookie });
      otpAuthService.clearChallengeCookie(res, { secure: secureCookie });

      await repository.recordAdminAuthEvent({
        email: env.DASHBOARD_LOGIN_USER,
        ip: requestIp,
        status: "success",
        reason: localFallbackAllowed
          ? "dashboard_login_success_local_fallback"
          : otpSecondFactorRequired
            ? "dashboard_login_success_post_otp"
            : "dashboard_login_success",
      });

      return res.status(200).json({
        ok: true,
        user: {
          username: env.DASHBOARD_LOGIN_USER,
        },
        mode:
          otpSecondFactorRequired && !localFallbackAllowed
            ? "otp_then_credentials"
            : "credentials",
        expiresAt: new Date(session.payload.exp).toISOString(),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/auth/otp/request", ipAllowlistMiddleware, async (req, res, next) => {
    try {
      const requestIp = req.dashboardClientIp || req.ip || req.socket?.remoteAddress || null;
      const secureCookie = shouldUseSecureCookie(env, req);
      const userAgent = req.get("user-agent") || null;

      const otpRequest = await otpAuthService.requestOtp({
        requestIp,
        userAgent,
      });

      preAuthManager.clearPreAuthCookie(res, { secure: secureCookie });
      otpAuthService.setChallengeCookie(res, otpRequest.challengeId, {
        secure: secureCookie,
      });

      await repository.recordAdminAuthEvent({
        email: env.DASHBOARD_OTP_TO,
        ip: requestIp,
        status: "success",
        reason: "dashboard_otp_requested",
      });

      return res.status(200).json({
        ok: true,
        challengeIssued: true,
        otpRequestId: otpRequest.otpRequestId,
        expiresInSeconds: otpRequest.expiresInSeconds,
        resendAvailableInSeconds: otpRequest.resendAvailableInSeconds,
        recipient: otpRequest.recipientMasked,
      });
    } catch (error) {
      if (error instanceof OtpAuthError) {
        const requestIp = req.dashboardClientIp || req.ip || req.socket?.remoteAddress || null;
        await repository.recordAdminAuthEvent({
          email: env.DASHBOARD_OTP_TO,
          ip: requestIp,
          status: error.statusCode >= 429 ? "blocked" : "failed",
          reason: `dashboard_${String(error.code || "otp_request_failed").toLowerCase()}`,
        });

        if (Number.isFinite(Number(error.retryAfterSeconds)) && Number(error.retryAfterSeconds) > 0) {
          res.set("Retry-After", String(Math.trunc(Number(error.retryAfterSeconds))));
        }

        return res.status(error.statusCode || 400).json({
          error: error.code || "OTP_REQUEST_FAILED",
          message: error.message,
          retryAfterSeconds: error.retryAfterSeconds || null,
          otpRequestId: error.otpRequestId || null,
        });
      }

      return next(error);
    }
  });

  router.post("/auth/otp/verify", ipAllowlistMiddleware, async (req, res, next) => {
    try {
      const requestIp = req.dashboardClientIp || req.ip || req.socket?.remoteAddress || null;
      const secureCookie = shouldUseSecureCookie(env, req);
      const challengeId = otpAuthService.readChallengeIdFromRequest(req);
      const code = String(req.body?.code || "").trim();

      await otpAuthService.verifyOtp({
        challengeId,
        code,
      });

      otpAuthService.clearChallengeCookie(res, { secure: secureCookie });
      const preAuth = preAuthManager.createPreAuth({
        challengeId,
        subject: env.DASHBOARD_LOGIN_USER,
      });
      preAuthManager.setPreAuthCookie(res, preAuth.token, { secure: secureCookie });

      await repository.recordAdminAuthEvent({
        email: env.DASHBOARD_OTP_TO,
        ip: requestIp,
        status: "success",
        reason: "dashboard_otp_verify_success",
      });

      return res.status(200).json({
        ok: true,
        mode: "otp_verified",
        next: "credentials_required",
        expiresAt: new Date(preAuth.payload.exp).toISOString(),
      });
    } catch (error) {
      if (error instanceof OtpAuthError) {
        const requestIp = req.dashboardClientIp || req.ip || req.socket?.remoteAddress || null;
        await repository.recordAdminAuthEvent({
          email: env.DASHBOARD_OTP_TO,
          ip: requestIp,
          status: error.statusCode >= 429 ? "blocked" : "failed",
          reason: `dashboard_${String(error.code || "otp_verify_failed").toLowerCase()}`,
        });

        if (Number.isFinite(Number(error.retryAfterSeconds)) && Number(error.retryAfterSeconds) > 0) {
          res.set("Retry-After", String(Math.trunc(Number(error.retryAfterSeconds))));
        }

        return res.status(error.statusCode || 400).json({
          error: error.code || "OTP_VERIFY_FAILED",
          message: error.message,
          retryAfterSeconds: error.retryAfterSeconds || null,
          otpRequestId: error.otpRequestId || null,
        });
      }

      return next(error);
    }
  });

  router.post("/auth/logout", ipAllowlistMiddleware, async (req, res, next) => {
    try {
      const requestIp = req.dashboardClientIp || req.ip || req.socket?.remoteAddress || null;
      const secureCookie = shouldUseSecureCookie(env, req);

      sessionManager.clearSessionCookie(res, { secure: secureCookie });
      preAuthManager.clearPreAuthCookie(res, { secure: secureCookie });
      otpAuthService.clearChallengeCookie(res, { secure: secureCookie });

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
    const preAuth = preAuthManager.readPreAuthFromRequest(req);
    const requiresSecondFactor =
      env.DASHBOARD_OTP_PRIMARY_ENABLED && env.DASHBOARD_AUTH_FLOW === "otp_then_credentials";
    const authConfig = {
      otpPrimaryEnabled: Boolean(env.DASHBOARD_OTP_PRIMARY_ENABLED),
      requiresSecondFactor,
      preAuthVerified: Boolean(preAuth),
      credentialsFallbackEnabled: false,
      publicCredentialLoginEnabled: !requiresSecondFactor,
      localFallbackEnabled: Boolean(env.DASHBOARD_LOCAL_FALLBACK_ENABLED),
      ipAllowlistEnabled: Boolean(env.DASHBOARD_IP_ALLOWLIST_ENABLED),
    };

    if (!session) {
      return res.status(200).json({
        authenticated: false,
        preAuthVerified: Boolean(preAuth),
        auth: authConfig,
      });
    }

    return res.status(200).json({
      authenticated: true,
      preAuthVerified: Boolean(preAuth),
      user: {
        username: String(session.payload.sub || ""),
      },
      expiresAt: new Date(session.payload.exp).toISOString(),
      auth: authConfig,
    });
  });

  router.get("/dashboard", ipAllowlistMiddleware, dashboardPageAuthMiddleware, (req, res) => {
    return res.sendFile(path.join(publicDir, "dashboard.html"));
  });

  const dashboardPages = [
    ["/dashboard/activity", "dashboard-activity.html"],
    ["/dashboard/security", "dashboard-security.html"],
    ["/dashboard/health", "dashboard-health.html"],
    ["/dashboard/performance", "dashboard-performance.html"],
    ["/dashboard/stability", "dashboard-stability.html"],
    ["/dashboard/programs", "dashboard-programs.html"],
    ["/dashboard/mail", "dashboard-mail.html"],
    ["/dashboard/operations", "dashboard-operations.html"],
    ["/dashboard/operations/aide", "dashboard-operations-aide.html"],
    ["/dashboard/operations/fail2ban", "dashboard-operations-fail2ban.html"],
    ["/dashboard/operations/relay", "dashboard-operations-relay.html"],
    ["/dashboard/operations/postfix", "dashboard-operations-postfix.html"],
    ["/dashboard/operations/crontab", "dashboard-operations-crontab.html"],
  ];

  for (const [routePath, fileName] of dashboardPages) {
    router.get(routePath, ipAllowlistMiddleware, dashboardPageAuthMiddleware, (req, res) => {
      return res.sendFile(path.join(publicDir, fileName));
    });
  }

  router.get("/dashboard.html", (req, res) => {
    return res.redirect(302, "/dashboard");
  });

  router.get("/dashboard/overview", (req, res) => {
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

        if (req.method === "GET" && req.path === "/operations") {
          const operations = await opsInsightService.getOperationsSnapshot({
            window: req.query.window,
          });
          return res.status(200).json(operations);
        }

        if (req.method === "GET" && req.path.startsWith("/operations/control/")) {
          const control = String(req.path.replace(/^\/operations\/control\//, "") || "")
            .split("/")
            .filter(Boolean)[0];
          if (!control) {
            return res.status(400).json({
              error: "INVALID_CONTROL",
              message: "Control key is required.",
            });
          }

          try {
            const operationsControl = await opsInsightService.getOperationsControlSnapshot({
              control,
              window: req.query.window,
            });
            return res.status(200).json(operationsControl);
          } catch (error) {
            if (error?.code === "INVALID_CONTROL") {
              return res.status(error.statusCode || 400).json({
                error: error.code,
                message: error.message,
              });
            }
            throw error;
          }
        }

        if (req.method === "GET" && req.path === "/ops-events") {
          const limit = Math.min(Math.max(parseIntParam(req.query.limit, 50), 1), 500);
          const offset = Math.max(parseIntParam(req.query.offset, 0), 0);
          const source = req.query.source ? String(req.query.source).trim().toLowerCase() : null;
          const status = req.query.status ? String(req.query.status).trim().toLowerCase() : null;
          const severity = req.query.severity
            ? String(req.query.severity).trim().toLowerCase()
            : null;
          const events = await opsInsightService.listOpsEvents({
            source,
            status,
            severity,
            window: req.query.window ? String(req.query.window) : null,
            limit,
            offset,
          });
          return res.status(200).json({
            events,
            limit,
            offset,
            filters: {
              source,
              status,
              severity,
              window: req.query.window ? String(req.query.window) : null,
            },
          });
        }

        if (req.method === "POST" && req.path === "/operations/recheck") {
          const result = await opsInsightService.triggerRecheck();
          return res.status(200).json(result);
        }

        if (req.method === "GET" && req.path === "/activity") {
          const activity = await activityCheckerService.getActivitySnapshot();
          return res.status(200).json(activity);
        }

        if (req.method === "GET" && req.path === "/programs") {
          const programs = await programCheckerService.getProgramsSnapshot();
          return res.status(200).json(programs);
        }

        if (req.method === "GET" && req.path === "/mail-check") {
          const mailCheck = await mailCheckerService.getMailCheck();
          return res.status(200).json(mailCheck);
        }

        if (req.method === "POST" && req.path === "/mail-probe") {
          const probeResult = await mailCheckerService.sendProbe({
            requestedByIp: req.dashboardClientIp || req.ip || null,
            dashboardUser: req.dashboardSession?.sub || env.DASHBOARD_LOGIN_USER,
          });
          return res.status(200).json(probeResult);
        }

        if (req.method === "GET" && req.path === "/otp-delivery") {
          if (!env.DASHBOARD_OTP_DIAGNOSTICS_ENABLED) {
            return res.status(404).json({
              error: "NOT_FOUND",
              message: "OTP diagnostics endpoint is disabled.",
            });
          }

          const limit = Math.min(Math.max(parseIntParam(req.query.limit, 25), 1), 100);
          const diagnostics = await otpAuthService.getDeliveryDiagnostics({ limit });
          return res.status(200).json({
            ok: true,
            generatedAt: new Date().toISOString(),
            ...diagnostics,
          });
        }

        if (req.method === "POST" && req.path === "/mail-retry-stuck") {
          const affected = await repository.forceRetryAllStuck();
          return res.status(200).json({ ok: true, action: "retry", affected });
        }

        if (req.method === "POST" && req.path === "/mail-fail-stuck") {
          const affected = await repository.failAllStuck();
          return res.status(200).json({ ok: true, action: "failed", affected });
        }

        if (req.method === "GET" && req.path === "/health-check-status") {
          const status = await healthCheckService.getStatus();
          return res.status(200).json(status);
        }

        if (req.method === "POST" && req.path === "/health-check-send") {
          const result = await healthCheckService.sendManual({
            requestedByIp: req.dashboardClientIp || req.ip || null,
            dashboardUser: req.dashboardSession?.sub || env.DASHBOARD_LOGIN_USER,
          });
          return res.status(200).json(result);
        }

        return res.status(404).json({
          error: "NOT_FOUND",
          message: "Dashboard endpoint not found.",
        });
      } catch (error) {
        if (error instanceof MailProbeError) {
          if (Number.isFinite(Number(error.retryAfterSeconds)) && Number(error.retryAfterSeconds) > 0) {
            res.set("Retry-After", String(Math.trunc(Number(error.retryAfterSeconds))));
          }

          return res.status(error.statusCode || 400).json({
            error: error.code || "MAIL_PROBE_ERROR",
            message: error.message,
            retryAfterSeconds: error.retryAfterSeconds || null,
          });
        }

        return next(error);
      }
    }
  );

  return router;
}

module.exports = {
  createDashboardRouter,
};
