const crypto = require("crypto");

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function createAuthTokenMiddleware(expectedToken) {
  return function authToken(req, res, next) {
    const raw = req.get("authorization") || "";
    const [scheme, token] = raw.split(" ");

    if (scheme !== "Bearer" || !token || !timingSafeEqual(token, expectedToken)) {
      return res.status(401).json({
        error: "UNAUTHORIZED",
        message: "Bearer token is missing or invalid.",
      });
    }

    return next();
  };
}

module.exports = {
  createAuthTokenMiddleware,
};
