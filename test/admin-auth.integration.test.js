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
      DASHBOARD_ALLOWED_IPS: "127.0.0.1",
      DASHBOARD_TRUST_PROXY: "true",
      DASHBOARD_METRIC_SNAPSHOT_MINUTES: "1",
      DASHBOARD_RETENTION_DAYS: "90",
    },
    transport,
  });

  const app = createApp({
    env: core.env,
    mailService: core.mailService,
    rateLimiter: core.rateLimiter,
    repository: core.repository,
    dashboardService: core.dashboardService,
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
