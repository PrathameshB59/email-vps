function quotaDateFrom(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function createRateLimiter({ repository, dailyLimit }) {
  return {
    dailyLimit,

    async reserveSlot(date = new Date()) {
      const quotaDate = quotaDateFrom(date);
      const reserved = await repository.reserveQuota(quotaDate, dailyLimit);
      const quota = await repository.getQuota(quotaDate);

      return {
        reserved,
        quotaDate,
        used: quota.used,
        limit: dailyLimit,
        remaining: Math.max(dailyLimit - quota.used, 0),
      };
    },

    async releaseSlot(date = new Date()) {
      const quotaDate = quotaDateFrom(date);
      await repository.releaseQuota(quotaDate);
      const quota = await repository.getQuota(quotaDate);

      return {
        quotaDate,
        used: quota.used,
        limit: dailyLimit,
        remaining: Math.max(dailyLimit - quota.used, 0),
      };
    },

    async getSnapshot(date = new Date()) {
      const quotaDate = quotaDateFrom(date);
      const quota = await repository.getQuota(quotaDate);

      return {
        quotaDate,
        used: quota.used,
        limit: dailyLimit,
        remaining: Math.max(dailyLimit - quota.used, 0),
      };
    },
  };
}

module.exports = {
  createRateLimiter,
  quotaDateFrom,
};
