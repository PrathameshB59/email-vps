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
const { createProgramCheckerService } = require("./dashboard/services/programCheckerService");
const { createMailCheckerService } = require("./dashboard/services/mailCheckerService");
const { createActivityCheckerService } = require("./dashboard/services/activityCheckerService");
const { createOpsInsightService } = require("./dashboard/services/opsInsightService");
const { createOpsCommandService } = require("./dashboard/services/opsCommandService");
const { createOpsDaemonClient } = require("./dashboard/services/opsDaemonClient");
const { createOtpAuthService } = require("./dashboard/services/otpAuthService");
const { createHealthCheckService } = require("./dashboard/services/healthCheckService");
const { createOpsInsightWorker } = require("./dashboard/opsInsightWorker");

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

  const opsInsightService = createOpsInsightService({
    env,
    repository,
    mailService,
    alertService: dashboardAlertService,
    logger,
  });

  const dashboardService = createDashboardService({
    repository,
    env,
    alertService: dashboardAlertService,
    opsInsightService,
  });

  const programCheckerService = createProgramCheckerService({
    env,
    repository,
    opsInsightService,
  });

  const mailCheckerService = createMailCheckerService({
    env,
    repository,
    mailService,
    opsInsightService,
  });

  const activityCheckerService = createActivityCheckerService({
    env,
  });

  const otpAuthService = createOtpAuthService({
    env,
    repository,
    transport: mailTransport,
    logger,
  });

  const healthCheckService = createHealthCheckService({
    env,
    mailService,
    repository,
  });

  const opsDaemonClient = createOpsDaemonClient({
    env,
    logger,
  });

  const opsCommandService = createOpsCommandService({
    env,
    repository,
    opsDaemonClient,
    logger,
  });

  const dashboardSnapshotWorker = createDashboardSnapshotWorker({
    dashboardService,
    pollMs: env.DASHBOARD_METRIC_SNAPSHOT_MINUTES * 60 * 1000,
    logger,
  });

  const opsInsightWorker = createOpsInsightWorker({
    opsInsightService,
    pollMs: env.DASHBOARD_OPS_COLLECT_INTERVAL_SECONDS * 1000,
    logger,
  });

  async function close() {
    await opsInsightWorker.stop();
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
    opsInsightService,
    programCheckerService,
    mailCheckerService,
    activityCheckerService,
    otpAuthService,
    healthCheckService,
    opsDaemonClient,
    opsCommandService,
    dashboardSnapshotWorker,
    opsInsightWorker,
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
    opsInsightService: core.opsInsightService,
    programCheckerService: core.programCheckerService,
    mailCheckerService: core.mailCheckerService,
    activityCheckerService: core.activityCheckerService,
    otpAuthService: core.otpAuthService,
    healthCheckService: core.healthCheckService,
    opsCommandService: core.opsCommandService,
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
