const os = require("os");

const HEALTH_CHECK_CATEGORIES = ["health-check", "postfix-health-check"];

const SCHEDULE = [
  { frequency: "daily", cron: "0 8 * * *", description: "Every day at 08:00 UTC" },
  { frequency: "weekly", cron: "0 9 * * 1", description: "Every Monday at 09:00 UTC" },
  { frequency: "monthly", cron: "0 10 1 * *", description: "1st of month at 10:00 UTC" },
  { frequency: "yearly", cron: "0 11 1 1 *", description: "Jan 1st at 11:00 UTC" },
];

function createHealthCheckService({ env, mailService, repository }) {
  let lastManualAtMs = 0;

  async function getStatus() {
    const lastEvent = await repository.getLastHealthCheckEvent();
    const cooldownSeconds = Number(env.DASHBOARD_MAIL_PROBE_COOLDOWN_SECONDS || 300);
    const nowMs = Date.now();
    const nextAllowedMs = lastManualAtMs ? lastManualAtMs + cooldownSeconds * 1000 : nowMs;
    const remainingCooldownSeconds = Math.max(Math.ceil((nextAllowedMs - nowMs) / 1000), 0);

    return {
      timestamp: new Date().toISOString(),
      lastCheck: lastEvent
        ? {
            sentAt: lastEvent.created_at,
            status: lastEvent.status,
            category: lastEvent.category,
            recipient: lastEvent.to_email,
            errorCode: lastEvent.error_code || null,
          }
        : null,
      schedule: SCHEDULE,
      manual: {
        cooldownSeconds,
        remainingCooldownSeconds,
        lastTriggeredAt: lastManualAtMs ? new Date(lastManualAtMs).toISOString() : null,
      },
    };
  }

  async function sendManual({ requestedByIp = null, dashboardUser = null } = {}) {
    const recipient = String(env.DASHBOARD_MAIL_PROBE_TO || "").trim();
    const cooldownSeconds = Number(env.DASHBOARD_MAIL_PROBE_COOLDOWN_SECONDS || 300);
    const nowMs = Date.now();

    if (!recipient) {
      return {
        ok: false,
        error: "RECIPIENT_NOT_CONFIGURED",
        message: "DASHBOARD_MAIL_PROBE_TO is required.",
      };
    }

    const nextAllowedMs = lastManualAtMs ? lastManualAtMs + cooldownSeconds * 1000 : 0;
    if (nextAllowedMs && nowMs < nextAllowedMs) {
      const retryAfterSeconds = Math.max(Math.ceil((nextAllowedMs - nowMs) / 1000), 1);
      return {
        ok: false,
        error: "COOLDOWN_ACTIVE",
        message: `Cooldown active. Try again in ${retryAfterSeconds} seconds.`,
        retryAfterSeconds,
      };
    }

    const triggerTimestamp = new Date().toISOString();
    const hostname = os.hostname();

    const result = await mailService.sendTemplate(
      {
        to: recipient,
        template: "system-alert",
        category: "health-check",
        variables: {
          title: "Manual Health Check",
          summary: `Manual health check triggered from dashboard on ${hostname}.`,
          impact: "None — this is an operator-initiated delivery verification.",
          probableCause: "Dashboard manual health check.",
          recommendedAction: "Confirm receipt to verify end-to-end delivery.",
          nextUpdateEta: "On next scheduled check",
          details: `Triggered by ${dashboardUser || "dashboard-user"} from ${requestedByIp || "unknown-ip"} at ${triggerTimestamp}.`,
          severity: "info",
          incidentId: `health-manual-${Date.now()}`,
          requestId: `health-manual-${Date.now()}`,
          service: "email-vps",
          environment: env.NODE_ENV || "production",
          dashboardUrl: "https://mail.stackpilot.in/dashboard/mail",
          timestamp: triggerTimestamp,
        },
      },
      { processNow: true }
    );

    lastManualAtMs = nowMs;

    return {
      ok: true,
      triggeredAt: triggerTimestamp,
      recipient,
      result,
    };
  }

  return {
    getStatus,
    sendManual,
  };
}

module.exports = {
  createHealthCheckService,
};
