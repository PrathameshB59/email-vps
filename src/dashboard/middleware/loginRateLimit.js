function nowMs() {
  return Date.now();
}

function createDashboardLoginRateLimiter({
  maxAttempts,
  windowMs,
  lockoutMinutes,
}) {
  const lockoutMs = Number(lockoutMinutes) * 60 * 1000;
  const states = new Map();

  function cleanupIfExpired(ip, state) {
    if (!state) {
      return null;
    }

    if (state.lockedUntil && state.lockedUntil > nowMs()) {
      return state;
    }

    if (state.windowStart + windowMs < nowMs()) {
      states.delete(ip);
      return null;
    }

    return state;
  }

  function getState(ip) {
    const normalizedIp = String(ip || "unknown");
    const existing = states.get(normalizedIp);
    const active = cleanupIfExpired(normalizedIp, existing);

    if (!active) {
      return {
        ip: normalizedIp,
        failures: 0,
        lockedUntil: null,
      };
    }

    return {
      ip: normalizedIp,
      failures: active.failures,
      lockedUntil: active.lockedUntil || null,
    };
  }

  function assertAllowed(ip) {
    const normalizedIp = String(ip || "unknown");
    const existing = cleanupIfExpired(normalizedIp, states.get(normalizedIp));

    if (!existing) {
      return {
        allowed: true,
      };
    }

    if (existing.lockedUntil && existing.lockedUntil > nowMs()) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(Math.ceil((existing.lockedUntil - nowMs()) / 1000), 1),
      };
    }

    return {
      allowed: true,
    };
  }

  function recordFailure(ip) {
    const normalizedIp = String(ip || "unknown");
    const existing = cleanupIfExpired(normalizedIp, states.get(normalizedIp));
    const currentTime = nowMs();

    const state = existing
      ? { ...existing }
      : {
          windowStart: currentTime,
          failures: 0,
          lockedUntil: null,
        };

    if (state.windowStart + windowMs < currentTime) {
      state.windowStart = currentTime;
      state.failures = 0;
      state.lockedUntil = null;
    }

    state.failures += 1;

    if (state.failures >= maxAttempts) {
      state.lockedUntil = currentTime + lockoutMs;
      state.failures = 0;
      state.windowStart = currentTime;
    }

    states.set(normalizedIp, state);
    return getState(normalizedIp);
  }

  function recordSuccess(ip) {
    const normalizedIp = String(ip || "unknown");
    states.delete(normalizedIp);
  }

  return {
    assertAllowed,
    recordFailure,
    recordSuccess,
    getState,
  };
}

module.exports = {
  createDashboardLoginRateLimiter,
};
