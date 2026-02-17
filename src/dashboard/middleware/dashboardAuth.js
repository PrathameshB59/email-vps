function createDashboardApiAuthMiddleware({ sessionManager }) {
  return function dashboardApiAuth(req, res, next) {
    const session = sessionManager.readSessionFromRequest(req);
    if (!session) {
      return res.status(401).json({
        error: "DASHBOARD_UNAUTHORIZED",
        message: "Dashboard login required.",
      });
    }

    req.dashboardSession = session.payload;
    return next();
  };
}

function createDashboardPageAuthMiddleware({ sessionManager }) {
  return function dashboardPageAuth(req, res, next) {
    const session = sessionManager.readSessionFromRequest(req);
    if (!session) {
      return res.redirect(302, "/login");
    }

    req.dashboardSession = session.payload;
    return next();
  };
}

module.exports = {
  createDashboardApiAuthMiddleware,
  createDashboardPageAuthMiddleware,
};
