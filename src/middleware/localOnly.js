const LOOPBACK_ADDRESSES = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);

function createLocalOnlyMiddleware({ allowNonLocal, allowTestHeader = false }) {
  return function localOnly(req, res, next) {
    if (allowNonLocal) {
      return next();
    }

    const testHeaderIp = allowTestHeader ? req.get("x-test-remote-address") : null;
    const resolvedIp = testHeaderIp || req.ip || req.socket?.remoteAddress || "";
    const ip = String(resolvedIp).startsWith("::ffff:")
      ? String(resolvedIp).slice(7)
      : String(resolvedIp);

    if (!LOOPBACK_ADDRESSES.has(ip)) {
      return res.status(403).json({
        error: "FORBIDDEN_NON_LOCAL",
        message: "Mail API accepts loopback requests only.",
      });
    }

    return next();
  };
}

module.exports = {
  createLocalOnlyMiddleware,
};
