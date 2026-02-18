const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createCore } = require("../src/runtime");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(checkFn, timeoutMs = 2000, intervalMs = 25) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await checkFn();
    if (result) {
      return true;
    }
    await sleep(intervalMs);
  }
  return false;
}

test("queue recovers pending retry items after restart", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "email-vps-recovery-"));
  const dbPath = path.join(tempDir, "queue.sqlite");

  const failingTransport = {
    async sendMail() {
      const err = new Error("temporary relay outage");
      err.code = "ECONNECTION";
      throw err;
    },
    async verify() {
      return true;
    },
  };

  const firstCore = await createCore({
    envOverrides: {
      NODE_ENV: "test",
      MAIL_API_TOKEN: "test-token",
      MAIL_FROM: "Email VPS <noreply@example.com>",
      DB_PATH: dbPath,
      MAIL_RETRY_BASE_MS: "10",
      MAIL_RETRY_MAX: "3",
      QUEUE_POLL_MS: "10",
      DASHBOARD_LOGIN_USER: "owner",
      DASHBOARD_LOGIN_PASS: "dashboard-pass",
      DASHBOARD_SESSION_SECRET: "dashboard-session-secret",
      DASHBOARD_OTP_TO: "owner@example.com",
      DASHBOARD_ALLOWED_IPS: "127.0.0.1",
    },
    transport: failingTransport,
  });

  let requestId;

  try {
    const firstResult = await firstCore.mailService.send(
      {
        to: "user@example.com",
        subject: "Retry Me",
        text: "Temporary failure expected",
        category: "system-alert",
      },
      { processNow: true }
    );

    requestId = firstResult.requestId;
    assert.equal(firstResult.status, "retrying");
  } finally {
    await firstCore.close();
  }

  const successTransport = {
    async sendMail() {
      return {
        messageId: "recovered-message",
        accepted: ["user@example.com"],
        rejected: [],
      };
    },
    async verify() {
      return true;
    },
  };

  const secondCore = await createCore({
    envOverrides: {
      NODE_ENV: "test",
      MAIL_API_TOKEN: "test-token",
      MAIL_FROM: "Email VPS <noreply@example.com>",
      DB_PATH: dbPath,
      MAIL_RETRY_BASE_MS: "10",
      MAIL_RETRY_MAX: "3",
      QUEUE_POLL_MS: "10",
      QUEUE_BATCH_SIZE: "5",
      DASHBOARD_LOGIN_USER: "owner",
      DASHBOARD_LOGIN_PASS: "dashboard-pass",
      DASHBOARD_SESSION_SECRET: "dashboard-session-secret",
      DASHBOARD_OTP_TO: "owner@example.com",
      DASHBOARD_ALLOWED_IPS: "127.0.0.1",
    },
    transport: successTransport,
  });

  try {
    await secondCore.retryQueue.start();

    const delivered = await waitFor(async () => {
      const row = await secondCore.repository.getQueueItemByRequestId(requestId);
      return row && row.status === "sent";
    });

    assert.equal(delivered, true);
  } finally {
    await secondCore.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
