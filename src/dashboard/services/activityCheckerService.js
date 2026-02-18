const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

function round(value, digits = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const power = 10 ** digits;
  return Math.round(numeric * power) / power;
}

function safeExec(command, args = [], timeoutMs = 2000) {
  try {
    const stdout = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    return {
      ok: true,
      stdout: String(stdout || ""),
      stderr: "",
      error: null,
    };
  } catch (error) {
    const stderr =
      typeof error.stderr === "string"
        ? error.stderr
        : Buffer.isBuffer(error.stderr)
          ? error.stderr.toString("utf8")
          : "";

    return {
      ok: false,
      stdout: "",
      stderr: String(stderr || "").trim(),
      error: String(error.message || "exec failed"),
    };
  }
}

function parsePercent(value) {
  const text = String(value || "").trim();
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)/);
  if (!match) {
    return null;
  }
  return Number(match[1]);
}

function readCpuPctFromMetrics(metricsPath) {
  try {
    if (!fs.existsSync(metricsPath)) {
      return null;
    }

    const raw = fs.readFileSync(metricsPath, "utf8");
    const parsed = JSON.parse(raw);
    return round(parsePercent(parsed.cpu), 1);
  } catch (error) {
    return null;
  }
}

function parseProcessLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) {
    return null;
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length < 8) {
    return null;
  }

  const pid = Number(parts[0]);
  const user = parts[1];
  const cpuPct = Number(parts[2]);
  const memPct = Number(parts[3]);
  const state = parts[4];
  const threads = Number(parts[5]);
  const elapsedSec = Number(parts[6]);
  const command = parts[7];
  const args = parts.slice(8).join(" ");

  if (!Number.isFinite(pid)) {
    return null;
  }

  return {
    pid,
    user: String(user || "unknown"),
    cpuPct: Number.isFinite(cpuPct) ? round(cpuPct, 1) : 0,
    memPct: Number.isFinite(memPct) ? round(memPct, 1) : 0,
    state: String(state || "?"),
    threads: Number.isFinite(threads) ? threads : 0,
    elapsedSec: Number.isFinite(elapsedSec) ? elapsedSec : 0,
    command: String(command || "unknown"),
    args: String(args || ""),
  };
}

function parseTaskStates(raw) {
  const counts = {
    total: 0,
    running: 0,
    sleeping: 0,
    stopped: 0,
    zombie: 0,
  };

  const lines = String(raw || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const state = line.charAt(0).toUpperCase();
    counts.total += 1;
    if (state === "R") counts.running += 1;
    else if (state === "S" || state === "D") counts.sleeping += 1;
    else if (state === "T" || state === "I") counts.stopped += 1;
    else if (state === "Z") counts.zombie += 1;
  }

  return counts;
}

function createActivityCheckerService({ env }) {
  const topN = Math.max(1, Number(env.DASHBOARD_ACTIVITY_TOP_N || 20));

  function collectTopProcesses(sortFlag) {
    const result = safeExec(
      "ps",
      [
        "-eo",
        "pid=,user=,pcpu=,pmem=,state=,nlwp=,etimes=,comm=,args=",
        `--sort=${sortFlag}`,
      ],
      2200
    );

    if (!result.ok) {
      return {
        ok: false,
        rows: [],
        error: result.stderr || result.error || "Unable to read process list.",
      };
    }

    const rows = String(result.stdout || "")
      .split("\n")
      .map(parseProcessLine)
      .filter(Boolean)
      .slice(0, topN);

    return {
      ok: true,
      rows,
      error: null,
    };
  }

  function collectTaskStates() {
    const result = safeExec("ps", ["-eo", "state="], 1600);
    if (!result.ok) {
      return {
        ok: false,
        tasks: {
          total: 0,
          running: 0,
          sleeping: 0,
          stopped: 0,
          zombie: 0,
        },
        error: result.stderr || result.error || "Unable to read task states.",
      };
    }

    return {
      ok: true,
      tasks: parseTaskStates(result.stdout),
      error: null,
    };
  }

  async function getActivitySnapshot() {
    const [topCpu, topMemory, taskStates] = await Promise.all([
      collectTopProcesses("-pcpu"),
      collectTopProcesses("-pmem"),
      collectTaskStates(),
    ]);

    const loadAverage = os.loadavg().map((value) => round(value, 2) || 0);
    const uptimeSec = Math.trunc(os.uptime());
    const memoryTotalBytes = os.totalmem();
    const memoryFreeBytes = os.freemem();
    const memoryUsedBytes = Math.max(memoryTotalBytes - memoryFreeBytes, 0);
    const memoryUsedPct =
      memoryTotalBytes > 0 ? round((memoryUsedBytes / memoryTotalBytes) * 100, 1) : 0;
    const cpuPct = readCpuPctFromMetrics(env.DASHBOARD_METRICS_PATH);

    const errors = [topCpu.error, topMemory.error, taskStates.error].filter(Boolean);
    const health = errors.length ? "degraded" : "healthy";

    return {
      timestamp: new Date().toISOString(),
      health,
      loadAverage,
      uptimeSec,
      cpuPct,
      memoryUsedPct,
      memoryTotalBytes,
      memoryUsedBytes,
      tasks: taskStates.tasks,
      topCpu: topCpu.rows,
      topMemory: topMemory.rows,
      limits: {
        topN,
        refreshSeconds: Number(env.DASHBOARD_ACTIVITY_REFRESH_SECONDS || 5),
      },
      diagnostics: {
        errors,
      },
    };
  }

  return {
    getActivitySnapshot,
  };
}

module.exports = {
  createActivityCheckerService,
};
