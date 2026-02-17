const crypto = require("crypto");

function parseCookies(cookieHeader) {
  if (!cookieHeader || typeof cookieHeader !== "string") {
    return {};
  }

  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, chunk) => {
      const [name, ...rest] = chunk.split("=");
      if (!name || rest.length === 0) {
        return acc;
      }

      acc[name] = decodeURIComponent(rest.join("="));
      return acc;
    }, {});
}

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

function createDashboardSessionManager({
  secret,
  ttlHours,
  cookieName = "email_vps_dashboard",
}) {
  const ttlMs = Number(ttlHours) * 60 * 60 * 1000;

  function signSession(payload) {
    const encodedPayload = encodePayload(payload);
    const signature = hmacSha256(encodedPayload, secret);
    return `${encodedPayload}.${signature}`;
  }

  function verifySession(token) {
    if (!token || typeof token !== "string" || !token.includes(".")) {
      return null;
    }

    const [encodedPayload, signature] = token.split(".");
    if (!encodedPayload || !signature) {
      return null;
    }

    const expectedSignature = hmacSha256(encodedPayload, secret);
    if (!timingSafeEqual(signature, expectedSignature)) {
      return null;
    }

    const payload = decodePayload(encodedPayload);
    if (!payload || typeof payload !== "object") {
      return null;
    }

    const exp = Number(payload.exp || 0);
    if (!Number.isFinite(exp) || Date.now() >= exp) {
      return null;
    }

    return payload;
  }

  function createSession({ username }) {
    const issuedAt = Date.now();
    const payload = {
      sub: String(username),
      iat: issuedAt,
      exp: issuedAt + ttlMs,
    };

    return {
      token: signSession(payload),
      payload,
    };
  }

  function readSessionFromRequest(req) {
    const cookies = parseCookies(req.get("cookie") || "");
    const token = cookies[cookieName] || null;
    const payload = verifySession(token);

    if (!payload) {
      return null;
    }

    return {
      token,
      payload,
    };
  }

  function setSessionCookie(res, token, { secure }) {
    res.cookie(cookieName, token, {
      httpOnly: true,
      secure: Boolean(secure),
      sameSite: "strict",
      path: "/",
      maxAge: ttlMs,
    });
  }

  function clearSessionCookie(res, { secure }) {
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
    createSession,
    readSessionFromRequest,
    setSessionCookie,
    clearSessionCookie,
  };
}

module.exports = {
  createDashboardSessionManager,
  parseCookies,
};
