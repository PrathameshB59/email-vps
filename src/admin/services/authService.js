const { AdminAuthError, AdminValidationError } = require("../errors");
const { hashPassword, verifyPassword } = require("../auth/password");
const { createTokenService } = require("../auth/tokenService");

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function safeUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    active: Boolean(user.active),
  };
}

function createAdminAuthService({ repository, env }) {
  const tokenService = createTokenService(env);

  async function ensureAdminUser({ email, password, role = "admin" }) {
    if (!email || !password) {
      throw new AdminValidationError("Admin email and password are required.");
    }

    const passwordHash = await hashPassword(password);
    const user = await repository.createOrUpdateAdminUser({
      email,
      passwordHash,
      role,
      active: true,
    });

    return safeUser(user);
  }

  async function ensureSeedAdminIfConfigured() {
    if (!env.ADMIN_SEED_EMAIL || !env.ADMIN_SEED_PASSWORD) {
      return null;
    }

    return ensureAdminUser({
      email: env.ADMIN_SEED_EMAIL,
      password: env.ADMIN_SEED_PASSWORD,
      role: env.ADMIN_DEFAULT_ROLE,
    });
  }

  async function login({ email, password, ip = null, userAgent = null }) {
    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail || !password) {
      throw new AdminValidationError("Email and password are required.");
    }

    const recentFailed = await repository.countRecentFailedAuthEvents({
      email: normalizedEmail,
      windowMinutes: env.ADMIN_LOCKOUT_WINDOW_MINUTES,
    });

    if (recentFailed >= env.ADMIN_LOCKOUT_THRESHOLD) {
      await repository.recordAdminAuthEvent({
        email: normalizedEmail,
        ip,
        status: "blocked",
        reason: "lockout_threshold_reached",
      });
      throw new AdminAuthError(
        "Account temporarily locked due to repeated failed logins.",
        "ADMIN_LOCKED",
        423
      );
    }

    const user = await repository.getAdminUserByEmail(normalizedEmail);

    if (!user || !user.active) {
      await repository.recordAdminAuthEvent({
        email: normalizedEmail,
        ip,
        status: "failed",
        reason: "user_not_found_or_inactive",
      });
      throw new AdminAuthError("Invalid admin credentials.", "ADMIN_INVALID_CREDENTIALS", 401);
    }

    const passwordOk = await verifyPassword(password, user.password_hash);

    if (!passwordOk) {
      await repository.recordAdminAuthEvent({
        email: normalizedEmail,
        ip,
        status: "failed",
        reason: "invalid_password",
      });
      throw new AdminAuthError("Invalid admin credentials.", "ADMIN_INVALID_CREDENTIALS", 401);
    }

    await repository.cleanupExpiredAdminSessions();

    const session = await repository.createAdminSession({
      adminUserId: user.id,
      refreshTokenHash: "pending",
      expiresAt: tokenService.refreshExpiryIso(),
      ip,
      userAgent,
    });

    const refreshToken = tokenService.signRefreshToken(user, session.id);
    const refreshTokenHash = tokenService.sha256(refreshToken);

    const rotatedSession = await repository.updateAdminSessionRotation({
      id: session.id,
      refreshTokenHash,
      expiresAt: tokenService.refreshExpiryIso(),
    });

    await repository.recordAdminAuthEvent({
      email: normalizedEmail,
      ip,
      status: "success",
      reason: "login_success",
    });

    return {
      accessToken: tokenService.signAccessToken(user),
      refreshToken,
      sessionId: rotatedSession.id,
      user: safeUser(user),
    };
  }

  async function refresh({ refreshToken, ip = null, userAgent = null }) {
    if (!refreshToken) {
      throw new AdminValidationError("refreshToken is required.", "ADMIN_REFRESH_REQUIRED", 400);
    }

    const payload = tokenService.verifyRefreshToken(refreshToken);
    const sessionId = Number(payload.sid);
    const userId = Number(payload.sub);

    const session = await repository.getAdminSessionById(sessionId);

    if (!session) {
      throw new AdminAuthError("Session not found.", "ADMIN_SESSION_NOT_FOUND", 401);
    }

    if (session.revoked_at) {
      throw new AdminAuthError("Session already revoked.", "ADMIN_SESSION_REVOKED", 401);
    }

    if (new Date(session.expires_at).getTime() <= Date.now()) {
      throw new AdminAuthError("Session expired.", "ADMIN_SESSION_EXPIRED", 401);
    }

    const incomingHash = tokenService.sha256(refreshToken);
    if (incomingHash !== session.refresh_token_hash) {
      throw new AdminAuthError("Refresh token mismatch.", "ADMIN_REFRESH_MISMATCH", 401);
    }

    const user = await repository.getAdminUserById(userId);
    if (!user || !user.active) {
      throw new AdminAuthError("Admin user unavailable.", "ADMIN_USER_UNAVAILABLE", 401);
    }

    const nextRefreshToken = tokenService.signRefreshToken(user, session.id);
    const nextRefreshHash = tokenService.sha256(nextRefreshToken);

    await repository.updateAdminSessionRotation({
      id: session.id,
      refreshTokenHash: nextRefreshHash,
      expiresAt: tokenService.refreshExpiryIso(),
    });

    await repository.recordAdminAuthEvent({
      email: user.email,
      ip,
      status: "success",
      reason: "token_refreshed",
    });

    return {
      accessToken: tokenService.signAccessToken(user),
      refreshToken: nextRefreshToken,
      sessionId: session.id,
      user: safeUser(user),
    };
  }

  async function logout({ refreshToken, ip = null }) {
    if (!refreshToken) {
      throw new AdminValidationError("refreshToken is required.", "ADMIN_REFRESH_REQUIRED", 400);
    }

    const payload = tokenService.verifyRefreshToken(refreshToken);
    const sessionId = Number(payload.sid);

    await repository.revokeAdminSession(sessionId);
    await repository.recordAdminAuthEvent({
      email: null,
      ip,
      status: "success",
      reason: `logout_session_${sessionId}`,
    });

    return {
      ok: true,
      sessionId,
    };
  }

  return {
    ensureAdminUser,
    ensureSeedAdminIfConfigured,
    login,
    refresh,
    logout,
  };
}

module.exports = {
  createAdminAuthService,
};
