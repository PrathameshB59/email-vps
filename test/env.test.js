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
    MAIL_RETRY_MAX: "4",
    MAIL_RELAY_SECURE: "false",
  });

  assert.equal(parsed.MAIL_DAILY_LIMIT, 500);
  assert.equal(parsed.MAIL_RETRY_MAX, 4);
  assert.equal(parsed.MAIL_RELAY_SECURE, false);
});
