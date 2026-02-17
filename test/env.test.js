const test = require("node:test");
const assert = require("node:assert/strict");
const { parseEnv } = require("../src/config/env");

test("parseEnv throws when required secrets are missing", () => {
  assert.throws(() => parseEnv({}), /MAIL_API_TOKEN/);
});

test("parseEnv applies defaults and coercion", () => {
  const parsed = parseEnv({
    MAIL_API_TOKEN: "token-123",
    MAIL_FROM: "Email VPS <noreply@example.com>",
    DASHBOARD_LOGIN_USER: "owner",
    DASHBOARD_LOGIN_PASS: "password-123",
    DASHBOARD_SESSION_SECRET: "dashboard-secret-value",
    DASHBOARD_ALLOWED_IPS: "127.0.0.1,198.51.100.22",
    MAIL_RETRY_MAX: "4",
    MAIL_RELAY_SECURE: "false",
  });

  assert.equal(parsed.MAIL_DAILY_LIMIT, 500);
  assert.equal(parsed.MAIL_RETRY_MAX, 4);
  assert.equal(parsed.MAIL_RELAY_SECURE, false);
  assert.deepEqual(parsed.DASHBOARD_ALLOWED_IPS, ["127.0.0.1", "198.51.100.22"]);
  assert.equal(parsed.DASHBOARD_SESSION_TTL_HOURS, 12);
});
