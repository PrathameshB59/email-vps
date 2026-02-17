function createRetryQueue({
  repository,
  mailService,
  pollMs,
  batchSize,
  retentionDays,
  logger = console,
}) {
  let timer = null;
  let running = false;
  let lastCleanupAt = 0;

  async function cleanupIfDue() {
    const now = Date.now();
    const cleanupIntervalMs = 60_000;

    if (now - lastCleanupAt < cleanupIntervalMs) {
      return;
    }

    await repository.cleanupOldEvents(retentionDays);
    lastCleanupAt = now;
  }

  async function processById(queueId) {
    const queueItem = await repository.getQueueItemById(queueId);
    if (!queueItem) {
      return {
        status: "missing",
        attempts: 0,
        accepted: 0,
        rejected: 0,
        queued: false,
        errorCode: "QUEUE_ITEM_NOT_FOUND",
      };
    }

    if (["sent", "failed"].includes(queueItem.status)) {
      return {
        status: queueItem.status,
        attempts: queueItem.attempts,
        accepted: queueItem.status === "sent" ? 1 : 0,
        rejected: queueItem.status === "failed" ? 1 : 0,
        queued: false,
      };
    }

    return mailService.attemptQueueDelivery(queueItem);
  }

  async function tick() {
    if (running) {
      return;
    }

    running = true;

    try {
      await cleanupIfDue();

      const dueItems = await repository.listDueQueueItems(
        new Date().toISOString(),
        batchSize
      );

      for (const item of dueItems) {
        await mailService.attemptQueueDelivery(item);
      }
    } catch (error) {
      logger.error(`[queue] tick failed: ${error.message}`);
    } finally {
      running = false;
    }
  }

  async function start() {
    await repository.resetProcessingToRetrying();
    await tick();

    timer = setInterval(() => {
      tick();
    }, pollMs);

    if (typeof timer.unref === "function") {
      timer.unref();
    }
  }

  async function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    start,
    stop,
    tick,
    processById,
  };
}

module.exports = {
  createRetryQueue,
};
