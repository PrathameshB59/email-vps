const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { AdminAuthError } = require("../errors");

function parseDurationMs(input) {
  const value = String(input || "").trim();
  const matched = value.match(/^(\d+)([smhd])$/i);
  if (!matched) {
    throw new Error(`Invalid duration format: ${value}. Expected values like 15m, 7d.`);
  }

  const amount = Number(matched[1]);
  const unit = matched[2].toLowerCase();

  if (unit === "s") return amount * 1000;
  if (unit === "m") return amount * 60 * 1000;
  if (unit === "h") return amount * 60 * 60 * 1000;
  return amount * 24 * 60 * 60 * 1000;
}

function sha256(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function createTokenService(env) {
  const accessSecret = env.ADMIN_JWT_ACCESS_SECRET;
  const refreshSecret = env.ADMIN_JWT_REFRESH_SECRET;

  function signAccessToken(user) {
    return jwt.sign(
      {
        sub: String(user.id),
        role: user.role,
        email: user.email,
        typ: "access",
      },
      accessSecret,
      {
        expiresIn: env.ADMIN_ACCESS_TTL,
        issuer: "email-vps-admin",
      }
    );
  }

  function signRefreshToken(user, sessionId) {
    return jwt.sign(
      {
        sub: String(user.id),
        role: user.role,
        sid: String(sessionId),
        typ: "refresh",
      },
      refreshSecret,
      {
        expiresIn: env.ADMIN_REFRESH_TTL,
        issuer: "email-vps-admin",
      }
    );
  }

  function verifyAccessToken(token) {
    try {
      const payload = jwt.verify(String(token || ""), accessSecret, {
        issuer: "email-vps-admin",
      });

      if (payload.typ !== "access") {
        throw new Error("Invalid token type");
      }

      return payload;
    } catch (error) {
      throw new AdminAuthError("Invalid access token.", "INVALID_ACCESS_TOKEN", 401);
    }
  }

  function verifyRefreshToken(token) {
    try {
      const payload = jwt.verify(String(token || ""), refreshSecret, {
        issuer: "email-vps-admin",
      });

      if (payload.typ !== "refresh") {
        throw new Error("Invalid token type");
      }

      return payload;
    } catch (error) {
      throw new AdminAuthError("Invalid refresh token.", "INVALID_REFRESH_TOKEN", 401);
    }
  }

  function refreshExpiryIso(fromDate = Date.now()) {
    return new Date(fromDate + parseDurationMs(env.ADMIN_REFRESH_TTL)).toISOString();
  }

  return {
    sha256,
    signAccessToken,
    signRefreshToken,
    verifyAccessToken,
    verifyRefreshToken,
    refreshExpiryIso,
  };
}

module.exports = {
  createTokenService,
  parseDurationMs,
  sha256,
};
