const express = require("express");
const path = require("path");
const { createAuthTokenMiddleware } = require("./middleware/authToken");
const { createLocalOnlyMiddleware } = require("./middleware/localOnly");
const { createMailRouter } = require("./routes/mailRoutes");

function createApp({ env, mailService, rateLimiter, repository }) {
  const app = express();
  const staticRoot = path.resolve(__dirname, "..");

  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  app.use(express.static(staticRoot));

  app.use(
    "/api/v1/mail",
    createLocalOnlyMiddleware({
      allowNonLocal: env.MAIL_ALLOW_NON_LOCAL,
      allowTestHeader: env.NODE_ENV === "test",
    }),
    createAuthTokenMiddleware(env.MAIL_API_TOKEN),
    createMailRouter({ mailService, rateLimiter, repository })
  );

  app.use((err, req, res, next) => {
    console.error("[http] unhandled error:", err);
    res.status(500).json({
      error: "INTERNAL_SERVER_ERROR",
      message: "Unexpected server error.",
    });
  });

  return app;
}

module.exports = {
  createApp,
};
