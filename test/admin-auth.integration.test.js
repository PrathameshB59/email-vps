const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createAdminRuntime } = require("../src/admin/runtime");

test("admin auth lifecycle and protected routes", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "email-vps-admin-"));
  const dbPath = path.join(tempDir, "admin.sqlite");

  const transport = {
    async verify() {
      return true;
    },
    async sendMail() {
      return {
        messageId: "admin-test",
        accepted: ["user@example.com"],
        rejected: [],
      };
    },
    close() {},
  };

  const runtime = await createAdminRuntime({
    envOverrides: {
      NODE_ENV: "test",
      DB_PATH: dbPath,
      MAIL_API_TOKEN: "mail-token",
      MAIL_FROM: "Email VPS <noreply@example.com>",
      ADMIN_JWT_ACCESS_SECRET: "1234567890123456-access",
      ADMIN_JWT_REFRESH_SECRET: "1234567890123456-refresh",
      ADMIN_SEED_EMAIL: "admin@example.com",
      ADMIN_SEED_PASSWORD: "StrongPass123!",
      ADMIN_ALLOWED_ORIGIN: "https://mail.stackpilot.in",
    },
    transport,
  });

  try {
    const loginOk = await request(runtime.app)
      .post("/api/v1/admin/auth/login")
      .send({
        email: "admin@example.com",
        password: "StrongPass123!",
      });

    assert.equal(loginOk.status, 200);
    assert.ok(loginOk.body.accessToken);
    assert.ok(loginOk.body.refreshToken);

    const loginFail = await request(runtime.app)
      .post("/api/v1/admin/auth/login")
      .send({
        email: "admin@example.com",
        password: "wrong-pass",
      });

    assert.equal(loginFail.status, 401);

    const noAuth = await request(runtime.app)
      .get("/api/v1/admin/overview");

    assert.equal(noAuth.status, 401);

    const withAuth = await request(runtime.app)
      .get("/api/v1/admin/overview")
      .set("Authorization", `Bearer ${loginOk.body.accessToken}`);

    assert.equal(withAuth.status, 200);
    assert.equal(typeof withAuth.body.sentToday, "number");

    const refreshed = await request(runtime.app)
      .post("/api/v1/admin/auth/refresh")
      .send({ refreshToken: loginOk.body.refreshToken });

    assert.equal(refreshed.status, 200);
    assert.ok(refreshed.body.accessToken);
    assert.ok(refreshed.body.refreshToken);

    const logout = await request(runtime.app)
      .post("/api/v1/admin/auth/logout")
      .send({ refreshToken: refreshed.body.refreshToken });

    assert.equal(logout.status, 200);
  } finally {
    await runtime.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
