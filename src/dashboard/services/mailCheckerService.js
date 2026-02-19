function isoHoursAgo(hours) {
  return new Date(Date.now() - Number(hours) * 60 * 60 * 1000).toISOString();
}

function pct(part, total, digits = 1) {
  const numerator = Number(part);
  const denominator = Number(total);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }
  const power = 10 ** digits;
  return Math.round(((numerator / denominator) * 100) * power) / power;
}

class MailProbeError extends Error {
  constructor({ code, message, statusCode = 400, retryAfterSeconds = null }) {
    super(message);
    this.name = "MailProbeError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function createMailCheckerService({
  env,
  repository,
  mailService,
  opsInsightService = {
    async getMailDiagnostics() {
      return null;
    },
  },
}) {
  let lastProbeAtMs = 0;

  async function getLastSuccessfulDelivery() {
    const rows = await repository.listMailLogsMetadata({
      limit: 1,
      offset: 0,
      status: "sent",
      category: null,
      severity: null,
      query: null,
    });

    if (!rows.length) {
      return null;
    }

    return rows[0].created_at || null;
  }

  async function getMailCheck() {
    const sinceIso = isoHoursAgo(24);
    const [
      health,
      sent24h,
      failed24h,
      retrying24h,
      topErrors,
      recentEvents,
      lastSuccessAt,
      opsDiagnostics,
    ] = await Promise.all([
      mailService.getHealthSnapshot(),
      repository.countMailEventsByStatusSince({ status: "sent", sinceIso }),
      repository.countMailEventsByStatusSince({ status: "failed", sinceIso }),
      repository.countMailEventsByStatusSince({ status: "retrying", sinceIso }),
      repository.getTopErrorCodes(sinceIso, 6),
      repository.listRecentEvents(30),
      getLastSuccessfulDelivery(),
      opsInsightService.getMailDiagnostics().catch(() => null),
    ]);

    const total24h = Number(sent24h || 0) + Number(failed24h || 0) + Number(retrying24h || 0);
    const cooldownSeconds = Number(env.DASHBOARD_MAIL_PROBE_COOLDOWN_SECONDS || 300);
    const nowMs = Date.now();
    const nextAllowedMs = lastProbeAtMs ? lastProbeAtMs + cooldownSeconds * 1000 : nowMs;
    const remainingCooldownSeconds = Math.max(Math.ceil((nextAllowedMs - nowMs) / 1000), 0);

    const recentProblems = recentEvents
      .filter((event) => ["failed", "retrying"].includes(String(event.status || "").toLowerCase()))
      .slice(0, 10)
      .map((event) => ({
        requestId: event.request_id,
        status: event.status,
        to: event.to_email,
        createdAt: event.created_at,
        errorCode: event.error_code || null,
        errorMessage: event.error_message || null,
      }));

    return {
      timestamp: new Date().toISOString(),
      relay: health.relay,
      queue: health.queue,
      quota: health.quota,
      delivery24h: {
        total: total24h,
        sent: Number(sent24h || 0),
        failed: Number(failed24h || 0),
        retrying: Number(retrying24h || 0),
        successRatePct: pct(sent24h, total24h, 1),
        failureRatePct: pct(failed24h, total24h, 1),
      },
      topErrors: (topErrors || []).map((item) => ({
        code: item.code,
        count: Number(item.count || 0),
      })),
      lastSuccessfulDeliveryAt: lastSuccessAt,
      recentProblems,
      probe: {
        recipientConfigured: Boolean(String(env.DASHBOARD_MAIL_PROBE_TO || "").trim()),
        recipient: String(env.DASHBOARD_MAIL_PROBE_TO || "").trim() || null,
        cooldownSeconds,
        lastTriggeredAt: lastProbeAtMs ? new Date(lastProbeAtMs).toISOString() : null,
        nextAllowedAt: nextAllowedMs ? new Date(nextAllowedMs).toISOString() : null,
        remainingCooldownSeconds,
      },
      postfixConfigHealth: opsDiagnostics?.postfixConfigHealth || {
        health: "unknown",
        duplicateCount: 0,
        warningCount: 0,
        issues: [],
      },
      cronNoiseHealth: opsDiagnostics?.cronNoiseHealth || {
        health: "unknown",
        staleReferences: 0,
        expectedReferences: 0,
        schedulerState: "unknown",
      },
      logwatchSummary: opsDiagnostics?.logwatchSummary || {
        health: "unknown",
        source: null,
        warningCount: 0,
        bySource: {},
      },
      postfixWarningCounts: opsDiagnostics?.postfixWarningCounts || {
        total: 0,
        byCode: {},
      },
    };
  }

  async function sendProbe({ requestedByIp = null, dashboardUser = null } = {}) {
    const probeRecipient = String(env.DASHBOARD_MAIL_PROBE_TO || "").trim();
    const cooldownSeconds = Number(env.DASHBOARD_MAIL_PROBE_COOLDOWN_SECONDS || 300);
    const nowMs = Date.now();

    if (!probeRecipient) {
      throw new MailProbeError({
        code: "MAIL_PROBE_RECIPIENT_NOT_CONFIGURED",
        message: "DASHBOARD_MAIL_PROBE_TO is required to send manual probe mail.",
        statusCode: 400,
      });
    }

    const nextAllowedMs = lastProbeAtMs ? lastProbeAtMs + cooldownSeconds * 1000 : 0;
    if (nextAllowedMs && nowMs < nextAllowedMs) {
      const retryAfterSeconds = Math.max(Math.ceil((nextAllowedMs - nowMs) / 1000), 1);
      throw new MailProbeError({
        code: "MAIL_PROBE_COOLDOWN_ACTIVE",
        message: "Manual probe cooldown is active. Try again shortly.",
        statusCode: 429,
        retryAfterSeconds,
      });
    }

    const incidentId = `probe-${Date.now()}`;
    const triggerTimestamp = new Date().toISOString();
    const healthSnapshot = await mailService.getHealthSnapshot();
    const queueSnapshot = healthSnapshot?.queue || {};

    const result = await mailService.sendTemplate(
      {
        to: probeRecipient,
        template: "delivery-probe",
        category: "mail-probe",
        variables: {
          title: "Manual Delivery Probe",
          summary: "A manual mail probe was triggered from the dashboard.",
          impact: "This validates end-to-end delivery from queue, relay, and provider.",
          probableCause: "Operator-initiated health verification.",
          recommendedAction: "Confirm receipt and verify latest status in /dashboard/mail.",
          nextUpdateEta: "Immediate",
          details: `Probe initiated by ${dashboardUser || "dashboard-user"} from ${requestedByIp || "unknown-ip"}.`,
          severity: "info",
          incidentId,
          requestId: incidentId,
          service: "email-vps",
          environment: env.NODE_ENV || "production",
          dashboardUrl: "https://mail.stackpilot.in/dashboard/mail",
          runbookUrl: "https://mail.stackpilot.in/dashboard/operations",
          triggerSource: "dashboard-manual-probe",
          triggeredBy: `${dashboardUser || "dashboard-user"} (${requestedByIp || "unknown-ip"})`,
          probeRecipient,
          queuePending: String(queueSnapshot.pending ?? 0),
          queueRetrying: String(queueSnapshot.retrying ?? 0),
          queueFailed: String(queueSnapshot.failed ?? 0),
          relayHost: String(env.MAIL_RELAY_HOST || "127.0.0.1"),
          relayPort: String(env.MAIL_RELAY_PORT || 25),
          timestamp: triggerTimestamp,
        },
      },
      { processNow: true }
    );

    lastProbeAtMs = nowMs;
    const nextProbeAllowedAt = new Date(lastProbeAtMs + cooldownSeconds * 1000).toISOString();

    return {
      ok: true,
      triggeredAt: triggerTimestamp,
      recipient: probeRecipient,
      nextProbeAllowedAt,
      result,
    };
  }

  return {
    getMailCheck,
    sendProbe,
  };
}

module.exports = {
  MailProbeError,
  createMailCheckerService,
};
