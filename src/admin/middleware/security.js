const helmet = require("helmet");

function createCorsMiddleware({ allowedOrigin }) {
  return function corsGuard(req, res, next) {
    const origin = req.get("origin");

    if (origin) {
      if (origin !== allowedOrigin) {
        return res.status(403).json({
          error: "ADMIN_CORS_BLOCKED",
          message: "Origin is not allowed.",
        });
      }

      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }

    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      return res.status(204).send();
    }

    return next();
  };
}

function createSecurityMiddleware() {
  return helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });
}

module.exports = {
  createCorsMiddleware,
  createSecurityMiddleware,
};
