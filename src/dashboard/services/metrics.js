const fs = require("fs");
const path = require("path");

function parsePercent(value) {
  const matched = String(value || "").match(/(\d+(?:\.\d+)?)%/);
  if (!matched) {
    return null;
  }

  return Number(matched[1]);
}

function parseLoad1m(value) {
  const first = String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .find(Boolean);

  if (!first) {
    return null;
  }

  const parsed = Number(first);
  return Number.isFinite(parsed) ? parsed : null;
}

function unitFactor(unit) {
  const normalized = String(unit || "").toLowerCase();
  if (normalized === "k" || normalized === "kb") return 1000;
  if (normalized === "m" || normalized === "mb") return 1000 ** 2;
  if (normalized === "g" || normalized === "gb") return 1000 ** 3;
  if (normalized === "t" || normalized === "tb") return 1000 ** 4;
  if (normalized === "ki" || normalized === "kib") return 1024;
  if (normalized === "mi" || normalized === "mib") return 1024 ** 2;
  if (normalized === "gi" || normalized === "gib") return 1024 ** 3;
  if (normalized === "ti" || normalized === "tib") return 1024 ** 4;
  return 1;
}

function parseMemoryBytes(value) {
  const matched = String(value || "").trim().match(/^(\d+(?:\.\d+)?)([a-zA-Z]*)$/);
  if (!matched) {
    return null;
  }

  const amount = Number(matched[1]);
  if (!Number.isFinite(amount)) {
    return null;
  }

  const factor = unitFactor(matched[2]);
  return Math.round(amount * factor);
}

function parseMemoryUsedPct(usedValue, totalValue) {
  const usedBytes = parseMemoryBytes(usedValue);
  const totalBytes = parseMemoryBytes(totalValue);

  if (!usedBytes || !totalBytes || totalBytes <= 0) {
    return null;
  }

  return Number(((usedBytes / totalBytes) * 100).toFixed(2));
}

function normalizeInteger(value) {
  const parsed = Number(String(value || "").trim());
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.trunc(parsed);
}

function computeRiskScore({
  baseRisk,
  relayOk,
  diskPct,
  sshFails,
  queueFailed,
  queueRetrying,
  quotaUsed,
  quotaLimit,
}) {
  let score = 0;

  const normalizedBaseRisk = String(baseRisk || "").toUpperCase();
  if (normalizedBaseRisk === "HIGH") {
    score += 70;
  } else if (normalizedBaseRisk === "WARNING") {
    score += 40;
  } else {
    score += 10;
  }

  if (!relayOk) {
    score += 20;
  }

  if (Number.isFinite(diskPct)) {
    if (diskPct >= 90) {
      score += 15;
    } else if (diskPct >= 80) {
      score += 8;
    }
  }

  if (Number.isFinite(sshFails)) {
    if (sshFails >= 1000) {
      score += 15;
    } else if (sshFails >= 300) {
      score += 8;
    }
  }

  if (queueFailed > 0) {
    score += 10;
  }

  if (queueRetrying > 10) {
    score += 5;
  }

  if (quotaLimit > 0) {
    const quotaPct = (quotaUsed / quotaLimit) * 100;
    if (quotaPct >= 95) {
      score += 8;
    } else if (quotaPct >= 80) {
      score += 4;
    }
  }

  return Math.min(100, score);
}

function riskLevelFromScore(score) {
  if (score >= 80) return "critical";
  if (score >= 50) return "high";
  if (score >= 25) return "warning";
  return "secure";
}

function readMetricsFile(metricsPath) {
  const resolvedPath = path.resolve(metricsPath);
  if (!fs.existsSync(resolvedPath)) {
    return {
      ok: false,
      reason: "metrics_not_found",
      path: resolvedPath,
      data: null,
      modifiedAt: null,
    };
  }

  try {
    const raw = fs.readFileSync(resolvedPath, "utf8");
    const parsed = JSON.parse(raw);
    const stat = fs.statSync(resolvedPath);

    return {
      ok: true,
      reason: null,
      path: resolvedPath,
      data: parsed,
      modifiedAt: stat.mtime.toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      reason: "metrics_parse_failed",
      path: resolvedPath,
      data: null,
      modifiedAt: null,
    };
  }
}

module.exports = {
  computeRiskScore,
  normalizeInteger,
  parseLoad1m,
  parseMemoryUsedPct,
  parsePercent,
  readMetricsFile,
  riskLevelFromScore,
};
