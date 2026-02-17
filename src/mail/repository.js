const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");

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
  `);

  return {
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
      const nowIso = new Date().toISOString();

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
        item.nextAttemptAt || nowIso,
        nowIso,
        nowIso
      );

      return this.getQueueItemById(insertResult.lastID);
    },

    async getQueueItemById(id) {
      return db.get("SELECT * FROM mail_queue WHERE id = ?", id);
    },

    async getQueueItemByRequestId(requestId) {
      return db.get("SELECT * FROM mail_queue WHERE request_id = ? ORDER BY id DESC LIMIT 1", requestId);
    },

    async listDueQueueItems(nowIso, limit) {
      return db.all(
        `SELECT * FROM mail_queue
         WHERE status IN ('pending', 'retrying')
           AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC
         LIMIT ?`,
        nowIso,
        limit
      );
    },

    async markProcessing(id) {
      const nowIso = new Date().toISOString();
      const result = await db.run(
        `UPDATE mail_queue
         SET status = 'processing', updated_at = ?
         WHERE id = ?
           AND status IN ('pending', 'retrying')`,
        nowIso,
        id
      );
      return result.changes === 1;
    },

    async markSent(id, attempts) {
      const nowIso = new Date().toISOString();
      await db.run(
        `UPDATE mail_queue
         SET status = 'sent', attempts = ?, updated_at = ?
         WHERE id = ?`,
        attempts,
        nowIso,
        id
      );
    },

    async markRetry(id, attempts, nextAttemptAt, errorCode, errorMessage) {
      const nowIso = new Date().toISOString();
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
        nowIso,
        id
      );
    },

    async markFailed(id, attempts, errorCode, errorMessage) {
      const nowIso = new Date().toISOString();
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
        nowIso,
        id
      );
    },

    async resetProcessingToRetrying() {
      const nowIso = new Date().toISOString();
      await db.run(
        `UPDATE mail_queue
         SET status = 'retrying',
             next_attempt_at = ?,
             updated_at = ?
         WHERE status = 'processing'`,
        nowIso,
        nowIso
      );
    },

    async forceNextAttemptNow(id) {
      const nowIso = new Date().toISOString();
      await db.run(
        `UPDATE mail_queue
         SET next_attempt_at = ?, updated_at = ?
         WHERE id = ?`,
        nowIso,
        nowIso,
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
        "DELETE FROM mail_events WHERE created_at < datetime('now', ?)",
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
  };
}

module.exports = {
  createRepository,
};
