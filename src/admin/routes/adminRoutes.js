const express = require("express");

function parseIntParam(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function createAdminRouter({ adminService }) {
  const router = express.Router();

  router.get("/overview", async (req, res, next) => {
    try {
      const data = await adminService.getOverview();
      return res.status(200).json(data);
    } catch (error) {
      return next(error);
    }
  });

  router.get("/logs", async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(parseIntParam(req.query.limit, 50), 1), 500);
      const offset = Math.max(parseIntParam(req.query.offset, 0), 0);
      const status = req.query.status ? String(req.query.status) : null;
      const category = req.query.category ? String(req.query.category) : null;

      const logs = await adminService.getLogs({
        limit,
        offset,
        status,
        category,
      });

      return res.status(200).json({
        logs,
        limit,
        offset,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/quota", async (req, res, next) => {
    try {
      const quota = await adminService.getQuotaSnapshot();
      return res.status(200).json(quota);
    } catch (error) {
      return next(error);
    }
  });

  router.get("/alerts", async (req, res, next) => {
    try {
      const alerts = await adminService.getAlerts();
      return res.status(200).json({ alerts });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/relay-health", async (req, res, next) => {
    try {
      const relay = await adminService.getRelayHealth();
      return res.status(200).json(relay);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = {
  createAdminRouter,
};
