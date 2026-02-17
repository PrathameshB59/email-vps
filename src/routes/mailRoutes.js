const express = require("express");
const { MailValidationError, QuotaExceededError } = require("../mail/errors");

function statusCodeForResult(result) {
  if (result.status === "sent") {
    return 200;
  }
  if (result.status === "failed") {
    return 502;
  }
  return 202;
}

function formatResultBody(result) {
  return {
    requestId: result.requestId,
    queueId: result.queueId,
    status: result.status,
    attempts: result.attempts,
    accepted: result.accepted,
    rejected: result.rejected,
    queued: result.queued,
    errorCode: result.errorCode || null,
    nextAttemptAt: result.nextAttemptAt || null,
  };
}

function createMailRouter({ mailService, rateLimiter, repository }) {
  const router = express.Router();

  router.post("/send", async (req, res, next) => {
    try {
      const result = await mailService.send(req.body || {}, { processNow: true });
      return res.status(statusCodeForResult(result)).json(formatResultBody(result));
    } catch (error) {
      return next(error);
    }
  });

  router.post("/send-template", async (req, res, next) => {
    try {
      const result = await mailService.sendTemplate(req.body || {}, { processNow: true });
      return res.status(statusCodeForResult(result)).json(formatResultBody(result));
    } catch (error) {
      return next(error);
    }
  });

  router.get("/health", async (req, res, next) => {
    try {
      const health = await mailService.getHealthSnapshot();
      return res.status(200).json(health);
    } catch (error) {
      return next(error);
    }
  });

  router.get("/quota", async (req, res, next) => {
    try {
      const quota = await rateLimiter.getSnapshot();
      const queue = await repository.getQueueStats();
      return res.status(200).json({
        ...quota,
        queue,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/events", async (req, res, next) => {
    try {
      const limit = Number(req.query.limit || 25);
      const events = await repository.listRecentEvents(Math.min(Math.max(limit, 1), 200));
      return res.status(200).json({ events });
    } catch (error) {
      return next(error);
    }
  });

  router.use((error, req, res, next) => {
    if (error instanceof QuotaExceededError) {
      return res.status(error.statusCode).json({
        error: error.code,
        message: error.message,
      });
    }

    if (error instanceof MailValidationError) {
      return res.status(error.statusCode).json({
        error: error.code,
        message: error.message,
      });
    }

    return next(error);
  });

  return router;
}

module.exports = {
  createMailRouter,
};
