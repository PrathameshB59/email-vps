#!/usr/bin/env node
const { loadEnv } = require("../config/env");
const { createOpsDaemonServer } = require("../dashboard/services/opsDaemonServer");

async function main() {
  const env = loadEnv();
  const daemon = createOpsDaemonServer({
    env,
    logger: console,
  });

  await daemon.start();

  const stop = async (signal) => {
    try {
      console.log(`[ops-daemon] received ${signal}, shutting down...`);
      await daemon.stop();
      process.exit(0);
    } catch (error) {
      console.error("[ops-daemon] shutdown failed:", error?.message || error);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => {
    void stop("SIGINT");
  });
  process.on("SIGTERM", () => {
    void stop("SIGTERM");
  });
}

main().catch((error) => {
  console.error("[ops-daemon] failed to start:", error?.message || error);
  process.exit(1);
});

