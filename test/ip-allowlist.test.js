const test = require("node:test");
const assert = require("node:assert/strict");
const { createIpAllowlistMiddleware, normalizeIp } = require("../src/dashboard/middleware/ipAllowlist");

test("normalizeIp handles ipv6-mapped and forwarded forms", () => {
  assert.equal(normalizeIp("::ffff:127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeIp("203.0.113.10, 10.0.0.1"), "203.0.113.10");
});

test("allowlist middleware blocks non-allowlisted ip", async () => {
  const middleware = createIpAllowlistMiddleware({
    allowedIps: ["127.0.0.1"],
  });

  const req = {
    ip: "203.0.113.55",
    socket: {
      remoteAddress: "203.0.113.55",
    },
  };

  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };

  let nextCalled = false;
  await middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "FORBIDDEN_IP");
});
