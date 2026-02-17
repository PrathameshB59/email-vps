const { createAdminRuntime } = require("./runtime");

async function startAdminServer() {
  const runtime = await createAdminRuntime();

  const server = runtime.app.listen(runtime.env.ADMIN_PORT, runtime.env.ADMIN_HOST, () => {
    console.log(
      `[email-vps-admin] HTTP server running on ${runtime.env.ADMIN_HOST}:${runtime.env.ADMIN_PORT}`
    );
  });

  async function shutdown(signal) {
    console.log(`[email-vps-admin] Received ${signal}. Shutting down.`);

    server.close(async () => {
      try {
        await runtime.close();
        console.log("[email-vps-admin] Shutdown complete.");
        process.exit(0);
      } catch (error) {
        console.error("[email-vps-admin] Shutdown failed:", error);
        process.exit(1);
      }
    });
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return {
    server,
    runtime,
  };
}

if (require.main === module) {
  startAdminServer().catch((error) => {
    console.error("[email-vps-admin] Failed to start server:", error);
    process.exit(1);
  });
}

module.exports = {
  startAdminServer,
};
