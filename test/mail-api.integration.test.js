const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createCore } = require("../src/runtime");
const { createApp } = require("../src/app");

test("mail API enforces auth and local-only rules", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "email-vps-api-"));
  const dbPath = path.join(tempDir, "api.sqlite");

  const transport = {
    async sendMail() {
      return {
        messageId: "mock-message-id",
        accepted: ["user@example.com"],
        rejected: [],
      };
    },
    async verify() {
      return true;
    },
  };

  const core = await createCore({
    envOverrides: {
      NODE_ENV: "test",
      MAIL_API_TOKEN: "test-token",
      MAIL_FROM: "Email VPS <noreply@example.com>",
      DB_PATH: dbPath,
      MAIL_RETRY_BASE_MS: "10",
      MAIL_DAILY_LIMIT: "500",
      DASHBOARD_LOGIN_USER: "owner",
      DASHBOARD_LOGIN_PASS: "dashboard-pass",
      DASHBOARD_SESSION_SECRET: "dashboard-session-secret",
      DASHBOARD_OTP_TO: "owner@example.com",
      DASHBOARD_ALLOWED_IPS: "127.0.0.1",
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

  try {
    const unauth = await request(app)
      .post("/api/v1/mail/send")
      .send({ to: "user@example.com", subject: "x", text: "x" });

    assert.equal(unauth.status, 401);

    const forbidden = await request(app)
      .post("/api/v1/mail/send")
      .set("Authorization", "Bearer test-token")
      .set("x-test-remote-address", "203.0.113.10")
      .send({ to: "user@example.com", subject: "x", text: "x" });

    assert.equal(forbidden.status, 403);

    const ok = await request(app)
      .post("/api/v1/mail/send")
      .set("Authorization", "Bearer test-token")
      .send({
        to: "user@example.com",
        subject: "System OK",
        text: "Mail API success",
        category: "system-alert",
      });

    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, "sent");
    assert.ok(ok.body.requestId);

    const health = await request(app)
      .get("/api/v1/mail/health")
      .set("Authorization", "Bearer test-token");

    assert.equal(health.status, 200);
    assert.equal(health.body.relay.ok, true);
  } finally {
    await core.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
