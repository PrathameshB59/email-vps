const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateBackoffMs, classifyDeliveryError } = require("../src/mail/deliveryPolicy");

test("classifyDeliveryError identifies transient network errors", () => {
  const transient = classifyDeliveryError({ code: "ECONNECTION", message: "down" });
  assert.equal(transient.transient, true);
});

test("classifyDeliveryError identifies non-transient unknown errors", () => {
  const permanent = classifyDeliveryError({ code: "EAUTH", message: "auth failed" });
  assert.equal(permanent.transient, false);
});

test("calculateBackoffMs increases with attempt", () => {
  const a1 = calculateBackoffMs(30000, 1);
  const a2 = calculateBackoffMs(30000, 2);
  assert.ok(a2 > a1);
});
