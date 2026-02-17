const TRANSIENT_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ECONNECTION",
  "ECONNRESET",
  "EHOSTUNREACH",
  "EPIPE",
  "ESOCKET",
  "ETEMPFAIL",
]);

function classifyDeliveryError(error) {
  const code = error && (error.code || error.responseCode || error.statusCode);
  const responseCode = typeof error?.responseCode === "number" ? error.responseCode : null;

  let transient = false;

  if (typeof code === "string" && TRANSIENT_ERROR_CODES.has(code)) {
    transient = true;
  }

  if (responseCode !== null && responseCode >= 400 && responseCode < 500) {
    transient = true;
  }

  if (responseCode !== null && responseCode >= 500) {
    transient = true;
  }

  return {
    transient,
    code: typeof code === "string" ? code : (responseCode !== null ? String(responseCode) : "UNKNOWN_ERROR"),
    message: error?.message || "Unknown email delivery error",
  };
}

function calculateBackoffMs(baseMs, attemptNumber) {
  const safeAttempt = Math.max(1, attemptNumber);
  const multiplier = Math.pow(2, safeAttempt - 1);
  const jitter = Math.floor(baseMs * 0.1);
  return baseMs * multiplier + jitter;
}

module.exports = {
  calculateBackoffMs,
  classifyDeliveryError,
};
