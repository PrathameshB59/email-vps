const { createTokenService } = require("../auth/tokenService");

function createAdminAuthMiddleware({ env }) {
  const tokenService = createTokenService(env);

  return function adminAuth(req, res, next) {
    const raw = req.get("authorization") || "";
    const [scheme, token] = raw.split(" ");

    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({
        error: "ADMIN_UNAUTHORIZED",
        message: "Admin bearer token is required.",
      });
    }

    try {
      const payload = tokenService.verifyAccessToken(token);
      req.admin = {
        id: Number(payload.sub),
        email: payload.email,
        role: payload.role,
      };
      return next();
    } catch (error) {
      return res.status(401).json({
        error: error.code || "ADMIN_UNAUTHORIZED",
        message: error.message || "Invalid admin token.",
      });
    }
  };
}

module.exports = {
  createAdminAuthMiddleware,
};
