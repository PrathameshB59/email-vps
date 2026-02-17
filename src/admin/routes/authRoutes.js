const express = require("express");
const { AdminAuthError, AdminValidationError } = require("../errors");

function createAdminAuthRouter({ authService }) {
  const router = express.Router();

  router.post("/login", async (req, res, next) => {
    try {
      const result = await authService.login({
        email: req.body?.email,
        password: req.body?.password,
        ip: req.socket?.remoteAddress || req.ip || null,
        userAgent: req.get("user-agent") || null,
      });

      return res.status(200).json(result);
    } catch (error) {
      return next(error);
    }
  });

  router.post("/refresh", async (req, res, next) => {
    try {
      const result = await authService.refresh({
        refreshToken: req.body?.refreshToken,
        ip: req.socket?.remoteAddress || req.ip || null,
        userAgent: req.get("user-agent") || null,
      });

      return res.status(200).json(result);
    } catch (error) {
      return next(error);
    }
  });

  router.post("/logout", async (req, res, next) => {
    try {
      const result = await authService.logout({
        refreshToken: req.body?.refreshToken,
        ip: req.socket?.remoteAddress || req.ip || null,
      });

      return res.status(200).json(result);
    } catch (error) {
      return next(error);
    }
  });

  router.use((error, req, res, next) => {
    if (error instanceof AdminValidationError || error instanceof AdminAuthError) {
      return res.status(error.statusCode).json({
        error: error.code,
        message: error.message,
      });
    }

    return next(error);
  });

  return router;
}

module.exports = {
  createAdminAuthRouter,
};
