const { randomUUID } = require("crypto");
const { calculateBackoffMs, classifyDeliveryError } = require("./deliveryPolicy");
const { MailValidationError, QuotaExceededError } = require("./errors");
const { renderTemplate } = require("./templateRegistry");
const { verifyMailTransport } = require("./transporter");

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isLikelyEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function normalizeCategory(value) {
  const category = String(value || "app-notification").trim().toLowerCase();
  if (!category) {
    return "app-notification";
  }
  return category;
}

function getAcceptedCount(info) {
  if (!info || !Array.isArray(info.accepted)) {
    return 0;
  }
  return info.accepted.length;
}

function getRejectedCount(info) {
  if (!info || !Array.isArray(info.rejected)) {
    return 0;
  }
  return info.rejected.length;
}

function createMailService({ env, repository, rateLimiter, transport, logger = console }) {
  let queueWorker = null;

  function attachQueueWorker(worker) {
    queueWorker = worker;
  }

  function validateDirectRequest(input) {
    const to = normalizeEmail(input.to);
    const subject = String(input.subject || "").trim();
    const text = typeof input.text === "string" ? input.text.trim() : "";
    const html = typeof input.html === "string" ? input.html.trim() : "";
    const category = normalizeCategory(input.category);

    if (!to || !isLikelyEmail(to)) {
      throw new MailValidationError("A valid recipient email is required in field 'to'.");
    }

    if (!subject) {
      throw new MailValidationError("A non-empty 'subject' is required.");
    }

    if (!text && !html) {
      throw new MailValidationError("At least one body format is required: 'text' or 'html'.");
    }

    return { to, subject, text, html, category };
  }

  async function reserveQuotaOrThrow() {
    const quotaResult = await rateLimiter.reserveSlot();
    if (!quotaResult.reserved) {
      throw new QuotaExceededError(
        `Daily mail limit reached (${quotaResult.limit}/${quotaResult.limit}) for ${quotaResult.quotaDate}.`
      );
    }
    return quotaResult;
  }

  async function enqueueFromPayload(payload, { processNow = true } = {}) {
    const quotaResult = await reserveQuotaOrThrow();
    const requestId = randomUUID();

    let queueItem;
    try {
      queueItem = await repository.enqueueMail({
        requestId,
        toEmail: payload.to,
        subject: payload.subject,
        textBody: payload.text || null,
        htmlBody: payload.html || null,
        category: payload.category,
        payloadJson: JSON.stringify(payload),
        maxAttempts: env.MAIL_RETRY_MAX,
      });
    } catch (error) {
      await rateLimiter.releaseSlot();
      throw error;
    }

    await repository.recordEvent({
      queueId: queueItem.id,
      requestId,
      eventType: "queued",
      status: "queued",
      attempt: 0,
      toEmail: payload.to,
      subject: payload.subject,
      category: payload.category,
      metadataJson: JSON.stringify({ quotaDate: quotaResult.quotaDate }),
    });

    if (processNow && queueWorker) {
      const processedResult = await queueWorker.processById(queueItem.id);
      return {
        requestId,
        queueId: queueItem.id,
        ...processedResult,
      };
    }

    return {
      requestId,
      queueId: queueItem.id,
      status: "queued",
      attempts: 0,
      accepted: 0,
      rejected: 0,
      queued: true,
      nextAttemptAt: queueItem.next_attempt_at,
    };
  }

  async function send(payload, options = {}) {
    const normalized = validateDirectRequest(payload);
    return enqueueFromPayload(normalized, options);
  }

  async function sendTemplate(input, options = {}) {
    const to = normalizeEmail(input.to);
    if (!to || !isLikelyEmail(to)) {
      throw new MailValidationError("A valid recipient email is required in field 'to'.");
    }

    if (!input.template) {
      throw new MailValidationError("Template name is required in field 'template'.");
    }

    const rendered = renderTemplate(input.template, input.variables || {}, {
      subject: input.subject,
      text: input.text,
      html: input.html,
    });

    return enqueueFromPayload(
      {
        to,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        category: normalizeCategory(input.category || input.template),
      },
      options
    );
  }

  async function attemptQueueDelivery(queueItem) {
    const lockAcquired = await repository.markProcessing(queueItem.id);
    if (!lockAcquired) {
      const current = await repository.getQueueItemById(queueItem.id);
      return {
        status: current?.status || "missing",
        attempts: current?.attempts || 0,
        accepted: current?.status === "sent" ? 1 : 0,
        rejected: current?.status === "failed" ? 1 : 0,
        queued: current?.status === "pending" || current?.status === "retrying",
        errorCode: "QUEUE_LOCK_NOT_ACQUIRED",
      };
    }

    const attempts = Number(queueItem.attempts) + 1;

    try {
      const info = await transport.sendMail({
        from: env.MAIL_FROM,
        to: queueItem.to_email,
        subject: queueItem.subject,
        text: queueItem.text_body || undefined,
        html: queueItem.html_body || undefined,
      });

      const accepted = getAcceptedCount(info);
      const rejected = getRejectedCount(info);

      await repository.markSent(queueItem.id, attempts);
      await repository.recordEvent({
        queueId: queueItem.id,
        requestId: queueItem.request_id,
        eventType: "sent",
        status: "sent",
        attempt: attempts,
        toEmail: queueItem.to_email,
        subject: queueItem.subject,
        category: queueItem.category,
        accepted,
        rejected,
        metadataJson: JSON.stringify({ messageId: info?.messageId || null }),
      });

      return {
        status: "sent",
        attempts,
        accepted,
        rejected,
        queued: false,
      };
    } catch (error) {
      const classified = classifyDeliveryError(error);
      const maxAttempts = Number(queueItem.max_attempts) || env.MAIL_RETRY_MAX;
      const canRetry = classified.transient && attempts < maxAttempts;

      if (canRetry) {
        const backoffMs = calculateBackoffMs(env.MAIL_RETRY_BASE_MS, attempts);
        const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();

        await repository.markRetry(
          queueItem.id,
          attempts,
          nextAttemptAt,
          classified.code,
          classified.message
        );

        await repository.recordEvent({
          queueId: queueItem.id,
          requestId: queueItem.request_id,
          eventType: "retry_scheduled",
          status: "retrying",
          attempt: attempts,
          toEmail: queueItem.to_email,
          subject: queueItem.subject,
          category: queueItem.category,
          errorCode: classified.code,
          errorMessage: classified.message,
          metadataJson: JSON.stringify({ nextAttemptAt, backoffMs }),
        });

        logger.warn(
          `[mail] retry scheduled request=${queueItem.request_id} attempt=${attempts} code=${classified.code}`
        );

        return {
          status: "retrying",
          attempts,
          accepted: 0,
          rejected: 1,
          queued: true,
          errorCode: classified.code,
          nextAttemptAt,
        };
      }

      await repository.markFailed(queueItem.id, attempts, classified.code, classified.message);

      await repository.recordEvent({
        queueId: queueItem.id,
        requestId: queueItem.request_id,
        eventType: "failed",
        status: "failed",
        attempt: attempts,
        toEmail: queueItem.to_email,
        subject: queueItem.subject,
        category: queueItem.category,
        accepted: 0,
        rejected: 1,
        errorCode: classified.code,
        errorMessage: classified.message,
      });

      logger.error(
        `[mail] delivery failed request=${queueItem.request_id} attempt=${attempts} code=${classified.code}`
      );

      return {
        status: "failed",
        attempts,
        accepted: 0,
        rejected: 1,
        queued: false,
        errorCode: classified.code,
      };
    }
  }

  async function getHealthSnapshot() {
    const relay = await verifyMailTransport(transport);
    const queue = await repository.getQueueStats();
    const quota = await rateLimiter.getSnapshot();

    return {
      service: "email-vps",
      timestamp: new Date().toISOString(),
      relay: {
        host: env.MAIL_RELAY_HOST,
        port: env.MAIL_RELAY_PORT,
        secure: env.MAIL_RELAY_SECURE,
        ok: relay.ok,
        errorCode: relay.code || null,
        errorMessage: relay.message || null,
      },
      queue,
      quota,
    };
  }

  return {
    attachQueueWorker,
    send,
    sendTemplate,
    attemptQueueDelivery,
    getHealthSnapshot,
  };
}

module.exports = {
  createMailService,
};
