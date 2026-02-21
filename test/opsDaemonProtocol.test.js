const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createNonceReplayCache,
  createOpsDaemonEnvelope,
  verifyOpsDaemonEnvelope,
} = require("../src/dashboard/services/opsDaemonProtocol");

test("ops daemon protocol signs and verifies envelope payload", () => {
  const secret = "test-daemon-secret-1234567890";
  const now = 1_700_000_000;
  const envelope = createOpsDaemonEnvelope({
    action: "aide_check",
    runId: "run-1",
    requestedByUser: "owner",
    requestedByIp: "127.0.0.1",
    timeoutSeconds: 120,
    ttlSeconds: 30,
    nowEpochSeconds: now,
    nonce: "abcdef1234567890",
    secret,
  });

  const cache = createNonceReplayCache({ ttlSeconds: 30 });
  const payload = verifyOpsDaemonEnvelope(envelope, {
    secret,
    replayCache: cache,
    nowEpochSeconds: now + 10,
    maxSkewSeconds: 30,
  });

  assert.equal(payload.action, "aide_check");
  assert.equal(payload.runId, "run-1");
  assert.equal(payload.nonce, "abcdef1234567890");
});

test("ops daemon protocol rejects stale timestamp", () => {
  const secret = "test-daemon-secret-1234567890";
  const now = 1_700_000_000;
  const envelope = createOpsDaemonEnvelope({
    action: "aide_check",
    nowEpochSeconds: now - 45,
    nonce: "1111111111111111",
    secret,
  });

  assert.throws(
    () =>
      verifyOpsDaemonEnvelope(envelope, {
        secret,
        nowEpochSeconds: now,
        maxSkewSeconds: 30,
      }),
    /timestamp outside allowed window/i
  );
});

test("ops daemon protocol rejects replayed nonce", () => {
  const secret = "test-daemon-secret-1234567890";
  const now = 1_700_000_000;
  const envelope = createOpsDaemonEnvelope({
    action: "aide_check",
    nowEpochSeconds: now,
    nonce: "2222222222222222",
    secret,
  });

  const cache = createNonceReplayCache({ ttlSeconds: 30 });
  verifyOpsDaemonEnvelope(envelope, {
    secret,
    replayCache: cache,
    nowEpochSeconds: now,
    maxSkewSeconds: 30,
  });

  assert.throws(
    () =>
      verifyOpsDaemonEnvelope(envelope, {
        secret,
        replayCache: cache,
        nowEpochSeconds: now + 1,
        maxSkewSeconds: 30,
      }),
    /replay detected/i
  );
});

test("ops daemon protocol rejects signature mismatch", () => {
  const secret = "test-daemon-secret-1234567890";
  const now = 1_700_000_000;
  const envelope = createOpsDaemonEnvelope({
    action: "aide_check",
    nowEpochSeconds: now,
    nonce: "3333333333333333",
    secret,
  });
  envelope.signature = "deadbeef";

  assert.throws(
    () =>
      verifyOpsDaemonEnvelope(envelope, {
        secret,
        nowEpochSeconds: now,
        maxSkewSeconds: 30,
      }),
    /invalid command signature/i
  );
});

