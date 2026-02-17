const express = require("express");
const path = require("path");
const { createAdminAuthRouter } = require("./routes/authRoutes");
const { createAdminRouter } = require("./routes/adminRoutes");
const { createLoginRateLimitMiddleware } = require("./middleware/loginRateLimit");
const { createAdminAuthMiddleware } = require("./middleware/adminAuth");
const { createCorsMiddleware, createSecurityMiddleware } = require("./middleware/security");

function createAdminApp({ env, authService, adminService }) {
  const app = express();
  const publicDir = path.resolve(__dirname, "public");

  app.disable("x-powered-by");
  app.use(createSecurityMiddleware());
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (req, res) => {
    res.status(200).json({
      service: "email-vps-admin",
      ok: true,
      timestamp: new Date().toISOString(),
    });
  });

  const corsMiddleware = createCorsMiddleware({
    allowedOrigin: env.ADMIN_ALLOWED_ORIGIN,
  });

  app.use("/api/v1/admin", corsMiddleware);

  app.use(
    "/api/v1/admin/auth",
    createLoginRateLimitMiddleware({
      maxRequests: env.ADMIN_LOGIN_RATE_LIMIT,
      windowMs: env.ADMIN_LOGIN_RATE_WINDOW_MS,
    }),
    createAdminAuthRouter({ authService })
  );

  app.use(
    "/api/v1/admin",
    createAdminAuthMiddleware({ env }),
    createAdminRouter({ adminService })
  );

  app.use("/admin/assets", express.static(publicDir));

  app.get("/admin", (req, res) => {
    res.redirect(302, "/admin/login");
  });

  app.get("/admin/login", (req, res) => {
    res.sendFile(path.join(publicDir, "login.html"));
  });

  app.get("/admin/dashboard", (req, res) => {
    res.sendFile(path.join(publicDir, "dashboard.html"));
  });

  app.get("/admin/logs", (req, res) => {
    res.sendFile(path.join(publicDir, "logs.html"));
  });

  app.get("/admin/alerts", (req, res) => {
    res.sendFile(path.join(publicDir, "alerts.html"));
  });

  app.use((err, req, res, next) => {
    console.error("[admin-http] unhandled error:", err);
    res.status(500).json({
      error: "ADMIN_INTERNAL_SERVER_ERROR",
      message: "Unexpected admin server error.",
    });
  });

  return app;
}

module.exports = {
  createAdminApp,
};
