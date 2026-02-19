const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createCore } = require("../src/runtime");
const { createApp } = require("../src/app");

test("single dashboard auth, allowlist, and protected APIs", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "email-vps-dashboard-"));
  const dbPath = path.join(tempDir, "dashboard.sqlite");

  const transport = {
    async verify() {
      return true;
    },
    async sendMail() {
      return {
        messageId: "dashboard-test",
        accepted: ["user@example.com"],
        rejected: [],
      };
    },
    close() {},
  };

  const core = await createCore({
    envOverrides: {
      NODE_ENV: "test",
      DB_PATH: dbPath,
      MAIL_API_TOKEN: "mail-token",
      MAIL_FROM: "Email VPS <noreply@example.com>",
      DASHBOARD_LOGIN_USER: "owner",
      DASHBOARD_LOGIN_PASS: "StrongPass123!",
      DASHBOARD_SESSION_SECRET: "dashboard-session-secret-value",
      DASHBOARD_IP_ALLOWLIST_ENABLED: "true",
      DASHBOARD_ALLOWED_IPS: "127.0.0.1",
      DASHBOARD_TRUST_PROXY: "true",
      DASHBOARD_OTP_TO: "owner@example.com",
      DASHBOARD_METRIC_SNAPSHOT_MINUTES: "1",
      DASHBOARD_RETENTION_DAYS: "90",
      DASHBOARD_MAIL_PROBE_TO: "probe@example.com",
      DASHBOARD_MAIL_PROBE_COOLDOWN_SECONDS: "300",
    },
    transport,
  });

  const app = createApp({
    env: core.env,
    mailService: core.mailService,
    rateLimiter: core.rateLimiter,
    repository: core.repository,
    dashboardService: core.dashboardService,
    opsInsightService: core.opsInsightService,
    programCheckerService: core.programCheckerService,
    mailCheckerService: core.mailCheckerService,
    activityCheckerService: core.activityCheckerService,
    otpAuthService: core.otpAuthService,
    healthCheckService: core.healthCheckService,
  });

  const agent = request.agent(app);

  try {
    const disallowedIp = await request(app)
      .get("/login")
      .set("x-forwarded-for", "203.0.113.5");

    assert.equal(disallowedIp.status, 403);

    const sessionBefore = await agent.get("/auth/session");
    assert.equal(sessionBefore.status, 200);
    assert.equal(sessionBefore.body.authenticated, false);

    const badLogin = await agent.post("/auth/login").send({
      username: "owner",
      password: "wrong",
    });

    assert.equal(badLogin.status, 401);

    const okLogin = await agent.post("/auth/login").send({
      username: "owner",
      password: "StrongPass123!",
    });

    assert.equal(okLogin.status, 200);
    assert.equal(okLogin.body.ok, true);

    const cookieHeader = okLogin.headers["set-cookie"]?.join(";") || "";
    assert.match(cookieHeader, /HttpOnly/i);

    const noCookie = await request(app).get("/api/v1/dashboard/overview");
    assert.equal(noCookie.status, 401);

    const chartAsset = await agent.get("/dashboard/assets/vendor/chart.umd.js");
    assert.equal(chartAsset.status, 200);

    const pages = [
      "/dashboard",
      "/dashboard/activity",
      "/dashboard/security",
      "/dashboard/health",
      "/dashboard/performance",
      "/dashboard/stability",
      "/dashboard/programs",
      "/dashboard/operations",
      "/dashboard/operations/aide",
      "/dashboard/operations/fail2ban",
      "/dashboard/operations/relay",
      "/dashboard/operations/postfix",
      "/dashboard/operations/crontab",
      "/dashboard/mail",
    ];

    for (const routePath of pages) {
      const pageResponse = await agent.get(routePath);
      assert.equal(pageResponse.status, 200, `expected 200 for ${routePath}`);
    }

    const overview = await agent.get("/api/v1/dashboard/overview");
    assert.equal(overview.status, 200);
    assert.equal(typeof overview.body.sent24h, "number");

    const trends = await agent.get("/api/v1/dashboard/trends?window=24h");
    assert.equal(trends.status, 200);
    assert.equal(Array.isArray(trends.body.points), true);

    const timeseries = await agent.get("/api/v1/dashboard/timeseries?window=24h");
    assert.equal(timeseries.status, 200);
    assert.equal(Array.isArray(timeseries.body.points), true);

    const insights = await agent.get("/api/v1/dashboard/insights?window=24h");
    assert.equal(insights.status, 200);
    assert.equal(typeof insights.body.deliveryFunnel.successRatePct, "number");
    assert.equal(typeof insights.body.actionPlan.topIssue, "string");

    const logs = await agent.get("/api/v1/dashboard/logs?limit=10");
    assert.equal(logs.status, 200);
    assert.equal(Array.isArray(logs.body.logs), true);

    const filteredLogs = await agent.get("/api/v1/dashboard/logs?severity=critical&q=user@example.com");
    assert.equal(filteredLogs.status, 200);
    assert.equal(Array.isArray(filteredLogs.body.logs), true);

    const security = await agent.get("/api/v1/dashboard/security");
    assert.equal(security.status, 200);
    assert.equal(typeof security.body.risk.score, "number");

    const programs = await agent.get("/api/v1/dashboard/programs");
    assert.equal(programs.status, 200);
    assert.equal(typeof programs.body.overall.health, "string");

    const activity = await agent.get("/api/v1/dashboard/activity");
    assert.equal(activity.status, 200);
    assert.equal(Array.isArray(activity.body.topCpu), true);

    const mailCheck = await agent.get("/api/v1/dashboard/mail-check");
    assert.equal(mailCheck.status, 200);
    assert.equal(typeof mailCheck.body.relay.ok, "boolean");

    const operations = await agent.get("/api/v1/dashboard/operations?window=24h");
    assert.equal(operations.status, 200);
    assert.equal(typeof operations.body.overallHealth, "string");
    assert.equal(Array.isArray(operations.body.topOpenIssues), true);

    const operationsControl = await agent.get("/api/v1/dashboard/operations/control/postfix?window=24h");
    assert.equal(operationsControl.status, 200);
    assert.equal(operationsControl.body.control, "postfix");
    assert.equal(Array.isArray(operationsControl.body.topOpenIssues), true);

    const operationsControlInvalid = await agent.get(
      "/api/v1/dashboard/operations/control/not-a-control?window=24h"
    );
    assert.equal(operationsControlInvalid.status, 400);
    assert.equal(operationsControlInvalid.body.error, "INVALID_CONTROL");

    const opsEvents = await agent.get(
      "/api/v1/dashboard/ops-events?source=postfix&status=open&severity=warning&limit=10&offset=0"
    );
    assert.equal(opsEvents.status, 200);
    assert.equal(Array.isArray(opsEvents.body.events), true);
    assert.equal(opsEvents.body.filters.source, "postfix");
    assert.equal(opsEvents.body.filters.status, "open");
    assert.equal(opsEvents.body.filters.severity, "warning");

    const opsRecheck = await agent.post("/api/v1/dashboard/operations/recheck").send({});
    assert.equal(opsRecheck.status, 200);
    assert.equal(opsRecheck.body.ok, true);
    assert.equal(typeof opsRecheck.body.snapshotTimestamp, "string");

    const probeSend = await agent.post("/api/v1/dashboard/mail-probe").send({});
    assert.equal(probeSend.status, 200);
    assert.equal(probeSend.body.ok, true);

    const probeCooldown = await agent.post("/api/v1/dashboard/mail-probe").send({});
    assert.equal(probeCooldown.status, 429);
    assert.equal(probeCooldown.body.error, "MAIL_PROBE_COOLDOWN_ACTIVE");

    const deprecated = await agent.get("/api/v1/admin/overview");
    assert.equal(deprecated.status, 410);

    const adminRedirect = await agent.get("/admin/login");
    assert.equal(adminRedirect.status, 302);
    assert.equal(adminRedirect.headers.location, "/dashboard");

    const logout = await agent.post("/auth/logout");
    assert.equal(logout.status, 200);

    const sessionAfter = await agent.get("/auth/session");
    assert.equal(sessionAfter.status, 200);
    assert.equal(sessionAfter.body.authenticated, false);
  } finally {
    await core.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("otp-first public login enforces otp then credentials and exposes diagnostics", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "email-vps-dashboard-otp-"));
  const dbPath = path.join(tempDir, "dashboard.sqlite");
  const sentMessages = [];

  const transport = {
    async verify() {
      return true;
    },
    async sendMail(payload) {
      sentMessages.push(payload);
      return {
        messageId: "otp-test",
        accepted: [payload.to],
        rejected: [],
      };
    },
    close() {},
  };

  const core = await createCore({
    envOverrides: {
      NODE_ENV: "test",
      DB_PATH: dbPath,
      MAIL_API_TOKEN: "mail-token",
      MAIL_FROM: "Email VPS <noreply@example.com>",
      DASHBOARD_LOGIN_USER: "owner",
      DASHBOARD_LOGIN_PASS: "StrongPass123!",
      DASHBOARD_SESSION_SECRET: "dashboard-session-secret-value",
      DASHBOARD_IP_ALLOWLIST_ENABLED: "false",
      DASHBOARD_TRUST_PROXY: "true",
      DASHBOARD_AUTH_FLOW: "otp_then_credentials",
      DASHBOARD_LOCAL_FALLBACK_ENABLED: "true",
      DASHBOARD_PREAUTH_TTL_MINUTES: "5",
      DASHBOARD_OTP_PRIMARY_ENABLED: "true",
      DASHBOARD_OTP_TO: "owner@example.com",
      DASHBOARD_OTP_FROM: "Email VPS OTP <otp-sender@example.com>",
      DASHBOARD_OTP_DIAGNOSTICS_ENABLED: "true",
      DASHBOARD_OTP_LENGTH: "6",
      DASHBOARD_OTP_TTL_MINUTES: "10",
      DASHBOARD_OTP_RESEND_COOLDOWN_SECONDS: "1",
      DASHBOARD_OTP_MAX_ATTEMPTS: "5",
      DASHBOARD_OTP_REQUEST_RATE_LIMIT: "10",
      DASHBOARD_OTP_REQUEST_RATE_WINDOW_MS: "900000",
      DASHBOARD_OTP_DAILY_LIMIT: "50",
      DASHBOARD_MAIL_PROBE_TO: "probe@example.com",
    },
    transport,
  });

  const app = createApp({
    env: core.env,
    mailService: core.mailService,
    rateLimiter: core.rateLimiter,
    repository: core.repository,
    dashboardService: core.dashboardService,
    opsInsightService: core.opsInsightService,
    programCheckerService: core.programCheckerService,
    mailCheckerService: core.mailCheckerService,
    activityCheckerService: core.activityCheckerService,
    otpAuthService: core.otpAuthService,
    healthCheckService: core.healthCheckService,
  });

  const agent = request.agent(app);

  try {
    const directCredentialWithoutOtp = await request(app)
      .post("/auth/login")
      .set("x-forwarded-for", "203.0.113.9")
      .send({
        username: "owner",
        password: "StrongPass123!",
      });
    assert.equal(directCredentialWithoutOtp.status, 403);
    assert.equal(directCredentialWithoutOtp.body.error, "OTP_REQUIRED");

    const publicLoginPage = await request(app)
      .get("/login")
      .set("x-forwarded-for", "203.0.113.9");
    assert.equal(publicLoginPage.status, 200);

    const otpRequest = await agent
      .post("/auth/otp/request")
      .set("x-forwarded-for", "203.0.113.9")
      .send({});
    assert.equal(otpRequest.status, 200);
    assert.equal(otpRequest.body.ok, true);
    assert.equal(typeof otpRequest.body.otpRequestId, "string");
    assert.equal(sentMessages.length, 1);

    const sentText = String(sentMessages[0]?.text || "");
    const codeMatch = sentText.match(/verification code is:\s*([0-9]{4,8})/i);
    assert.ok(codeMatch, "expected OTP code in outbound OTP email");
    const otpCode = codeMatch[1];

    const badVerify = await agent
      .post("/auth/otp/verify")
      .set("x-forwarded-for", "203.0.113.9")
      .send({ code: "000000" });
    assert.equal(badVerify.status, 400);
    assert.equal(badVerify.body.error, "OTP_INVALID_CODE");

    const goodVerify = await agent
      .post("/auth/otp/verify")
      .set("x-forwarded-for", "203.0.113.9")
      .send({ code: otpCode });
    assert.equal(goodVerify.status, 200);
    assert.equal(goodVerify.body.ok, true);
    assert.equal(goodVerify.body.mode, "otp_verified");
    assert.equal(goodVerify.body.next, "credentials_required");

    const stillUnauthorized = await agent
      .get("/api/v1/dashboard/overview")
      .set("x-forwarded-for", "203.0.113.9");
    assert.equal(stillUnauthorized.status, 401);

    const postOtpCredentialLogin = await agent
      .post("/auth/login")
      .set("x-forwarded-for", "203.0.113.9")
      .send({
        username: "owner",
        password: "StrongPass123!",
      });
    assert.equal(postOtpCredentialLogin.status, 200);
    assert.equal(postOtpCredentialLogin.body.mode, "otp_then_credentials");

    const overview = await agent
      .get("/api/v1/dashboard/overview")
      .set("x-forwarded-for", "203.0.113.9");
    assert.equal(overview.status, 200);

    const otpDiagnostics = await agent
      .get("/api/v1/dashboard/otp-delivery?limit=5")
      .set("x-forwarded-for", "203.0.113.9");
    assert.equal(otpDiagnostics.status, 200);
    assert.equal(otpDiagnostics.body.ok, true);
    assert.equal(Array.isArray(otpDiagnostics.body.events), true);
    assert.equal(otpDiagnostics.body.events.length > 0, true);
    assert.equal(
      String(otpDiagnostics.body.events[0].otpRequestId || "").length > 0,
      true
    );
  } finally {
    await core.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
