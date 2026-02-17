const { loadEnv } = require("./config/env");
const { createApp } = require("./app");
const { createRepository } = require("./mail/repository");
const { createRateLimiter } = require("./mail/rateLimiter");
const { createMailTransport } = require("./mail/transporter");
const { createMailService } = require("./mail/mailService");
const { createRetryQueue } = require("./mail/retryQueue");

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

  async function close() {
    await retryQueue.stop();
    await repository.close();
  }

  return {
    env,
    repository,
    rateLimiter,
    mailService,
    retryQueue,
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
