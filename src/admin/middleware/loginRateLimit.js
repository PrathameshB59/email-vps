function createLoginRateLimitMiddleware({ maxRequests, windowMs }) {
  const buckets = new Map();

  return function loginRateLimit(req, res, next) {
    const ip = req.socket?.remoteAddress || req.ip || "unknown";
    const now = Date.now();

    const current = buckets.get(ip) || [];
    const fresh = current.filter((timestamp) => now - timestamp < windowMs);

    if (fresh.length >= maxRequests) {
      return res.status(429).json({
        error: "ADMIN_LOGIN_RATE_LIMITED",
        message: "Too many login attempts. Try again later.",
      });
    }

    fresh.push(now);
    buckets.set(ip, fresh);
    return next();
  };
}

module.exports = {
  createLoginRateLimitMiddleware,
};
