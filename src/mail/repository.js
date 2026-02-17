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

function normalizeStatusSeverity(severity) {
  const normalized = String(severity || "")
    .trim()
    .toLowerCase();

  if (!normalized) {
    return [];
  }

  if (normalized === "critical") {
    return ["failed"];
  }

  if (normalized === "warning") {
    return ["retrying", "processing"];
  }

  if (normalized === "info") {
    return ["sent", "queued"];
  }

  return [];
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

    CREATE TABLE IF NOT EXISTS dashboard_metric_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      captured_at TEXT NOT NULL DEFAULT (datetime('now')),
      cpu_pct REAL,
      memory_used_pct REAL,
      disk_pct REAL,
      load_1m REAL,
      ssh_fails_24h INTEGER,
      pm2_online INTEGER,
      queue_pending INTEGER NOT NULL DEFAULT 0,
      queue_retrying INTEGER NOT NULL DEFAULT 0,
      queue_failed INTEGER NOT NULL DEFAULT 0,
      sent_24h INTEGER NOT NULL DEFAULT 0,
      failed_24h INTEGER NOT NULL DEFAULT 0,
      quota_used INTEGER NOT NULL DEFAULT 0,
      quota_limit INTEGER NOT NULL DEFAULT 0,
      relay_ok INTEGER NOT NULL DEFAULT 0,
      risk_score INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_dashboard_metric_snapshots_captured_at
      ON dashboard_metric_snapshots(captured_at);
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

    async listMailLogsMetadata({
      limit = 50,
      offset = 0,
      status = null,
      category = null,
      query = null,
      severity = null,
    } = {}) {
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

      const severityStatuses = normalizeStatusSeverity(severity);
      if (severityStatuses.length > 0) {
        conditions.push(
          `status IN (${severityStatuses.map(() => "?").join(", ")})`
        );
        params.push(...severityStatuses);
      }

      const searchQuery = String(query || "").trim();
      if (searchQuery) {
        conditions.push("(to_email LIKE ? OR request_id LIKE ?)");
        const like = `%${searchQuery}%`;
        params.push(like, like);
      }

      const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

      return db.all(
        `SELECT id, request_id, event_type, status, attempt, to_email, subject, category,
                accepted, rejected, error_code, error_message, created_at
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

    async countMailEventsByStatusBetween({ status, startIso, endIso }) {
      const row = await db.get(
        `SELECT COUNT(*) AS count
         FROM mail_events
         WHERE status = ?
           AND datetime(created_at) >= datetime(?)
           AND datetime(created_at) < datetime(?)`,
        status,
        startIso,
        endIso
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

    async insertDashboardMetricSnapshot(snapshot) {
      const result = await db.run(
        `INSERT INTO dashboard_metric_snapshots (
          captured_at,
          cpu_pct,
          memory_used_pct,
          disk_pct,
          load_1m,
          ssh_fails_24h,
          pm2_online,
          queue_pending,
          queue_retrying,
          queue_failed,
          sent_24h,
          failed_24h,
          quota_used,
          quota_limit,
          relay_ok,
          risk_score
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        snapshot.capturedAt || nowIso(),
        snapshot.cpuPct ?? null,
        snapshot.memoryUsedPct ?? null,
        snapshot.diskPct ?? null,
        snapshot.load1m ?? null,
        snapshot.sshFails24h ?? null,
        snapshot.pm2Online ?? null,
        snapshot.queuePending || 0,
        snapshot.queueRetrying || 0,
        snapshot.queueFailed || 0,
        snapshot.sent24h || 0,
        snapshot.failed24h || 0,
        snapshot.quotaUsed || 0,
        snapshot.quotaLimit || 0,
        snapshot.relayOk ? 1 : 0,
        snapshot.riskScore || 0
      );

      return db.get("SELECT * FROM dashboard_metric_snapshots WHERE id = ?", result.lastID);
    },

    async listDashboardMetricSnapshotsSince({ sinceIso, limit = 10000 } = {}) {
      return db.all(
        `SELECT * FROM dashboard_metric_snapshots
         WHERE datetime(captured_at) >= datetime(?)
         ORDER BY datetime(captured_at) ASC
         LIMIT ?`,
        sinceIso,
        Number(limit)
      );
    },

    async getLatestDashboardMetricSnapshot() {
      return db.get(
        `SELECT * FROM dashboard_metric_snapshots
         ORDER BY datetime(captured_at) DESC
         LIMIT 1`
      );
    },

    async getLatestDashboardMetricSnapshotBefore({ beforeIso }) {
      return db.get(
        `SELECT * FROM dashboard_metric_snapshots
         WHERE datetime(captured_at) < datetime(?)
         ORDER BY datetime(captured_at) DESC
         LIMIT 1`,
        beforeIso
      );
    },

    async getDeliveryFunnel(sinceIso) {
      const row = await db.get(
        `WITH latest AS (
           SELECT request_id, MAX(id) AS max_id
           FROM mail_events
           WHERE datetime(created_at) >= datetime(?)
           GROUP BY request_id
         )
         SELECT
           COUNT(*) AS total_requests,
           SUM(CASE WHEN e.status = 'sent' THEN 1 ELSE 0 END) AS sent_requests,
           SUM(CASE WHEN e.status = 'failed' THEN 1 ELSE 0 END) AS failed_requests,
           SUM(CASE WHEN e.status = 'retrying' THEN 1 ELSE 0 END) AS retrying_requests,
           SUM(CASE WHEN e.status = 'queued' THEN 1 ELSE 0 END) AS queued_requests
         FROM latest l
         JOIN mail_events e ON e.id = l.max_id`,
        sinceIso
      );

      return {
        totalRequests: row?.total_requests || 0,
        sentRequests: row?.sent_requests || 0,
        failedRequests: row?.failed_requests || 0,
        retryingRequests: row?.retrying_requests || 0,
        queuedRequests: row?.queued_requests || 0,
      };
    },

    async getTopErrorCodes(sinceIso, limit = 5) {
      return db.all(
        `SELECT
           COALESCE(NULLIF(error_code, ''), 'unknown') AS code,
           COUNT(*) AS count
         FROM mail_events
         WHERE datetime(created_at) >= datetime(?)
           AND status IN ('failed', 'retrying')
         GROUP BY COALESCE(NULLIF(error_code, ''), 'unknown')
         ORDER BY count DESC, code ASC
         LIMIT ?`,
        sinceIso,
        Number(limit)
      );
    },

    async getCategoryBreakdown(sinceIso) {
      return db.all(
        `SELECT
           COALESCE(NULLIF(category, ''), 'uncategorized') AS category,
           COUNT(*) AS count
         FROM mail_events
         WHERE datetime(created_at) >= datetime(?)
         GROUP BY COALESCE(NULLIF(category, ''), 'uncategorized')
         ORDER BY count DESC, category ASC`,
        sinceIso
      );
    },

    async getStatusTimeBuckets(sinceIso, bucketMinutes = 15) {
      const bucketSeconds = Math.max(1, Number(bucketMinutes)) * 60;

      return db.all(
        `SELECT
           datetime((CAST(strftime('%s', created_at) AS INTEGER) / ?) * ?, 'unixepoch') AS bucket_at,
           status,
           COUNT(*) AS count
         FROM mail_events
         WHERE datetime(created_at) >= datetime(?)
           AND status IN ('sent', 'failed', 'retrying')
         GROUP BY bucket_at, status
         ORDER BY datetime(bucket_at) ASC`,
        bucketSeconds,
        bucketSeconds,
        sinceIso
      );
    },

    async getQueueAgingSnapshot() {
      const row = await db.get(
        `SELECT
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
           SUM(CASE WHEN status = 'retrying' THEN 1 ELSE 0 END) AS retrying_count,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
           MIN(
             CASE
               WHEN status IN ('pending', 'retrying', 'processing')
               THEN datetime(created_at)
               ELSE NULL
             END
           ) AS oldest_open_created_at
         FROM mail_queue`
      );

      return {
        pending: row?.pending_count || 0,
        retrying: row?.retrying_count || 0,
        failed: row?.failed_count || 0,
        oldestOpenCreatedAt: row?.oldest_open_created_at || null,
      };
    },

    async getQuotaBurnRate(sinceIso) {
      const row = await db.get(
        `SELECT COUNT(*) AS sent_count
         FROM mail_events
         WHERE status = 'sent'
           AND datetime(created_at) >= datetime(?)`,
        sinceIso
      );

      return {
        sentCount: row?.sent_count || 0,
      };
    },

    async cleanupOldDashboardMetricSnapshots(retentionDays) {
      await db.run(
        `DELETE FROM dashboard_metric_snapshots
         WHERE datetime(captured_at) < datetime('now', ?)`,
        `-${Number(retentionDays)} days`
      );
    },
  };

  return repository;
}

module.exports = {
  createRepository,
};
