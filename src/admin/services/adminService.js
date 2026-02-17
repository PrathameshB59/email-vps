function startOfDayIso() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

function createAdminService({ repository, env, alertService }) {
  async function getQuotaSnapshot() {
    const quotaDate = new Date().toISOString().slice(0, 10);
    const quota = await repository.getQuota(quotaDate);

    return {
      quotaDate,
      used: quota.used,
      limit: env.MAIL_DAILY_LIMIT,
      remaining: Math.max(env.MAIL_DAILY_LIMIT - quota.used, 0),
    };
  }

  async function getOverview() {
    const queue = await repository.getQueueStats();
    const quota = await getQuotaSnapshot();
    const since = startOfDayIso();

    const sentToday = await repository.countMailEventsByStatusSince({
      status: "sent",
      sinceIso: since,
    });

    const failedToday = await repository.countMailEventsByStatusSince({
      status: "failed",
      sinceIso: since,
    });

    const retryingToday = await repository.countMailEventsByStatusSince({
      status: "retrying",
      sinceIso: since,
    });

    const relay = await alertService.getRelayHealth();

    return {
      timestamp: new Date().toISOString(),
      sentToday,
      failedToday,
      retryingToday,
      queue,
      quota,
      relay,
    };
  }

  async function getLogs({ limit, offset, status, category }) {
    return repository.listMailLogs({
      limit,
      offset,
      status,
      category,
    });
  }

  async function getRelayHealth() {
    return alertService.getRelayHealth();
  }

  async function getAlerts() {
    return alertService.computeAndPersistAlerts();
  }

  return {
    getQuotaSnapshot,
    getOverview,
    getLogs,
    getRelayHealth,
    getAlerts,
  };
}

module.exports = {
  createAdminService,
};
