const crypto = require("crypto");
const { parseCookies } = require("../auth/session");

function quotaDateIso() {
  return new Date().toISOString().slice(0, 10);
}

function nowMs() {
  return Date.now();
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

function maskEmail(value) {
  const email = String(value || "").trim();
  const [local, domain] = email.split("@");
  if (!local || !domain) {
    return "hidden";
  }
  if (local.length <= 2) {
    return `${local[0] || "*"}***@${domain}`;
  }
  return `${local.slice(0, 2)}***@${domain}`;
}

function extractEmailAddress(value) {
  const input = String(value || "").trim();
  if (!input) {
    return "";
  }

  const match = input.match(/<([^>]+)>/);
  if (match && match[1]) {
    return String(match[1]).trim().toLowerCase();
  }

  return input.toLowerCase();
}

function randomDigits(length) {
  const chars = [];
  for (let index = 0; index < Number(length); index += 1) {
    chars.push(String(crypto.randomInt(0, 10)));
  }
  return chars.join("");
}

function hmacCodeHash(secret, challengeId, code) {
  return crypto
    .createHmac("sha256", String(secret))
    .update(`${String(challengeId)}:${String(code)}`)
    .digest("hex");
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

class OtpAuthError extends Error {
  constructor({ code, message, statusCode = 400, retryAfterSeconds = null, otpRequestId = null }) {
    super(message);
    this.name = "OtpAuthError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryAfterSeconds = retryAfterSeconds;
    this.otpRequestId = otpRequestId;
  }
}

function createInMemoryWindowLimiter({ limit, windowMs }) {
  const states = new Map();

  function assertAllowed(key) {
    const normalizedKey = String(key || "unknown");
    const current = nowMs();
    const state = states.get(normalizedKey) || { count: 0, windowStart: current };

    if (state.windowStart + Number(windowMs) <= current) {
      states.set(normalizedKey, { count: 0, windowStart: current });
      return {
        allowed: true,
      };
    }

    if (state.count >= Number(limit)) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((state.windowStart + Number(windowMs) - current) / 1000)
      );
      return {
        allowed: false,
        retryAfterSeconds,
      };
    }

    return {
      allowed: true,
    };
  }

  function consume(key) {
    const normalizedKey = String(key || "unknown");
    const current = nowMs();
    const state = states.get(normalizedKey) || { count: 0, windowStart: current };

    if (state.windowStart + Number(windowMs) <= current) {
      states.set(normalizedKey, { count: 1, windowStart: current });
      return;
    }

    state.count += 1;
    states.set(normalizedKey, state);
  }

  return {
    assertAllowed,
    consume,
  };
}

function createOtpAuthService({ env, repository, transport, logger = console }) {
  const challengeCookieName = "email_vps_dashboard_otp";
  const ttlMs = Number(env.DASHBOARD_OTP_TTL_MINUTES) * 60 * 1000;
  const resendCooldownMs = Number(env.DASHBOARD_OTP_RESEND_COOLDOWN_SECONDS) * 1000;
  const otpFrom = String(env.DASHBOARD_OTP_FROM || env.MAIL_FROM || "").trim() || env.MAIL_FROM;
  const senderEmail = extractEmailAddress(otpFrom);
  const recipientEmail = extractEmailAddress(env.DASHBOARD_OTP_TO);

  if (senderEmail && recipientEmail && senderEmail === recipientEmail && env.NODE_ENV !== "test") {
    logger.warn(
      "[otp] DASHBOARD_OTP_TO matches sender account. Use a separate mailbox for OTP delivery visibility."
    );
  }

  const requestLimiter = createInMemoryWindowLimiter({
    limit: env.DASHBOARD_OTP_REQUEST_RATE_LIMIT,
    windowMs: env.DASHBOARD_OTP_REQUEST_RATE_WINDOW_MS,
  });

  function readChallengeIdFromRequest(req) {
    const cookies = parseCookies(req.get("cookie") || "");
    return String(cookies[challengeCookieName] || "").trim() || null;
  }

  function setChallengeCookie(res, challengeId, { secure }) {
    res.cookie(challengeCookieName, challengeId, {
      httpOnly: true,
      secure: Boolean(secure),
      sameSite: "strict",
      path: "/",
      maxAge: ttlMs,
    });
  }

  function clearChallengeCookie(res, { secure }) {
    res.clearCookie(challengeCookieName, {
      httpOnly: true,
      secure: Boolean(secure),
      sameSite: "strict",
      path: "/",
    });
  }

  function getOtpMailPayload({ code, expiresMinutes, otpRequestId }) {
    const safeCode = String(code || "");
    const expiresText = `${expiresMinutes} minute${expiresMinutes === 1 ? "" : "s"}`;
    const requestId = String(otpRequestId || "");

    const subject = "[Email-VPS] One-Time Login Code";
    const text = [
      "Email-VPS Dashboard OTP",
      "",
      `Your verification code is: ${safeCode}`,
      `This code expires in ${expiresText}.`,
      requestId ? `Request ID: ${requestId}` : null,
      "",
      "If you did not request this code, ignore this email.",
    ]
      .filter(Boolean)
      .join("\n");

    const html = `
      <div style="font-family:Segoe UI,Tahoma,sans-serif;background:#081426;color:#eaf5ff;padding:20px;">
        <div style="max-width:520px;margin:0 auto;border:1px solid #1f3f63;border-radius:14px;background:#0c1f35;padding:20px;">
          <h2 style="margin:0 0 12px;color:#ffffff;">Email-VPS Login Verification</h2>
          <p style="margin:0 0 12px;color:#b9d2e9;">Use this one-time code to sign in:</p>
          <div style="display:inline-block;font-size:32px;letter-spacing:0.2em;font-weight:800;color:#7fe9d8;background:#06223a;border:1px solid #2b587c;border-radius:10px;padding:8px 14px;">
            ${safeCode}
          </div>
          <p style="margin:14px 0 0;color:#9fbad3;">This code expires in ${expiresText}.</p>
          ${requestId ? `<p style="margin:8px 0 0;color:#9fbad3;">Request ID: ${requestId}</p>` : ""}
          <p style="margin:8px 0 0;color:#9fbad3;">If you did not request this code, ignore this email.</p>
        </div>
      </div>
    `;

    return { subject, text, html };
  }

  async function requestOtp({ requestIp = null, userAgent = null }) {
    if (!env.DASHBOARD_OTP_PRIMARY_ENABLED) {
      throw new OtpAuthError({
        code: "OTP_LOGIN_DISABLED",
        message: "OTP login is disabled.",
        statusCode: 403,
      });
    }

    await repository.cleanupExpiredOtpChallenges();

    const rateState = requestLimiter.assertAllowed(requestIp);
    if (!rateState.allowed) {
      throw new OtpAuthError({
        code: "OTP_REQUEST_RATE_LIMITED",
        message: "Too many OTP requests. Try again later.",
        statusCode: 429,
        retryAfterSeconds: rateState.retryAfterSeconds,
      });
    }

    const latestChallenge = await repository.getLatestPendingOtpChallenge({
      recipientEmail: env.DASHBOARD_OTP_TO,
      requestedIp: null,
    });

    if (latestChallenge?.created_at) {
      const createdAtMs = new Date(latestChallenge.created_at).getTime();
      if (Number.isFinite(createdAtMs)) {
        const elapsedMs = nowMs() - createdAtMs;
        if (elapsedMs >= 0 && elapsedMs < resendCooldownMs) {
          const retryAfterSeconds = Math.max(
            1,
            Math.ceil((resendCooldownMs - elapsedMs) / 1000)
          );
          throw new OtpAuthError({
            code: "OTP_RESEND_COOLDOWN_ACTIVE",
            message: "OTP resend cooldown is active.",
            statusCode: 429,
            retryAfterSeconds,
          });
        }
      }
    }

    const quotaDate = quotaDateIso();
    const reserved = await repository.reserveDashboardOtpQuota(
      quotaDate,
      env.DASHBOARD_OTP_DAILY_LIMIT
    );

    if (!reserved) {
      throw new OtpAuthError({
        code: "OTP_DAILY_LIMIT_REACHED",
        message: "Daily OTP limit reached.",
        statusCode: 429,
      });
    }

    const challengeId = crypto.randomUUID();
    const otpRequestId = crypto.randomUUID();
    const code = randomDigits(env.DASHBOARD_OTP_LENGTH);
    const expiresAt = toIso(nowMs() + ttlMs);
    const codeHash = hmacCodeHash(env.DASHBOARD_SESSION_SECRET, challengeId, code);

    try {
      await repository.createOtpChallenge({
        challengeId,
        recipientEmail: env.DASHBOARD_OTP_TO,
        codeHash,
        maxAttempts: env.DASHBOARD_OTP_MAX_ATTEMPTS,
        requestedIp: requestIp,
        userAgent,
        expiresAt,
      });

      const payload = getOtpMailPayload({
        code,
        expiresMinutes: env.DASHBOARD_OTP_TTL_MINUTES,
        otpRequestId,
      });

      const sendResult = await transport.sendMail({
        from: otpFrom,
        to: env.DASHBOARD_OTP_TO,
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
        headers: {
          "X-Email-VPS-OTP-Request-ID": otpRequestId,
        },
      });

      try {
        await repository.createDashboardOtpDeliveryEvent({
          otpRequestId,
          challengeId,
          recipientEmail: env.DASHBOARD_OTP_TO,
          deliveryStage: "accepted_by_local_relay",
          providerMessageId: sendResult?.messageId || null,
        });
      } catch (eventError) {
        logger.error("[otp] failed to persist delivery event:", eventError);
      }
    } catch (error) {
      await repository.releaseDashboardOtpQuota(quotaDate);
      await repository.expireOtpChallenge({ challengeId });

      try {
        await repository.createDashboardOtpDeliveryEvent({
          otpRequestId,
          challengeId,
          recipientEmail: env.DASHBOARD_OTP_TO,
          deliveryStage: "delivery_failed",
          errorCode: error?.code || null,
          errorMessage: error?.message || "unknown delivery failure",
        });
      } catch (eventError) {
        logger.error("[otp] failed to persist delivery failure event:", eventError);
      }

      logger.error("[otp] delivery failed:", error);
      throw new OtpAuthError({
        code: "OTP_DELIVERY_FAILED",
        message: "Failed to deliver OTP email.",
        statusCode: 503,
        otpRequestId,
      });
    }

    requestLimiter.consume(requestIp);
    return {
      otpRequestId,
      challengeId,
      expiresInSeconds: Math.trunc(ttlMs / 1000),
      resendAvailableInSeconds: Math.trunc(resendCooldownMs / 1000),
      recipientMasked: maskEmail(env.DASHBOARD_OTP_TO),
    };
  }

  async function verifyOtp({ challengeId, code }) {
    if (!challengeId) {
      throw new OtpAuthError({
        code: "OTP_CHALLENGE_MISSING",
        message: "OTP challenge is missing.",
        statusCode: 400,
      });
    }

    const challenge = await repository.getOtpChallengeByChallengeId(challengeId);
    if (!challenge) {
      throw new OtpAuthError({
        code: "OTP_CHALLENGE_MISSING",
        message: "OTP challenge is missing.",
        statusCode: 400,
      });
    }

    if (challenge.status === "used") {
      throw new OtpAuthError({
        code: "OTP_CHALLENGE_MISSING",
        message: "OTP challenge is no longer active.",
        statusCode: 400,
      });
    }

    if (challenge.status === "locked") {
      throw new OtpAuthError({
        code: "OTP_MAX_ATTEMPTS_EXCEEDED",
        message: "Maximum OTP attempts exceeded.",
        statusCode: 429,
      });
    }

    const expiresAtMs = new Date(challenge.expires_at).getTime();
    if (!Number.isFinite(expiresAtMs) || nowMs() > expiresAtMs) {
      await repository.expireOtpChallenge({ challengeId });
      throw new OtpAuthError({
        code: "OTP_EXPIRED",
        message: "OTP has expired. Request a new code.",
        statusCode: 410,
      });
    }

    const submittedCode = String(code || "").trim();
    if (!submittedCode) {
      throw new OtpAuthError({
        code: "OTP_INVALID_CODE",
        message: "OTP code is required.",
        statusCode: 400,
      });
    }

    const candidateHash = hmacCodeHash(env.DASHBOARD_SESSION_SECRET, challengeId, submittedCode);
    if (!timingSafeEqual(challenge.code_hash, candidateHash)) {
      const updated = await repository.incrementOtpAttempt({ challengeId });
      if (Number(updated?.attempt_count || 0) >= Number(updated?.max_attempts || env.DASHBOARD_OTP_MAX_ATTEMPTS)) {
        await repository.lockOtpChallenge({ challengeId });
        throw new OtpAuthError({
          code: "OTP_MAX_ATTEMPTS_EXCEEDED",
          message: "Maximum OTP attempts exceeded.",
          statusCode: 429,
        });
      }

      throw new OtpAuthError({
        code: "OTP_INVALID_CODE",
        message: "Invalid OTP code.",
        statusCode: 400,
      });
    }

    await repository.markOtpChallengeUsed({ challengeId });
    return {
      ok: true,
      challengeId,
      recipientMasked: maskEmail(challenge.recipient_email),
    };
  }

  async function getDeliveryDiagnostics({ limit = 25 } = {}) {
    const normalizedLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const [events, summary] = await Promise.all([
      repository.listDashboardOtpDeliveryEvents({ limit: normalizedLimit }),
      repository.getDashboardOtpDeliveryFailureSummary({ limit: 10 }),
    ]);

    return {
      events,
      failureSummary: summary.map((row) => ({
        key: row.key,
        count: Number(row.count || 0),
      })),
    };
  }

  return {
    challengeCookieName,
    readChallengeIdFromRequest,
    setChallengeCookie,
    clearChallengeCookie,
    requestOtp,
    verifyOtp,
    getDeliveryDiagnostics,
  };
}

module.exports = {
  OtpAuthError,
  createOtpAuthService,
};
