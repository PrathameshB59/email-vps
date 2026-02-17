function createDashboardSnapshotWorker({ dashboardService, pollMs, logger = console }) {
  let timer = null;
  let running = false;

  async function runCycle() {
    try {
      await dashboardService.captureSnapshot();
      await dashboardService.cleanupRetention();
    } catch (error) {
      logger.error("[dashboard-snapshot-worker] cycle failed:", error);
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
    };
  }

  return {
    start,
    stop,
    status,
  };
}

module.exports = {
  createDashboardSnapshotWorker,
};
