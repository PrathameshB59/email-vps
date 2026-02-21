const fs = require("fs");
const net = require("net");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const {
  coercePositiveInt,
  createNonceReplayCache,
  verifyOpsDaemonEnvelope,
} = require("./opsDaemonProtocol");

function isAllowedUnitName(value) {
  return /^[a-zA-Z0-9@._-]+$/.test(String(value || ""));
}

function splitChunkLines(buffered, chunk) {
  const combined = `${buffered}${String(chunk || "")}`;
  const normalized = combined.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n");
  return {
    lines: parts.slice(0, -1),
    pending: parts[parts.length - 1] || "",
  };
}

function runReadCommand(command, args, timeoutMs = 8000) {
  try {
    const stdout = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    return {
      ok: true,
      stdout: String(stdout || "").trim(),
      stderr: "",
      message: null,
    };
  } catch (error) {
    const stdout =
      typeof error.stdout === "string"
        ? error.stdout
        : Buffer.isBuffer(error.stdout)
          ? error.stdout.toString("utf8")
          : "";
    const stderr =
      typeof error.stderr === "string"
        ? error.stderr
        : Buffer.isBuffer(error.stderr)
          ? error.stderr.toString("utf8")
          : "";
    return {
      ok: false,
      stdout: String(stdout || "").trim(),
      stderr: String(stderr || "").trim(),
      message: error.message || "Command failed.",
    };
  }
}

function createOpsDaemonServer({ env, logger = console } = {}) {
  const socketPath = String(env.DASHBOARD_OPS_DAEMON_SOCKET_PATH || "/run/email-vps-opsd.sock").trim();
  const hmacSecret = String(env.DASHBOARD_OPS_DAEMON_HMAC_SECRET || "");
  const maxSkewSeconds = coercePositiveInt(env.DASHBOARD_OPS_DAEMON_REQUEST_TTL_SECONDS, 30);
  const ioTimeoutMs = coercePositiveInt(env.DASHBOARD_OPS_DAEMON_IO_TIMEOUT_MS, 240000);

  const replayCache = createNonceReplayCache({
    ttlSeconds: Math.max(maxSkewSeconds * 2, 60),
  });

  const actionMap = {
    aide_check: {
      unit: String(env.DASHBOARD_AIDE_CHECK_UNIT || "email-vps-aide-check.service").trim(),
      label: "AIDE check",
    },
    aide_baseline_list: {
      unit: String(env.DASHBOARD_AIDE_BASELINE_LIST_UNIT || "email-vps-aide-baseline-list.service").trim(),
      label: "AIDE baseline list",
    },
    aide_init: {
      unit: String(env.DASHBOARD_AIDE_INIT_UNIT || "email-vps-aide-init.service").trim(),
      label: "AIDE initialize",
    },
    fail2ban_status: {
      unit: String(env.DASHBOARD_FAIL2BAN_STATUS_UNIT || "email-vps-fail2ban-status.service").trim(),
      label: "Fail2Ban status",
    },
    postfix_check: {
      unit: String(env.DASHBOARD_POSTFIX_CHECK_UNIT || "email-vps-postfix-check.service").trim(),
      label: "Postfix check",
    },
    relay_probe: {
      unit: String(env.DASHBOARD_RELAY_PROBE_UNIT || "email-vps-relay-probe.service").trim(),
      label: "Relay probe",
    },
    crontab_check: {
      unit: String(env.DASHBOARD_CRONTAB_CHECK_UNIT || "email-vps-crontab-check.service").trim(),
      label: "Crontab check",
    },
    rclone_sync: {
      unit: String(env.DASHBOARD_RCLONE_SYNC_UNIT || "email-vps-rclone-sync.service").trim(),
      label: "Rclone sync",
    },
  };

  for (const [action, definition] of Object.entries(actionMap)) {
    if (!isAllowedUnitName(definition.unit)) {
      throw new Error(`Invalid systemd unit configured for ops daemon action ${action}.`);
    }
  }

  let server = null;
  let listening = false;

  function sendMessage(socket, message) {
    socket.write(`${JSON.stringify(message)}\n`);
  }

  function sendLine(socket, stream, line) {
    sendMessage(socket, {
      type: "line",
      stream: stream === "stderr" ? "stderr" : "stdout",
      line: String(line || ""),
    });
  }

  async function appendTextBlock(socket, stream, text) {
    const lines = String(text || "")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);

    for (const line of lines) {
      sendLine(socket, stream, line);
    }
  }

  async function runSystemdAction({ socket, action, timeoutSeconds }) {
    const definition = actionMap[action];
    if (!definition) {
      const error = new Error(`Unsupported daemon action: ${String(action || "")}`);
      error.code = "OPS_DAEMON_ACTION_UNSUPPORTED";
      throw error;
    }

    const startedMs = Date.now();
    const timeoutMs = Math.max(coercePositiveInt(timeoutSeconds, 180), 1) * 1000;
    let timedOut = false;

    sendMessage(socket, {
      type: "status",
      status: "running",
      message: `Running ${definition.label} (${definition.unit})...`,
    });

    let stdoutPending = "";
    let stderrPending = "";
    let exitCode = null;
    let errorCode = null;
    let errorMessage = null;

    const child = spawn("systemctl", ["start", "--wait", definition.unit], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      errorCode = "OPS_DAEMON_TIMEOUT";
      errorMessage = `Daemon action timed out after ${Math.ceil(timeoutMs / 1000)}s.`;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 1200).unref?.();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const { lines, pending } = splitChunkLines(stdoutPending, chunk);
      stdoutPending = pending;
      for (const line of lines) {
        sendLine(socket, "stdout", line);
      }
    });

    child.stderr.on("data", (chunk) => {
      const { lines, pending } = splitChunkLines(stderrPending, chunk);
      stderrPending = pending;
      for (const line of lines) {
        sendLine(socket, "stderr", line);
      }
    });

    const closeResult = await new Promise((resolve) => {
      child.once("error", (error) => resolve({ launchError: error, code: null, signal: null }));
      child.once("close", (code, signal) => resolve({ launchError: null, code, signal }));
    });

    clearTimeout(timeoutHandle);

    if (stdoutPending) {
      sendLine(socket, "stdout", stdoutPending);
    }
    if (stderrPending) {
      sendLine(socket, "stderr", stderrPending);
    }

    if (closeResult.launchError) {
      errorCode = errorCode || "OPS_DAEMON_LAUNCH_FAILED";
      errorMessage = errorMessage || closeResult.launchError.message || "Failed to start systemd command.";
    }

    if (!timedOut && closeResult.code != null) {
      exitCode = Number(closeResult.code);
      if (exitCode !== 0) {
        errorCode = errorCode || "OPS_DAEMON_COMMAND_FAILED";
        errorMessage = errorMessage || `systemctl start exited with code ${exitCode}.`;
      }
    }

    if (!timedOut && closeResult.signal) {
      errorCode = errorCode || "OPS_DAEMON_SIGNALLED";
      errorMessage = errorMessage || `systemctl start terminated by signal ${closeResult.signal}.`;
    }

    const statusProbe = runReadCommand("systemctl", ["status", definition.unit, "--no-pager", "--lines", "30"]);
    if (statusProbe.ok) {
      await appendTextBlock(socket, "stdout", `----- systemctl status ${definition.unit} -----`);
      await appendTextBlock(socket, "stdout", statusProbe.stdout);
    } else {
      await appendTextBlock(socket, "stderr", `----- systemctl status ${definition.unit} failed -----`);
      await appendTextBlock(socket, "stderr", statusProbe.stderr || statusProbe.message || "status unavailable");
    }

    const journalProbe = runReadCommand("journalctl", ["-u", definition.unit, "-n", "60", "--no-pager"]);
    if (journalProbe.ok) {
      await appendTextBlock(socket, "stdout", `----- journalctl -u ${definition.unit} -----`);
      await appendTextBlock(socket, "stdout", journalProbe.stdout);
    } else {
      await appendTextBlock(socket, "stderr", `----- journalctl -u ${definition.unit} unavailable -----`);
      await appendTextBlock(socket, "stderr", journalProbe.stderr || journalProbe.message || "journal unavailable");
    }

    return {
      ok: !errorCode,
      exitCode,
      errorCode,
      errorMessage,
      durationMs: Date.now() - startedMs,
    };
  }

  async function handleEnvelope(socket, envelope) {
    if (!hmacSecret || hmacSecret.length < 16) {
      sendMessage(socket, {
        type: "error",
        code: "OPS_DAEMON_SECRET_MISSING",
        message: "Ops daemon HMAC secret is missing or too short.",
      });
      socket.end();
      return;
    }

    let payload;
    try {
      payload = verifyOpsDaemonEnvelope(envelope, {
        secret: hmacSecret,
        replayCache,
        maxSkewSeconds,
      });
    } catch (error) {
      sendMessage(socket, {
        type: "error",
        code: error.code || "OPS_DAEMON_PROTOCOL_ERROR",
        message: error.message || "Invalid daemon request.",
      });
      socket.end();
      return;
    }

    const action = String(payload.action || "").trim();
    if (!actionMap[action]) {
      sendMessage(socket, {
        type: "error",
        code: "OPS_DAEMON_ACTION_UNSUPPORTED",
        message: `Unsupported daemon action: ${action}`,
      });
      socket.end();
      return;
    }

    sendMessage(socket, {
      type: "ack",
      status: "accepted",
      message: `Accepted action ${action}.`,
    });

    try {
      const result = await runSystemdAction({
        socket,
        action,
        timeoutSeconds: payload.timeoutSeconds,
      });

      sendMessage(socket, {
        type: "done",
        ok: result.ok,
        exitCode: result.exitCode,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        durationMs: result.durationMs,
      });
    } catch (error) {
      sendMessage(socket, {
        type: "done",
        ok: false,
        exitCode: null,
        errorCode: error.code || "OPS_DAEMON_EXECUTION_ERROR",
        errorMessage: error.message || "Ops daemon action failed.",
        durationMs: null,
      });
    } finally {
      socket.end();
    }
  }

  function createServer() {
    return net.createServer((socket) => {
      socket.setTimeout(ioTimeoutMs);
      let buffer = "";
      let requestHandled = false;

      socket.on("data", (chunk) => {
        if (requestHandled) {
          return;
        }
        const split = splitChunkLines(buffer, chunk);
        buffer = split.pending;
        for (const line of split.lines) {
          if (!line.trim()) {
            continue;
          }
          requestHandled = true;
          let envelope;
          try {
            envelope = JSON.parse(line);
          } catch (error) {
            sendMessage(socket, {
              type: "error",
              code: "OPS_DAEMON_JSON_INVALID",
              message: "Invalid JSON command envelope.",
            });
            socket.end();
            return;
          }
          void handleEnvelope(socket, envelope);
          return;
        }
      });

      socket.on("timeout", () => {
        sendMessage(socket, {
          type: "error",
          code: "OPS_DAEMON_CONNECTION_TIMEOUT",
          message: "Connection timed out before command completion.",
        });
        socket.end();
      });
    });
  }

  async function start() {
    if (listening) {
      return;
    }

    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }

    server = createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });

    try {
      fs.chmodSync(socketPath, 0o660);
    } catch (error) {
      logger.warn?.("[opsDaemonServer] failed to chmod socket", {
        socketPath,
        message: error.message || error,
      });
    }

    listening = true;
    logger.info?.("[opsDaemonServer] listening", {
      socketPath,
      maxSkewSeconds,
    });
  }

  async function stop() {
    if (!server || !listening) {
      return;
    }

    await new Promise((resolve) => {
      server.close(() => resolve());
    });
    server = null;
    listening = false;

    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  }

  return {
    start,
    stop,
    status() {
      return {
        listening,
        socketPath,
        maxSkewSeconds,
        actions: Object.keys(actionMap),
      };
    },
  };
}

module.exports = {
  createOpsDaemonServer,
};

