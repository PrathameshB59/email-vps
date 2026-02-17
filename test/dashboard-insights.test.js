const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRepository } = require("../src/mail/repository");
const { createDashboardService } = require("../src/dashboard/services/dashboardService");

test("dashboard insights and timeseries return chart-ready operational payloads", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "email-vps-insights-"));
  const dbPath = path.join(tempDir, "insights.sqlite");
  const repository = await createRepository({ dbPath });

  const alertService = {
    async getSecuritySignals() {
      return {
        metrics: {
          ok: true,
          path: path.join(tempDir, "metrics.json"),
          data: {
            cpu: "30%",
            memory_used: "2Gi",
            memory_total: "8Gi",
            load: "0.40, 0.35, 0.25",
            disk: "40%",
            top_ip: "198.51.100.11",
          },
        },
        relay: { ok: true, host: "127.0.0.1", port: 25, secure: false },
        diskPct: 40,
        sshFails: 2,
        pm2Online: 3,
        risk: "LOW",
        fail2banSummary: "ok",
        aideBaselinePresent: true,
        reportPath: "/tmp/vps_report.html",
        metricsAgeMinutes: 1,
      };
    },
    async computeAndPersistAlerts() {
      return [];
    },
  };

  const dashboardService = createDashboardService({
    repository,
    env: {
      MAIL_DAILY_LIMIT: 500,
      LOG_RETENTION_DAYS: 30,
      DASHBOARD_RETENTION_DAYS: 90,
    },
    alertService,
  });

  const now = Date.now();
  await repository.insertDashboardMetricSnapshot({
    capturedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    queuePending: 1,
    queueRetrying: 1,
    queueFailed: 0,
    sent24h: 3,
    failed24h: 0,
    quotaUsed: 5,
    quotaLimit: 500,
    relayOk: true,
    riskScore: 18,
  });

  await repository.insertDashboardMetricSnapshot({
    capturedAt: new Date(now - 15 * 60 * 1000).toISOString(),
    queuePending: 0,
    queueRetrying: 1,
    queueFailed: 1,
    sent24h: 4,
    failed24h: 1,
    quotaUsed: 7,
    quotaLimit: 500,
    relayOk: true,
    riskScore: 28,
  });

  const baseEvent = {
    queueId: null,
    toEmail: "user@example.com",
    subject: "test",
    category: "system-alert",
  };

  await repository.recordEvent({
    ...baseEvent,
    requestId: "req-1",
    eventType: "queued",
    status: "queued",
    attempt: 0,
  });

  await repository.recordEvent({
    ...baseEvent,
    requestId: "req-1",
    eventType: "sent",
    status: "sent",
    attempt: 1,
    accepted: 1,
  });

  await repository.recordEvent({
    ...baseEvent,
    requestId: "req-2",
    eventType: "queued",
    status: "queued",
    attempt: 0,
  });

  await repository.recordEvent({
    ...baseEvent,
    requestId: "req-2",
    eventType: "retry_scheduled",
    status: "retrying",
    attempt: 1,
    errorCode: "ECONNRESET",
    errorMessage: "transient",
  });

  await repository.recordEvent({
    ...baseEvent,
    requestId: "req-3",
    eventType: "failed",
    status: "failed",
    attempt: 1,
    errorCode: "EAUTH",
    errorMessage: "auth failed",
    toEmail: "ops@example.com",
    category: "app-notification",
  });

  try {
    const insights = await dashboardService.getInsights("24h");
    assert.equal(insights.window, "24h");
    assert.equal(typeof insights.deliveryFunnel.totalRequests, "number");
    assert.equal(Array.isArray(insights.topErrors), true);
    assert.equal(Array.isArray(insights.categoryMix), true);
    assert.equal(typeof insights.actionPlan.topIssue, "string");

    const timeseries = await dashboardService.getTimeseries("24h");
    assert.equal(timeseries.window, "24h");
    assert.equal(Array.isArray(timeseries.points), true);
    assert.equal(timeseries.points.length > 0, true);
    assert.equal(timeseries.series.sent.length, timeseries.points.length);
    assert.equal(timeseries.series.riskScore.length, timeseries.points.length);
  } finally {
    await repository.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
