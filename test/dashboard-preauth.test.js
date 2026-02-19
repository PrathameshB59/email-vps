const test = require("node:test");
const assert = require("node:assert/strict");
const { createDashboardPreAuthManager } = require("../src/dashboard/auth/preauth");

test("dashboard preauth manager signs and validates preauth payload", () => {
  const manager = createDashboardPreAuthManager({
    secret: "test-dashboard-preauth-secret",
    ttlMinutes: 5,
    cookieName: "dashboard_preauth",
  });

  const created = manager.createPreAuth({
    challengeId: "challenge-1",
    subject: "owner",
  });

  const req = {
    get(header) {
      if (header.toLowerCase() !== "cookie") return "";
      return `dashboard_preauth=${created.token}`;
    },
  };

  const parsed = manager.readPreAuthFromRequest(req);
  assert.ok(parsed);
  assert.equal(parsed.payload.cid, "challenge-1");
  assert.equal(parsed.payload.sub, "owner");
  assert.equal(parsed.payload.phase, "otp_verified");
});

test("dashboard preauth manager rejects tampered token", () => {
  const manager = createDashboardPreAuthManager({
    secret: "test-dashboard-preauth-secret",
    ttlMinutes: 5,
    cookieName: "dashboard_preauth",
  });

  const created = manager.createPreAuth({
    challengeId: "challenge-1",
    subject: "owner",
  });

  const req = {
    get(header) {
      if (header.toLowerCase() !== "cookie") return "";
      return `dashboard_preauth=${created.token}tamper`;
    },
  };

  const parsed = manager.readPreAuthFromRequest(req);
  assert.equal(parsed, null);
});
