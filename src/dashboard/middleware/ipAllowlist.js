function normalizeIp(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const primary = raw.split(",")[0].trim();
  const noZone = primary.split("%")[0];

  if (noZone.startsWith("::ffff:")) {
    return noZone.slice(7);
  }

  return noZone;
}

function resolveRequestIp(req) {
  return normalizeIp(req.ip || req.socket?.remoteAddress || "");
}

function createIpAllowlistMiddleware({ allowedIps }) {
  const allowSet = new Set((allowedIps || []).map(normalizeIp).filter(Boolean));

  return function ipAllowlist(req, res, next) {
    const requestIp = resolveRequestIp(req);

    if (!allowSet.has(requestIp)) {
      return res.status(403).json({
        error: "FORBIDDEN_IP",
        message: "Dashboard access is not allowed from this IP.",
      });
    }

    req.dashboardClientIp = requestIp;
    return next();
  };
}

module.exports = {
  createIpAllowlistMiddleware,
  normalizeIp,
  resolveRequestIp,
};
