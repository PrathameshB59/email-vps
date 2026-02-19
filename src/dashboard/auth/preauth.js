const crypto = require("crypto");
const { parseCookies } = require("./session");

function hmacSha256(input, secret) {
  return crypto.createHmac("sha256", String(secret)).update(String(input)).digest("base64url");
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload(raw) {
  try {
    const text = Buffer.from(String(raw), "base64url").toString("utf8");
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function createDashboardPreAuthManager({
  secret,
  ttlMinutes,
  cookieName = "email_vps_dashboard_preauth",
}) {
  const ttlMs = Number(ttlMinutes) * 60 * 1000;

  function sign(payload) {
    const encodedPayload = encodePayload(payload);
    const signature = hmacSha256(encodedPayload, secret);
    return `${encodedPayload}.${signature}`;
  }

  function verify(token) {
    if (!token || typeof token !== "string" || !token.includes(".")) {
      return null;
    }

    const [encodedPayload, signature] = token.split(".");
    if (!encodedPayload || !signature) {
      return null;
    }

    const expected = hmacSha256(encodedPayload, secret);
    if (!timingSafeEqual(signature, expected)) {
      return null;
    }

    const payload = decodePayload(encodedPayload);
    if (!payload || typeof payload !== "object") {
      return null;
    }

    if (String(payload.phase || "") !== "otp_verified") {
      return null;
    }

    const exp = Number(payload.exp || 0);
    if (!Number.isFinite(exp) || Date.now() >= exp) {
      return null;
    }

    return payload;
  }

  function createPreAuth({ challengeId, subject }) {
    const issuedAt = Date.now();
    const payload = {
      cid: String(challengeId || ""),
      sub: String(subject || ""),
      phase: "otp_verified",
      iat: issuedAt,
      exp: issuedAt + ttlMs,
    };

    return {
      token: sign(payload),
      payload,
    };
  }

  function readPreAuthFromRequest(req) {
    const cookies = parseCookies(req.get("cookie") || "");
    const token = cookies[cookieName] || null;
    const payload = verify(token);
    if (!payload) {
      return null;
    }

    return {
      token,
      payload,
    };
  }

  function setPreAuthCookie(res, token, { secure }) {
    res.cookie(cookieName, token, {
      httpOnly: true,
      secure: Boolean(secure),
      sameSite: "strict",
      path: "/",
      maxAge: ttlMs,
    });
  }

  function clearPreAuthCookie(res, { secure }) {
    res.clearCookie(cookieName, {
      httpOnly: true,
      secure: Boolean(secure),
      sameSite: "strict",
      path: "/",
    });
  }

  return {
    cookieName,
    ttlMs,
    createPreAuth,
    readPreAuthFromRequest,
    setPreAuthCookie,
    clearPreAuthCookie,
  };
}

module.exports = {
  createDashboardPreAuthManager,
};
