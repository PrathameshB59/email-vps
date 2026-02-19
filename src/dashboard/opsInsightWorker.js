function createOpsInsightWorker({ opsInsightService, pollMs, logger = console }) {
  let timer = null;
  let running = false;

  async function runCycle() {
    try {
      await opsInsightService.collectAndPersist({ trigger: "scheduled" });
      await opsInsightService.cleanupRetention();
    } catch (error) {
      logger.error("[ops-insight-worker] cycle failed:", error);
    }
  }

  async function start() {
    if (running) {
      return;
    }

    running = true;
    await runCycle();

    timer = setInterval(() => {
      runCycle();
    }, pollMs);

    if (typeof timer.unref === "function") {
      timer.unref();
    }
  }

  async function stop() {
    running = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function status() {
    return {
      running,
      pollMs,
      worker: "ops-insight",
      service: opsInsightService.status ? opsInsightService.status() : null,
    };
  }

  return {
    start,
    stop,
    status,
  };
}

module.exports = {
  createOpsInsightWorker,
};
