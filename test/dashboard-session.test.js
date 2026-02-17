const test = require("node:test");
const assert = require("node:assert/strict");
const { createDashboardSessionManager } = require("../src/dashboard/auth/session");

test("dashboard session manager signs and validates cookie payload", () => {
  const manager = createDashboardSessionManager({
    secret: "test-session-secret-value",
    ttlHours: 1,
    cookieName: "dashboard_session",
  });

  const created = manager.createSession({ username: "owner" });
  assert.ok(created.token.includes("."));

  const req = {
    get(name) {
      if (name.toLowerCase() === "cookie") {
        return `dashboard_session=${created.token}`;
      }
      return "";
    },
  };

  const parsed = manager.readSessionFromRequest(req);
  assert.ok(parsed);
  assert.equal(parsed.payload.sub, "owner");

  const tamperedReq = {
    get(name) {
      if (name.toLowerCase() === "cookie") {
        return `dashboard_session=${created.token}tampered`;
      }
      return "";
    },
  };

  const invalid = manager.readSessionFromRequest(tamperedReq);
  assert.equal(invalid, null);
});
