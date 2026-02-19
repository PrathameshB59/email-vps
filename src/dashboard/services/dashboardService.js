const {
  computeRiskScore,
  parseLoad1m,
  parseMemoryUsedPct,
  parsePercent,
  riskLevelFromScore,
} = require("./metrics");

function isoHoursAgo(hours) {
  return new Date(Date.now() - Number(hours) * 60 * 60 * 1000).toISOString();
}

function quotaDateIso() {
  return new Date().toISOString().slice(0, 10);
}

function sanitizeWindow(window) {
  if (window === "7d") return { window: "7d", hours: 24 * 7, bucketMinutes: 120 };
  if (window === "30d") return { window: "30d", hours: 24 * 30, bucketMinutes: 720 };
  return { window: "24h", hours: 24, bucketMinutes: 15 };
}

function downsampleRows(rows, maxPoints) {
  if (rows.length <= maxPoints) {
    return rows;
  }

  const step = Math.ceil(rows.length / maxPoints);
  return rows.filter((row, index) => index % step === 0 || index === rows.length - 1);
}

function round(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  const power = 10 ** digits;
  return Math.round(numeric * power) / power;
}

function pct(part, total, digits = 1) {
  const numerator = Number(part);
  const denominator = Number(total);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }

  return round((numerator / denominator) * 100, digits);
}

function ageMinutesFromIso(isoValue) {
  if (!isoValue) {
    return null;
  }

  const parsed = new Date(isoValue).getTime();
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return round((Date.now() - parsed) / (60 * 1000), 1);
}

function bucketStartIso(isoValue, bucketMinutes) {
  const parsed = new Date(isoValue).getTime();
  if (!Number.isFinite(parsed)) {
    return null;
  }

  const bucketMs = Math.max(1, Number(bucketMinutes)) * 60 * 1000;
  const bucketStart = Math.floor(parsed / bucketMs) * bucketMs;
  return new Date(bucketStart).toISOString();
}

function queuePressureLevel(score) {
  if (score >= 60) return "high";
  if (score >= 30) return "elevated";
  return "stable";
}

function deriveOperationalFocus({
  relayOk,
  riskScore,
  queue,
  queueOldestAgeMinutes,
  quota,
  projectedQuotaPct,
  topErrors,
}) {
  if (!relayOk) {
    return {
      severity: "critical",
      topIssue: "SMTP relay verification is failing.",
      suggestedAction: "Run Postfix relay checks immediately and retry the latest failed queue items.",
      whyThisMatters: "Delivery is blocked while relay health is degraded.",
    };
  }

  if (queue.failed > 0) {
    const headlineError = topErrors[0] ? ` (${topErrors[0].code})` : "";
    return {
      severity: "high",
      topIssue: `Failed queue contains ${queue.failed} message(s)${headlineError}.`,
      suggestedAction: "Review failed events, fix root cause, and manually requeue affected requests.",
      whyThisMatters: "Terminal failures can hide user-facing notification loss.",
    };
  }

  if (queue.retrying > 0 || queueOldestAgeMinutes >= 30) {
    return {
      severity: "warning",
      topIssue: `Retry queue is active (${queue.retrying}) with oldest age ${queueOldestAgeMinutes || 0} min.`,
      suggestedAction: "Inspect transient SMTP/network errors and confirm retry backlog drains over the next cycle.",
      whyThisMatters: "Sustained retries indicate unstable delivery and can spill into quota pressure.",
    };
  }

  const quotaPct = pct(quota.used, quota.limit);
  if (quotaPct >= 85 || projectedQuotaPct >= 90) {
    return {
      severity: "warning",
      topIssue: `Quota burn is high (${quotaPct}% used, projection ${round(projectedQuotaPct, 1)}%).`,
      suggestedAction: "Throttle non-critical notifications and monitor quota trend until reset window.",
      whyThisMatters: "Hitting daily quota blocks all subsequent sends.",
    };
  }

  if (riskScore >= 60) {
    return {
      severity: "warning",
      topIssue: `Composite risk score is elevated (${riskScore}).`,
      suggestedAction: "Validate host controls (disk, ssh failures, fail2ban, metrics freshness) and clear active alerts.",
      whyThisMatters: "System risk can turn into delivery degradation quickly.",
    };
  }

  return {
    severity: "info",
    topIssue: "Delivery and host posture are currently stable.",
    suggestedAction: "Continue regular monitoring and keep baseline security checks green.",
    whyThisMatters: "Stable operations reduce incident response load and improve reliability.",
  };
}

function createDashboardService({
  repository,
  env,
  alertService,
  opsInsightService = {
    async getSecurityDiagnostics() {
      return null;
    },
  },
}) {
  async function getQuotaSnapshot() {
    const quota = await repository.getQuota(quotaDateIso());
    return {
      quotaDate: quotaDateIso(),
      used: quota.used,
      limit: env.MAIL_DAILY_LIMIT,
      remaining: Math.max(env.MAIL_DAILY_LIMIT - quota.used, 0),
    };
  }

  async function collectSignalInputs() {
    const [queue, quota, security] = await Promise.all([
      repository.getQueueStats(),
      getQuotaSnapshot(),
      alertService.getSecuritySignals(),
    ]);

    const since24h = isoHoursAgo(24);
    const [sent24h, failed24h] = await Promise.all([
      repository.countMailEventsByStatusSince({ status: "sent", sinceIso: since24h }),
      repository.countMailEventsByStatusSince({ status: "failed", sinceIso: since24h }),
    ]);

    return {
      queue,
      quota,
      security,
      sent24h,
      failed24h,
    };
  }

  async function captureSnapshot() {
    const signals = await collectSignalInputs();
    const metrics = signals.security.metrics.ok ? signals.security.metrics.data : {};

    const cpuPct = parsePercent(metrics.cpu);
    const memoryUsedPct = parseMemoryUsedPct(metrics.memory_used, metrics.memory_total);
    const diskPct = signals.security.diskPct;
    const load1m = parseLoad1m(metrics.load);

    const riskScore = computeRiskScore({
      baseRisk: signals.security.risk,
      relayOk: signals.security.relay.ok,
      diskPct,
      sshFails: signals.security.sshFails,
      queueFailed: signals.queue.failed,
      queueRetrying: signals.queue.retrying,
      quotaUsed: signals.quota.used,
      quotaLimit: signals.quota.limit,
    });

    return repository.insertDashboardMetricSnapshot({
      cpuPct,
      memoryUsedPct,
      diskPct,
      load1m,
      sshFails24h: signals.security.sshFails,
      pm2Online: signals.security.pm2Online,
      queuePending: signals.queue.pending,
      queueRetrying: signals.queue.retrying,
      queueFailed: signals.queue.failed,
      sent24h: signals.sent24h,
      failed24h: signals.failed24h,
      quotaUsed: signals.quota.used,
      quotaLimit: signals.quota.limit,
      relayOk: signals.security.relay.ok,
      riskScore,
    });
  }

  async function getOverview() {
    const [signals, latest, queueAging] = await Promise.all([
      collectSignalInputs(),
      repository.getLatestDashboardMetricSnapshot(),
      repository.getQueueAgingSnapshot(),
    ]);

    const snapshot = latest || (await captureSnapshot());
    const riskLevel = riskLevelFromScore(snapshot.risk_score || 0);

    return {
      timestamp: new Date().toISOString(),
      sent24h: signals.sent24h,
      failed24h: signals.failed24h,
      queue: signals.queue,
      quota: signals.quota,
      relay: signals.security.relay,
      risk: {
        score: snapshot.risk_score || 0,
        level: riskLevel,
        sourceTag: signals.security.risk,
      },
      latestSnapshot: snapshot,
      queueAging: {
        oldestOpenCreatedAt: queueAging.oldestOpenCreatedAt,
        oldestOpenAgeMinutes: ageMinutesFromIso(queueAging.oldestOpenCreatedAt),
      },
      metrics: {
        load: signals.security.metrics.data?.load || null,
        cpu: signals.security.metrics.data?.cpu || null,
        memoryUsed: signals.security.metrics.data?.memory_used || null,
        memoryTotal: signals.security.metrics.data?.memory_total || null,
        disk: signals.security.metrics.data?.disk || null,
        sshFails: signals.security.sshFails,
        topIp: signals.security.metrics.data?.top_ip || null,
        pm2Online: signals.security.pm2Online,
      },
    };
  }

  async function getTrends(window) {
    const parsedWindow = sanitizeWindow(window);
    const sinceIso = isoHoursAgo(parsedWindow.hours);
    const rows = await repository.listDashboardMetricSnapshotsSince({
      sinceIso,
      limit: 10000,
    });

    const sampled = downsampleRows(rows, 1200);

    return {
      window: parsedWindow.window,
      sinceIso,
      points: sampled.map((row) => ({
        capturedAt: row.captured_at,
        cpuPct: row.cpu_pct,
        memoryUsedPct: row.memory_used_pct,
        diskPct: row.disk_pct,
        load1m: row.load_1m,
        sshFails24h: row.ssh_fails_24h,
        pm2Online: row.pm2_online,
        queuePending: row.queue_pending,
        queueRetrying: row.queue_retrying,
        queueFailed: row.queue_failed,
        sent24h: row.sent_24h,
        failed24h: row.failed_24h,
        quotaUsed: row.quota_used,
        quotaLimit: row.quota_limit,
        relayOk: Boolean(row.relay_ok),
        riskScore: row.risk_score,
      })),
    };
  }

  async function getTimeseries(window) {
    const parsedWindow = sanitizeWindow(window);
    const sinceIso = isoHoursAgo(parsedWindow.hours);
    const bucketMinutes = parsedWindow.bucketMinutes;

    const [statusBuckets, snapshots] = await Promise.all([
      repository.getStatusTimeBuckets(sinceIso, bucketMinutes),
      repository.listDashboardMetricSnapshotsSince({ sinceIso, limit: 10000 }),
    ]);

    const statusMap = new Map();
    for (const row of statusBuckets) {
      const key = new Date(row.bucket_at).toISOString();
      if (!statusMap.has(key)) {
        statusMap.set(key, { sent: 0, failed: 0, retrying: 0 });
      }

      const bucket = statusMap.get(key);
      if (row.status === "sent") bucket.sent = Number(row.count || 0);
      if (row.status === "failed") bucket.failed = Number(row.count || 0);
      if (row.status === "retrying") bucket.retrying = Number(row.count || 0);
    }

    const snapshotMap = new Map();
    for (const snapshot of snapshots) {
      const key = bucketStartIso(snapshot.captured_at, bucketMinutes);
      if (key) {
        snapshotMap.set(key, snapshot);
      }
    }

    const bucketMs = bucketMinutes * 60 * 1000;
    const startMs = Math.floor(new Date(sinceIso).getTime() / bucketMs) * bucketMs;
    const endMs = Date.now();

    const points = [];
    let carrySnapshot = null;

    for (let cursor = startMs; cursor <= endMs; cursor += bucketMs) {
      const key = new Date(cursor).toISOString();
      const status = statusMap.get(key) || { sent: 0, failed: 0, retrying: 0 };
      if (snapshotMap.has(key)) {
        carrySnapshot = snapshotMap.get(key);
      }

      const quotaLimit = Number(carrySnapshot?.quota_limit || env.MAIL_DAILY_LIMIT);
      const quotaUsed =
        carrySnapshot && Number.isFinite(Number(carrySnapshot.quota_used))
          ? Number(carrySnapshot.quota_used)
          : null;
      const quotaPct =
        quotaUsed == null || quotaLimit <= 0 ? null : round((quotaUsed / quotaLimit) * 100, 1);

      points.push({
        bucketStart: key,
        sent: status.sent,
        failed: status.failed,
        retrying: status.retrying,
        riskScore:
          carrySnapshot && Number.isFinite(Number(carrySnapshot.risk_score))
            ? Number(carrySnapshot.risk_score)
            : null,
        quotaPct,
        relayOk: carrySnapshot ? Boolean(carrySnapshot.relay_ok) : null,
      });
    }

    return {
      window: parsedWindow.window,
      sinceIso,
      bucketMinutes,
      points,
      labels: points.map((point) => point.bucketStart),
      series: {
        sent: points.map((point) => point.sent),
        failed: points.map((point) => point.failed),
        retrying: points.map((point) => point.retrying),
        riskScore: points.map((point) => point.riskScore),
        quotaPct: points.map((point) => point.quotaPct),
        relayOk: points.map((point) => point.relayOk),
      },
    };
  }

  async function getInsights(window) {
    const parsedWindow = sanitizeWindow(window);
    const sinceIso = isoHoursAgo(parsedWindow.hours);
    const previousSinceIso = isoHoursAgo(parsedWindow.hours * 2);

    const [
      queue,
      quota,
      deliveryFunnel,
      topErrorsRaw,
      categoryBreakdownRaw,
      queueAging,
      quotaBurn,
      latestSnapshotRaw,
      previousSnapshot,
      sentCurrent,
      sentPrevious,
      failedCurrent,
      failedPrevious,
    ] = await Promise.all([
      repository.getQueueStats(),
      getQuotaSnapshot(),
      repository.getDeliveryFunnel(sinceIso),
      repository.getTopErrorCodes(sinceIso, 6),
      repository.getCategoryBreakdown(sinceIso),
      repository.getQueueAgingSnapshot(),
      repository.getQuotaBurnRate(sinceIso),
      repository.getLatestDashboardMetricSnapshot(),
      repository.getLatestDashboardMetricSnapshotBefore({ beforeIso: sinceIso }),
      repository.countMailEventsByStatusSince({ status: "sent", sinceIso }),
      repository.countMailEventsByStatusBetween({
        status: "sent",
        startIso: previousSinceIso,
        endIso: sinceIso,
      }),
      repository.countMailEventsByStatusSince({ status: "failed", sinceIso }),
      repository.countMailEventsByStatusBetween({
        status: "failed",
        startIso: previousSinceIso,
        endIso: sinceIso,
      }),
    ]);

    const latestSnapshot = latestSnapshotRaw || (await captureSnapshot());
    const riskScore = Number(latestSnapshot?.risk_score || 0);
    const riskLevel = riskLevelFromScore(riskScore);

    const funnelTotal = Number(deliveryFunnel.totalRequests || 0);
    const sentRequests = Number(deliveryFunnel.sentRequests || 0);
    const failedRequests = Number(deliveryFunnel.failedRequests || 0);
    const retryingRequests = Number(deliveryFunnel.retryingRequests || 0);
    const queuedRequests = Number(deliveryFunnel.queuedRequests || 0);

    const sentCount = Number(quotaBurn.sentCount || 0);
    const windowHours = Math.max(1, parsedWindow.hours);
    const burnPerHour = sentCount / windowHours;
    const projected24h = burnPerHour * 24;
    const projectedQuotaPct = pct(projected24h, quota.limit, 1);

    const categoryTotal = categoryBreakdownRaw.reduce((sum, row) => sum + Number(row.count || 0), 0);
    const categories = categoryBreakdownRaw.map((row) => ({
      category: row.category,
      count: Number(row.count || 0),
      percent: pct(row.count || 0, categoryTotal, 1),
    }));

    const errorTotal = topErrorsRaw.reduce((sum, row) => sum + Number(row.count || 0), 0);
    const topErrors = topErrorsRaw.map((row) => ({
      code: row.code,
      count: Number(row.count || 0),
      percent: pct(row.count || 0, errorTotal || 1, 1),
    }));

    const queueOldestAgeMinutes = ageMinutesFromIso(queueAging.oldestOpenCreatedAt) || 0;
    const queuePressureScore = Math.min(
      100,
      round(
        queue.retrying * 3 +
          queue.failed * 10 +
          Math.max(0, queue.pending - 10) * 1.5 +
          Math.max(0, queueOldestAgeMinutes - 20) * 0.7,
        1
      )
    );

    const focus = deriveOperationalFocus({
      relayOk: Boolean(latestSnapshot?.relay_ok),
      riskScore,
      queue,
      queueOldestAgeMinutes,
      quota,
      projectedQuotaPct,
      topErrors,
    });

    return {
      window: parsedWindow.window,
      sinceIso,
      generatedAt: new Date().toISOString(),
      deliveryFunnel: {
        totalRequests: funnelTotal,
        sentRequests,
        failedRequests,
        retryingRequests,
        queuedRequests,
        successRatePct: pct(sentRequests, funnelTotal, 1),
        failureRatePct: pct(failedRequests, funnelTotal, 1),
        retryRatePct: pct(retryingRequests, funnelTotal, 1),
      },
      quota: {
        used: quota.used,
        limit: quota.limit,
        remaining: quota.remaining,
        usedPct: pct(quota.used, quota.limit, 1),
        burnPerHour: round(burnPerHour, 2),
        projected24h: round(projected24h, 1),
        projectedQuotaPct,
      },
      risk: {
        score: riskScore,
        level: riskLevel,
      },
      queue: {
        pending: queue.pending,
        retrying: queue.retrying,
        failed: queue.failed,
        oldestAgeMinutes: queueOldestAgeMinutes,
        pressureScore: queuePressureScore,
        pressureLevel: queuePressureLevel(queuePressureScore),
      },
      topErrors,
      categoryMix: categories,
      kpiDeltas: {
        sent: sentCurrent - sentPrevious,
        failed: failedCurrent - failedPrevious,
        retrying: Number(queue.retrying || 0) - Number(previousSnapshot?.queue_retrying || 0),
        risk: riskScore - Number(previousSnapshot?.risk_score || riskScore),
      },
      actionPlan: {
        severity: focus.severity,
        topIssue: focus.topIssue,
        suggestedAction: focus.suggestedAction,
        whyThisMatters: focus.whyThisMatters,
      },
    };
  }

  async function getLogs({ limit, offset, status, category, severity, query }) {
    return repository.listMailLogsMetadata({
      limit,
      offset,
      status,
      category,
      severity,
      query,
    });
  }

  async function getAlerts() {
    const [queue, quota] = await Promise.all([repository.getQueueStats(), getQuotaSnapshot()]);

    return alertService.computeAndPersistAlerts({ queue, quota });
  }

  async function getSecurity() {
    const [signals, alerts, opsDiagnostics] = await Promise.all([
      collectSignalInputs(),
      repository.listSystemAlertState(100),
      opsInsightService.getSecurityDiagnostics().catch(() => null),
    ]);

    const riskScore = computeRiskScore({
      baseRisk: signals.security.risk,
      relayOk: signals.security.relay.ok,
      diskPct: signals.security.diskPct,
      sshFails: signals.security.sshFails,
      queueFailed: signals.queue.failed,
      queueRetrying: signals.queue.retrying,
      quotaUsed: signals.quota.used,
      quotaLimit: signals.quota.limit,
    });

    return {
      timestamp: new Date().toISOString(),
      risk: {
        score: riskScore,
        level: riskLevelFromScore(riskScore),
        sourceTag: signals.security.risk,
      },
      relay: signals.security.relay,
      metrics: {
        freshnessMinutes:
          signals.security.metricsAgeMinutes == null
            ? null
            : Number(signals.security.metricsAgeMinutes.toFixed(1)),
        diskPct: signals.security.diskPct,
        sshFails24h: signals.security.sshFails,
        pm2Online: signals.security.pm2Online,
        metricsPath: signals.security.metrics.path,
      },
      controls: {
        fail2banAvailable: Boolean(signals.security.fail2banSummary),
        fail2banSummary: signals.security.fail2banSummary,
        aideBaselinePresent: signals.security.aideBaselinePresent,
        lastDailyReportPath: signals.security.reportPath,
        aideLastCheckAt: opsDiagnostics?.aideLastCheckAt || null,
        fail2banJailSummary: opsDiagnostics?.fail2banJailSummary || null,
        fail2banJails: Array.isArray(opsDiagnostics?.fail2banJails)
          ? opsDiagnostics.fail2banJails
          : [],
        controlFreshness:
          opsDiagnostics?.controlFreshnessMinutes == null
            ? null
            : Number(opsDiagnostics.controlFreshnessMinutes),
      },
      alerts,
    };
  }

  async function cleanupRetention() {
    await Promise.all([
      repository.cleanupOldEvents(env.LOG_RETENTION_DAYS),
      repository.cleanupOldDashboardMetricSnapshots(env.DASHBOARD_RETENTION_DAYS),
    ]);
  }

  return {
    captureSnapshot,
    getOverview,
    getTrends,
    getTimeseries,
    getInsights,
    getLogs,
    getAlerts,
    getSecurity,
    cleanupRetention,
  };
}

module.exports = {
  createDashboardService,
};
