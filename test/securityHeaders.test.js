const test = require("node:test");
const assert = require("node:assert/strict");
const { __private } = require("../src/app");

const { buildSecurityHeaders } = __private;

test("buildSecurityHeaders returns report-only CSP and baseline hardening headers", () => {
  const headers = buildSecurityHeaders({
    env: {
      DASHBOARD_CSP_ENFORCE: false,
      DASHBOARD_HSTS_MAX_AGE: 86400,
    },
    isSecureRequest: false,
  });

  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["Referrer-Policy"], "no-referrer");
  assert.equal(headers["Cross-Origin-Opener-Policy"], "same-origin");
  assert.equal(headers["Cross-Origin-Resource-Policy"], "same-origin");
  assert.equal(typeof headers["Content-Security-Policy-Report-Only"], "string");
  assert.ok(headers["Content-Security-Policy-Report-Only"].includes("default-src 'self'"));
  assert.equal(headers["Content-Security-Policy"], undefined);
  assert.equal(headers["Strict-Transport-Security"], undefined);
});

test("buildSecurityHeaders enables enforced CSP and staged HSTS on secure requests", () => {
  const headers = buildSecurityHeaders({
    env: {
      DASHBOARD_CSP_ENFORCE: true,
      DASHBOARD_HSTS_MAX_AGE: 86400,
    },
    isSecureRequest: true,
  });

  assert.equal(typeof headers["Content-Security-Policy"], "string");
  assert.equal(
    headers["Content-Security-Policy"],
    headers["Content-Security-Policy-Report-Only"]
  );
  assert.equal(headers["Strict-Transport-Security"], "max-age=86400; includeSubDomains");
});
