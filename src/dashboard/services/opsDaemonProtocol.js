const crypto = require("crypto");

function coercePositiveInt(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return Math.trunc(numeric);
}

function createNonceReplayCache({ ttlSeconds = 30, maxEntries = 20000 } = {}) {
  const ttl = coercePositiveInt(ttlSeconds, 30);
  const max = coercePositiveInt(maxEntries, 20000);
  const nonceMap = new Map();

  function prune(nowEpochSeconds) {
    const now = Number(nowEpochSeconds) || Math.floor(Date.now() / 1000);
    for (const [nonce, expiresAt] of nonceMap.entries()) {
      if (expiresAt <= now) {
        nonceMap.delete(nonce);
      }
    }
    while (nonceMap.size > max) {
      const firstKey = nonceMap.keys().next().value;
      if (!firstKey) {
        break;
      }
      nonceMap.delete(firstKey);
    }
  }

  function has(nonce, nowEpochSeconds) {
    prune(nowEpochSeconds);
    return nonceMap.has(String(nonce || ""));
  }

  function remember(nonce, nowEpochSeconds) {
    const now = Number(nowEpochSeconds) || Math.floor(Date.now() / 1000);
    const safeNonce = String(nonce || "");
    nonceMap.set(safeNonce, now + ttl);
    prune(now);
  }

  return {
    has,
    remember,
    prune,
  };
}

function createSignature(payload, secret) {
  return crypto
    .createHmac("sha256", String(secret || ""))
    .update(JSON.stringify(payload))
    .digest("hex");
}

function timingSafeHexEqual(a, b) {
  const left = Buffer.from(String(a || ""), "hex");
  const right = Buffer.from(String(b || ""), "hex");
  if (left.length !== right.length || left.length === 0) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function createOpsDaemonEnvelope({
  action,
  runId,
  requestedByUser = null,
  requestedByIp = null,
  timeoutSeconds = null,
  ttlSeconds = 30,
  secret,
  nowEpochSeconds = null,
  nonce = null,
} = {}) {
  const timestamp = Number.isFinite(Number(nowEpochSeconds))
    ? Math.trunc(Number(nowEpochSeconds))
    : Math.floor(Date.now() / 1000);

  const payload = {
    action: String(action || "").trim(),
    timestamp,
    nonce: String(nonce || crypto.randomBytes(16).toString("hex")),
    runId: String(runId || ""),
    requestedByUser: requestedByUser ? String(requestedByUser) : null,
    requestedByIp: requestedByIp ? String(requestedByIp) : null,
    timeoutSeconds:
      Number.isFinite(Number(timeoutSeconds)) && Number(timeoutSeconds) > 0
        ? Math.trunc(Number(timeoutSeconds))
        : null,
    ttlSeconds: coercePositiveInt(ttlSeconds, 30),
  };

  return {
    version: 1,
    payload,
    signature: createSignature(payload, secret),
  };
}

function createProtocolError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function verifyOpsDaemonEnvelope(envelope, {
  secret,
  nowEpochSeconds = null,
  replayCache = null,
  maxSkewSeconds = 30,
} = {}) {
  if (!envelope || typeof envelope !== "object") {
    throw createProtocolError("OPS_DAEMON_PROTOCOL_INVALID", "Envelope payload is required.");
  }

  const payload = envelope.payload;
  if (!payload || typeof payload !== "object") {
    throw createProtocolError("OPS_DAEMON_PROTOCOL_INVALID", "Envelope payload object is required.");
  }

  const receivedSignature = String(envelope.signature || "");
  if (!receivedSignature) {
    throw createProtocolError("OPS_DAEMON_SIGNATURE_MISSING", "Envelope signature is required.");
  }

  const expectedSignature = createSignature(payload, secret);
  if (!timingSafeHexEqual(receivedSignature, expectedSignature)) {
    throw createProtocolError("OPS_DAEMON_SIGNATURE_INVALID", "Invalid command signature.", 403);
  }

  const now = Number.isFinite(Number(nowEpochSeconds))
    ? Math.trunc(Number(nowEpochSeconds))
    : Math.floor(Date.now() / 1000);
  const timestamp = Number(payload.timestamp);
  const ttlFromPayload = coercePositiveInt(payload.ttlSeconds, coercePositiveInt(maxSkewSeconds, 30));
  const maxAge = Math.min(Math.max(ttlFromPayload, 1), 120);
  const skew = Math.abs(now - Math.trunc(timestamp));
  if (!Number.isFinite(timestamp) || skew > maxAge) {
    throw createProtocolError(
      "OPS_DAEMON_TIMESTAMP_INVALID",
      `Command timestamp outside allowed window (${maxAge}s).`,
      403
    );
  }

  const nonce = String(payload.nonce || "");
  if (!/^[a-f0-9]{16,128}$/i.test(nonce)) {
    throw createProtocolError("OPS_DAEMON_NONCE_INVALID", "Command nonce is invalid.", 403);
  }

  if (replayCache) {
    if (replayCache.has(nonce, now)) {
      throw createProtocolError("OPS_DAEMON_REPLAY_DETECTED", "Replay detected for command nonce.", 409);
    }
    replayCache.remember(nonce, now);
  }

  if (!String(payload.action || "").trim()) {
    throw createProtocolError("OPS_DAEMON_ACTION_REQUIRED", "Command action is required.");
  }

  return payload;
}

module.exports = {
  coercePositiveInt,
  createNonceReplayCache,
  createOpsDaemonEnvelope,
  verifyOpsDaemonEnvelope,
  createSignature,
};

