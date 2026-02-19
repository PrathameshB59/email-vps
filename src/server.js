const { createRuntime } = require("./runtime");

async function startServer() {
  const runtime = await createRuntime();
  await runtime.retryQueue.start();
  await runtime.dashboardSnapshotWorker.start();
  await runtime.opsInsightWorker.start();

  const server = runtime.app.listen(runtime.env.PORT, runtime.env.HOST, () => {
    console.log(
      `[email-vps] HTTP server running on ${runtime.env.HOST}:${runtime.env.PORT}`
    );
  });

  async function shutdown(signal) {
    console.log(`[email-vps] Received ${signal}. Shutting down.`);

    server.close(async () => {
      try {
        await runtime.close();
        console.log("[email-vps] Shutdown complete.");
        process.exit(0);
      } catch (error) {
        console.error("[email-vps] Shutdown failed:", error);
        process.exit(1);
      }
    });
  }

  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });

  return {
    server,
    runtime,
  };
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("[email-vps] Failed to start server:", error);
    process.exit(1);
  });
}

module.exports = {
  startServer,
};
