const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");

function nowIso() {
  return new Date().toISOString();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

async function createRepository({ dbPath }) {
  const resolvedPath = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const db = await open({
    filename: resolvedPath,
    driver: sqlite3.Database,
  });

  await db.exec("PRAGMA journal_mode = WAL;");
  await db.exec("PRAGMA foreign_keys = ON;");

  await db.exec(`
    CREATE TABLE IF NOT EXISTS mail_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      to_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      text_body TEXT,
      html_body TEXT,
      category TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      next_attempt_at TEXT NOT NULL,
      last_error_code TEXT,
      last_error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_mail_queue_status_next_attempt
      ON mail_queue(status, next_attempt_at);

    CREATE INDEX IF NOT EXISTS idx_mail_queue_request_id
      ON mail_queue(request_id);

    CREATE TABLE IF NOT EXISTS mail_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_id INTEGER,
      request_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      to_email TEXT NOT NULL,
      subject TEXT,
      category TEXT,
      accepted INTEGER NOT NULL DEFAULT 0,
      rejected INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(queue_id) REFERENCES mail_queue(id)
    );

    CREATE INDEX IF NOT EXISTS idx_mail_events_created_at
      ON mail_events(created_at);

    CREATE INDEX IF NOT EXISTS idx_mail_events_request_id
      ON mail_events(request_id);

    CREATE TABLE IF NOT EXISTS daily_quota (
      quota_date TEXT PRIMARY KEY,
      sent_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_admin_users_email
      ON admin_users(email);

    CREATE TABLE IF NOT EXISTS admin_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_user_id INTEGER NOT NULL,
      refresh_token_hash TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      rotated_at TEXT,
      revoked_at TEXT,
      FOREIGN KEY(admin_user_id) REFERENCES admin_users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_admin_sessions_user
      ON admin_sessions(admin_user_id);

    CREATE INDEX IF NOT EXISTS idx_admin_sessions_token_hash
      ON admin_sessions(refresh_token_hash);

    CREATE TABLE IF NOT EXISTS admin_auth_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      ip TEXT,
      status TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_admin_auth_events_email_created
      ON admin_auth_events(email, created_at);

    CREATE TABLE IF NOT EXISTS system_alert_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_type TEXT NOT NULL UNIQUE,
      severity TEXT NOT NULL,
      value TEXT,
      status TEXT NOT NULL,
      message TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_system_alert_state_status
      ON system_alert_state(status);
  `);

  const repository = {
    dbPath: resolvedPath,

    async close() {
      await db.close();
    },

    async reserveQuota(quotaDate, limit) {
      await db.run(
        "INSERT OR IGNORE INTO daily_quota (quota_date, sent_count, updated_at) VALUES (?, 0, datetime('now'))",
        quotaDate
      );

      const updateResult = await db.run(
        "UPDATE daily_quota SET sent_count = sent_count + 1, updated_at = datetime('now') WHERE quota_date = ? AND sent_count < ?",
        quotaDate,
        limit
      );

      return updateResult.changes === 1;
    },

    async releaseQuota(quotaDate) {
      await db.run(
        "UPDATE daily_quota SET sent_count = CASE WHEN sent_count > 0 THEN sent_count - 1 ELSE 0 END, updated_at = datetime('now') WHERE quota_date = ?",
        quotaDate
      );
    },

    async getQuota(quotaDate) {
      const row = await db.get(
        "SELECT quota_date, sent_count FROM daily_quota WHERE quota_date = ?",
        quotaDate
      );

      return {
        quotaDate,
        used: row ? row.sent_count : 0,
      };
    },

    async enqueueMail(item) {
      const currentIso = nowIso();

      const insertResult = await db.run(
        `INSERT INTO mail_queue (
          request_id,
          to_email,
          subject,
          text_body,
          html_body,
          category,
          payload_json,
          status,
          attempts,
          max_attempts,
          next_attempt_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)` ,
        item.requestId,
        item.toEmail,
        item.subject,
        item.textBody,
        item.htmlBody,
        item.category,
        item.payloadJson,
        item.maxAttempts,
        item.nextAttemptAt || currentIso,
        currentIso,
        currentIso
      );

      return repository.getQueueItemById(insertResult.lastID);
    },

    async getQueueItemById(id) {
      return db.get("SELECT * FROM mail_queue WHERE id = ?", id);
    },

    async getQueueItemByRequestId(requestId) {
      return db.get("SELECT * FROM mail_queue WHERE request_id = ? ORDER BY id DESC LIMIT 1", requestId);
    },

    async listDueQueueItems(currentIso, limit) {
      return db.all(
        `SELECT * FROM mail_queue
         WHERE status IN ('pending', 'retrying')
           AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC
         LIMIT ?`,
        currentIso,
        limit
      );
    },

    async markProcessing(id) {
      const currentIso = nowIso();
      const result = await db.run(
        `UPDATE mail_queue
         SET status = 'processing', updated_at = ?
         WHERE id = ?
           AND status IN ('pending', 'retrying')`,
        currentIso,
        id
      );
      return result.changes === 1;
    },

    async markSent(id, attempts) {
      const currentIso = nowIso();
      await db.run(
        `UPDATE mail_queue
         SET status = 'sent', attempts = ?, updated_at = ?
         WHERE id = ?`,
        attempts,
        currentIso,
        id
      );
    },

    async markRetry(id, attempts, nextAttemptAt, errorCode, errorMessage) {
      const currentIso = nowIso();
      await db.run(
        `UPDATE mail_queue
         SET status = 'retrying',
             attempts = ?,
             next_attempt_at = ?,
             last_error_code = ?,
             last_error_message = ?,
             updated_at = ?
         WHERE id = ?`,
        attempts,
        nextAttemptAt,
        errorCode || null,
        errorMessage || null,
        currentIso,
        id
      );
    },

    async markFailed(id, attempts, errorCode, errorMessage) {
      const currentIso = nowIso();
      await db.run(
        `UPDATE mail_queue
         SET status = 'failed',
             attempts = ?,
             last_error_code = ?,
             last_error_message = ?,
             updated_at = ?
         WHERE id = ?`,
        attempts,
        errorCode || null,
        errorMessage || null,
        currentIso,
        id
      );
    },

    async resetProcessingToRetrying() {
      const currentIso = nowIso();
      await db.run(
        `UPDATE mail_queue
         SET status = 'retrying',
             next_attempt_at = ?,
             updated_at = ?
         WHERE status = 'processing'`,
        currentIso,
        currentIso
      );
    },

    async forceNextAttemptNow(id) {
      const currentIso = nowIso();
      await db.run(
        `UPDATE mail_queue
         SET next_attempt_at = ?, updated_at = ?
         WHERE id = ?`,
        currentIso,
        currentIso,
        id
      );
    },

    async recordEvent(event) {
      await db.run(
        `INSERT INTO mail_events (
          queue_id,
          request_id,
          event_type,
          status,
          attempt,
          to_email,
          subject,
          category,
          accepted,
          rejected,
          error_code,
          error_message,
          metadata_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        event.queueId || null,
        event.requestId,
        event.eventType,
        event.status,
        event.attempt || 0,
        event.toEmail,
        event.subject || null,
        event.category || null,
        event.accepted || 0,
        event.rejected || 0,
        event.errorCode || null,
        event.errorMessage || null,
        event.metadataJson || null
      );
    },

    async cleanupOldEvents(retentionDays) {
      await db.run(
        "DELETE FROM mail_events WHERE datetime(created_at) < datetime('now', ?)",
        `-${retentionDays} days`
      );
    },

    async getQueueStats() {
      const rows = await db.all(
        `SELECT status, COUNT(*) AS count
         FROM mail_queue
         GROUP BY status`
      );

      const stats = {
        pending: 0,
        retrying: 0,
        processing: 0,
        sent: 0,
        failed: 0,
      };

      for (const row of rows) {
        if (Object.prototype.hasOwnProperty.call(stats, row.status)) {
          stats[row.status] = row.count;
        }
      }

      return stats;
    },

    async listRecentEvents(limit = 25) {
      return db.all(
        `SELECT * FROM mail_events ORDER BY id DESC LIMIT ?`,
        limit
      );
    },

    async listMailLogs({ limit = 50, offset = 0, status = null, category = null } = {}) {
      const conditions = [];
      const params = [];

      if (status) {
        conditions.push("status = ?");
        params.push(String(status));
      }

      if (category) {
        conditions.push("category = ?");
        params.push(String(category));
      }

      const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

      return db.all(
        `SELECT id, request_id, event_type, status, attempt, to_email, subject, category, accepted, rejected,
                error_code, error_message, metadata_json, created_at
         FROM mail_events
         ${whereClause}
         ORDER BY id DESC
         LIMIT ? OFFSET ?`,
        ...params,
        Number(limit),
        Number(offset)
      );
    },

    async countMailEventsByStatusSince({ status, sinceIso }) {
      const row = await db.get(
        `SELECT COUNT(*) AS count
         FROM mail_events
         WHERE status = ?
           AND datetime(created_at) >= datetime(?)`,
        status,
        sinceIso
      );

      return row ? row.count : 0;
    },

    async createOrUpdateAdminUser({ email, passwordHash, role = "admin", active = true }) {
      const normalizedEmail = normalizeEmail(email);
      const currentIso = nowIso();

      await db.run(
        `INSERT INTO admin_users (email, password_hash, role, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET
           password_hash = excluded.password_hash,
           role = excluded.role,
           active = excluded.active,
           updated_at = excluded.updated_at`,
        normalizedEmail,
        passwordHash,
        role,
        active ? 1 : 0,
        currentIso,
        currentIso
      );

      return repository.getAdminUserByEmail(normalizedEmail);
    },

    async getAdminUserByEmail(email) {
      return db.get(
        "SELECT * FROM admin_users WHERE email = ? LIMIT 1",
        normalizeEmail(email)
      );
    },

    async getAdminUserById(id) {
      return db.get(
        "SELECT * FROM admin_users WHERE id = ? LIMIT 1",
        id
      );
    },

    async recordAdminAuthEvent({ email, ip, status, reason = null }) {
      await db.run(
        `INSERT INTO admin_auth_events (email, ip, status, reason, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
        email ? normalizeEmail(email) : null,
        ip || null,
        status,
        reason
      );
    },

    async countRecentFailedAuthEvents({ email, windowMinutes }) {
      const row = await db.get(
        `SELECT COUNT(*) AS count
         FROM admin_auth_events
         WHERE email = ?
           AND status = 'failed'
           AND datetime(created_at) >= datetime('now', ?)`,
        normalizeEmail(email),
        `-${Number(windowMinutes)} minutes`
      );

      return row ? row.count : 0;
    },

    async createAdminSession({ adminUserId, refreshTokenHash, expiresAt, ip = null, userAgent = null }) {
      const insertResult = await db.run(
        `INSERT INTO admin_sessions (
          admin_user_id,
          refresh_token_hash,
          ip,
          user_agent,
          expires_at,
          created_at
        ) VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        adminUserId,
        refreshTokenHash,
        ip,
        userAgent,
        expiresAt
      );

      return repository.getAdminSessionById(insertResult.lastID);
    },

    async getAdminSessionById(id) {
      return db.get("SELECT * FROM admin_sessions WHERE id = ? LIMIT 1", id);
    },

    async updateAdminSessionRotation({ id, refreshTokenHash, expiresAt }) {
      await db.run(
        `UPDATE admin_sessions
         SET refresh_token_hash = ?,
             expires_at = ?,
             rotated_at = datetime('now')
         WHERE id = ?`,
        refreshTokenHash,
        expiresAt,
        id
      );

      return repository.getAdminSessionById(id);
    },

    async revokeAdminSession(id) {
      await db.run(
        `UPDATE admin_sessions
         SET revoked_at = datetime('now')
         WHERE id = ?`,
        id
      );
    },

    async revokeAllAdminSessions(adminUserId) {
      await db.run(
        `UPDATE admin_sessions
         SET revoked_at = datetime('now')
         WHERE admin_user_id = ?
           AND revoked_at IS NULL`,
        adminUserId
      );
    },

    async cleanupExpiredAdminSessions() {
      await db.run(
        `DELETE FROM admin_sessions
         WHERE datetime(expires_at) < datetime('now', '-1 day')`
      );
    },

    async upsertSystemAlertState({ alertType, severity, value, status, message }) {
      const currentIso = nowIso();

      await db.run(
        `INSERT INTO system_alert_state (
          alert_type,
          severity,
          value,
          status,
          message,
          first_seen_at,
          last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(alert_type) DO UPDATE SET
          severity = excluded.severity,
          value = excluded.value,
          status = excluded.status,
          message = excluded.message,
          last_seen_at = excluded.last_seen_at`,
        alertType,
        severity,
        value != null ? String(value) : null,
        status,
        message,
        currentIso,
        currentIso
      );

      return db.get("SELECT * FROM system_alert_state WHERE alert_type = ?", alertType);
    },

    async listSystemAlertState(limit = 100) {
      return db.all(
        `SELECT * FROM system_alert_state
         ORDER BY datetime(last_seen_at) DESC
         LIMIT ?`,
        limit
      );
    },
  };

  return repository;
}

module.exports = {
  createRepository,
};
