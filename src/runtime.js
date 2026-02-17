const { loadEnv } = require("./config/env");
const { createApp } = require("./app");
const { createRepository } = require("./mail/repository");
const { createRateLimiter } = require("./mail/rateLimiter");
const { createMailTransport, verifyMailTransport } = require("./mail/transporter");
const { createMailService } = require("./mail/mailService");
const { createRetryQueue } = require("./mail/retryQueue");
const { createDashboardAlertService } = require("./dashboard/services/alertService");
const { createDashboardService } = require("./dashboard/services/dashboardService");
const { createDashboardSnapshotWorker } = require("./dashboard/snapshotWorker");

async function createCore({ envOverrides = {}, transport = null, logger = console } = {}) {
  const env = loadEnv(envOverrides);
  const repository = await createRepository({ dbPath: env.DB_PATH });
  const rateLimiter = createRateLimiter({ repository, dailyLimit: env.MAIL_DAILY_LIMIT });
  const mailTransport = transport || createMailTransport(env);

  const mailService = createMailService({
    env,
    repository,
    rateLimiter,
    transport: mailTransport,
    logger,
  });

  const retryQueue = createRetryQueue({
    repository,
    mailService,
    pollMs: env.QUEUE_POLL_MS,
    batchSize: env.QUEUE_BATCH_SIZE,
    retentionDays: env.LOG_RETENTION_DAYS,
    logger,
  });

  mailService.attachQueueWorker(retryQueue);

  const dashboardAlertService = createDashboardAlertService({
    repository,
    env,
    verifyRelay: async () => verifyMailTransport(mailTransport),
  });

  const dashboardService = createDashboardService({
    repository,
    env,
    alertService: dashboardAlertService,
  });

  const dashboardSnapshotWorker = createDashboardSnapshotWorker({
    dashboardService,
    pollMs: env.DASHBOARD_METRIC_SNAPSHOT_MINUTES * 60 * 1000,
    logger,
  });

  async function close() {
    await dashboardSnapshotWorker.stop();
    await retryQueue.stop();
    if (mailTransport && typeof mailTransport.close === "function") {
      mailTransport.close();
    }
    await repository.close();
  }

  return {
    env,
    repository,
    rateLimiter,
    mailService,
    retryQueue,
    dashboardService,
    dashboardSnapshotWorker,
    close,
  };
}

async function createRuntime(options = {}) {
  const core = await createCore(options);
  const app = createApp({
    env: core.env,
    mailService: core.mailService,
    rateLimiter: core.rateLimiter,
    repository: core.repository,
    dashboardService: core.dashboardService,
  });

  return {
    ...core,
    app,
  };
}

module.exports = {
  createCore,
  createRuntime,
};
