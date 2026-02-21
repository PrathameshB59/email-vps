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
    DASHBOARD_OTP_TO: "owner@example.com",
    DASHBOARD_ALLOWED_IPS: "127.0.0.1,198.51.100.22",
    MAIL_RETRY_MAX: "4",
    MAIL_RELAY_SECURE: "false",
  });

  assert.equal(parsed.MAIL_DAILY_LIMIT, 500);
  assert.equal(parsed.MAIL_RETRY_MAX, 4);
  assert.equal(parsed.MAIL_RELAY_SECURE, false);
  assert.deepEqual(parsed.DASHBOARD_ALLOWED_IPS, ["127.0.0.1", "198.51.100.22"]);
  assert.equal(parsed.DASHBOARD_SESSION_TTL_HOURS, 12);
  assert.equal(parsed.DASHBOARD_AUTH_FLOW, "otp_then_credentials");
  assert.equal(parsed.DASHBOARD_PREAUTH_TTL_MINUTES, 5);
  assert.equal(parsed.DASHBOARD_LOCAL_FALLBACK_ENABLED, true);
  assert.equal(parsed.DASHBOARD_OTP_PRIMARY_ENABLED, true);
  assert.equal(parsed.DASHBOARD_OTP_DIAGNOSTICS_ENABLED, true);
  assert.equal(parsed.DASHBOARD_OPS_DAEMON_ENABLED, false);
  assert.equal(parsed.DASHBOARD_OPS_DAEMON_REQUEST_TTL_SECONDS, 30);
});

test("parseEnv requires daemon hmac secret when daemon mode is enabled", () => {
  assert.throws(
    () =>
      parseEnv({
        MAIL_API_TOKEN: "token-123",
        MAIL_FROM: "Email VPS <noreply@example.com>",
        DASHBOARD_LOGIN_USER: "owner",
        DASHBOARD_LOGIN_PASS: "password-123",
        DASHBOARD_SESSION_SECRET: "dashboard-secret-value",
        DASHBOARD_OTP_TO: "owner@example.com",
        DASHBOARD_OPS_DAEMON_ENABLED: "true",
        DASHBOARD_OPS_DAEMON_HMAC_SECRET: "short",
      }),
    /DASHBOARD_OPS_DAEMON_HMAC_SECRET/
  );
});
