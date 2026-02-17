const { startServer } = require("./src/server");

startServer().catch((error) => {
  console.error("[email-vps] Failed to start server:", error);
  process.exit(1);
});
