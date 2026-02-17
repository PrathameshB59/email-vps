const test = require("node:test");
const assert = require("node:assert/strict");
const {
  computeRiskScore,
  parseLoad1m,
  parseMemoryUsedPct,
  parsePercent,
  riskLevelFromScore,
} = require("../src/dashboard/services/metrics");

test("metric parsers extract expected values", () => {
  assert.equal(parsePercent("82%"), 82);
  assert.equal(parseLoad1m(" 1.18, 0.58, 0.29"), 1.18);
  assert.equal(parseMemoryUsedPct("6Gi", "8Gi"), 75);
});

test("risk scoring classifies elevated conditions", () => {
  const score = computeRiskScore({
    baseRisk: "WARNING",
    relayOk: false,
    diskPct: 91,
    sshFails: 1200,
    queueFailed: 3,
    queueRetrying: 15,
    quotaUsed: 490,
    quotaLimit: 500,
  });

  assert.equal(score >= 80, true);
  assert.equal(riskLevelFromScore(score), "critical");
});
