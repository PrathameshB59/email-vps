const crypto = require("crypto");
const { execFileSync, spawn } = require("child_process");

class OpsCommandError extends Error {
  constructor({ code, message, statusCode = 400, retryAfterSeconds = null, runId = null } = {}) {
    super(message || "Command request failed.");
    this.name = "OpsCommandError";
    this.code = code || "OPS_COMMAND_ERROR";
    this.statusCode = statusCode;
    this.retryAfterSeconds = retryAfterSeconds;
    this.runId = runId;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function isAllowedUnitName(value) {
  return /^[a-zA-Z0-9@._-]+$/.test(String(value || ""));
}

function sanitizeControl(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function sanitizeCommandKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function commandCompositeKey(control, commandKey) {
  return `${sanitizeControl(control)}:${sanitizeCommandKey(commandKey)}`;
}

function splitChunkLines(buffered, chunk) {
  const combined = `${buffered}${String(chunk || "")}`;
  const normalized = combined.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n");
  const pending = parts.pop() || "";
  return {
    lines: parts,
    pending,
  };
}

function coercePositiveInt(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return Math.trunc(numeric);
}

function parseIsoTime(isoValue) {
  const parsed = new Date(isoValue).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function runSudoRead(args, timeoutMs = 8000) {
  try {
    const stdout = execFileSync("sudo", args, {
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

function mapDaemonErrorCode(code) {
  const normalized = String(code || "").trim();
  if (!normalized) {
    return "COMMAND_EXECUTION_FAILED";
  }
  if (normalized.startsWith("OPS_DAEMON_")) {
    return normalized;
  }
  return `OPS_DAEMON_${normalized}`;
}

function createOpsCommandService({ env, repository, opsDaemonClient = null, logger = console } = {}) {
  const runnerEnabled = Boolean(env.DASHBOARD_OPS_COMMAND_RUNNER_ENABLED);
  const daemonEnabled =
    Boolean(env.DASHBOARD_OPS_DAEMON_ENABLED) &&
    Boolean(opsDaemonClient && typeof opsDaemonClient.executeAction === "function");
  const timeoutSeconds = coercePositiveInt(env.DASHBOARD_OPS_COMMAND_TIMEOUT_SECONDS, 180);
  const timeoutMs = timeoutSeconds * 1000;
  const cooldownSeconds = coercePositiveInt(env.DASHBOARD_OPS_COMMAND_COOLDOWN_SECONDS, 90);
  const maxOutputLines = coercePositiveInt(env.DASHBOARD_OPS_COMMAND_MAX_OUTPUT_LINES, 500);

  const aideCheckUnit = String(env.DASHBOARD_AIDE_CHECK_UNIT || "email-vps-aide-check.service").trim();
  const aideBaselineUnit = String(
    env.DASHBOARD_AIDE_BASELINE_LIST_UNIT || "email-vps-aide-baseline-list.service"
  ).trim();
  const aideInitUnit = String(env.DASHBOARD_AIDE_INIT_UNIT || "email-vps-aide-init.service").trim();
  const fail2banStatusUnit = String(
    env.DASHBOARD_FAIL2BAN_STATUS_UNIT || "email-vps-fail2ban-status.service"
  ).trim();
  const postfixCheckUnit = String(
    env.DASHBOARD_POSTFIX_CHECK_UNIT || "email-vps-postfix-check.service"
  ).trim();
  const relayProbeUnit = String(env.DASHBOARD_RELAY_PROBE_UNIT || "email-vps-relay-probe.service").trim();
  const crontabCheckUnit = String(
    env.DASHBOARD_CRONTAB_CHECK_UNIT || "email-vps-crontab-check.service"
  ).trim();
  const rcloneSyncUnit = String(env.DASHBOARD_RCLONE_SYNC_UNIT || "email-vps-rclone-sync.service").trim();

  const commandCatalog = {
    aide: [
      {
        control: "aide",
        commandKey: "aide_check",
        daemonAction: "aide_check",
        label: "Run AIDE Integrity Check",
        description: "Runs configured AIDE check unit and streams verifier output.",
        unit: aideCheckUnit,
        preview: `sudo systemctl start --wait ${aideCheckUnit}`,
        suggestion: "Use this first to verify integrity drift before remediation.",
      },
      {
        control: "aide",
        commandKey: "aide_baseline_list",
        daemonAction: "aide_baseline_list",
        label: "List AIDE Baseline Files",
        description: "Runs baseline listing unit to verify DB presence and ownership.",
        unit: aideBaselineUnit,
        preview: `sudo systemctl start --wait ${aideBaselineUnit}`,
        suggestion: "Use this to confirm baseline path and permissions.",
      },
      {
        control: "aide",
        commandKey: "aide_init",
        daemonAction: "aide_init",
        label: "Initialize AIDE Baseline",
        description: "Runs AIDE initialization unit to rebuild baseline database.",
        unit: aideInitUnit,
        preview: `sudo systemctl start --wait ${aideInitUnit}`,
        suggestion: "Run only when baseline is missing or intentionally reset.",
      },
    ],
    fail2ban: [
      {
        control: "fail2ban",
        commandKey: "fail2ban_status",
        daemonAction: "fail2ban_status",
        label: "Run Fail2Ban Status Check",
        description: "Runs Fail2Ban diagnostics unit and streams jail status output.",
        unit: fail2banStatusUnit,
        preview: `sudo systemctl start --wait ${fail2banStatusUnit}`,
        suggestion: "Use this to verify jail enforcement and daemon readiness.",
      },
    ],
    postfix: [
      {
        control: "postfix",
        commandKey: "postfix_check",
        daemonAction: "postfix_check",
        label: "Run Postfix Runtime Check",
        description: "Runs Postfix diagnostics unit for config/runtime verification.",
        unit: postfixCheckUnit,
        preview: `sudo systemctl start --wait ${postfixCheckUnit}`,
        suggestion: "Use this to validate queue/runtime health after config changes.",
      },
    ],
    relay: [
      {
        control: "relay",
        commandKey: "relay_probe",
        daemonAction: "relay_probe",
        label: "Run Relay Probe",
        description: "Runs relay probe unit to validate SMTP relay path.",
        unit: relayProbeUnit,
        preview: `sudo systemctl start --wait ${relayProbeUnit}`,
        suggestion: "Use this to confirm provider relay reachability.",
      },
    ],
    crontab: [
      {
        control: "crontab",
        commandKey: "crontab_check",
        daemonAction: "crontab_check",
        label: "Run Cron/Logwatch Check",
        description: "Runs cron diagnostics unit and surfaces stale-path/scheduler issues.",
        unit: crontabCheckUnit,
        preview: `sudo systemctl start --wait ${crontabCheckUnit}`,
        suggestion: "Use this to confirm cron scheduler and metrics script wiring.",
      },
    ],
    rclone: [
      {
        control: "rclone",
        commandKey: "rclone_sync",
        daemonAction: "rclone_sync",
        label: "Run Rclone Sync Unit",
        description: "Runs rclone sync unit for controlled backup synchronization.",
        unit: rcloneSyncUnit,
        preview: `sudo systemctl start --wait ${rcloneSyncUnit}`,
        suggestion: "Use only when sync health is degraded and confirmation is required.",
      },
    ],
  };

  for (const definitions of Object.values(commandCatalog)) {
    for (const definition of definitions) {
      if (!isAllowedUnitName(definition.unit)) {
        throw new Error(`Invalid systemd unit configured for ${definition.commandKey}.`);
      }
    }
  }

  const inFlightByCommand = new Map();
  const runStateByRunId = new Map();
  const listenersByRunId = new Map();

  function emitStreamEvent(runId, event) {
    const listeners = listenersByRunId.get(String(runId || ""));
    if (!listeners || listeners.size === 0) {
      return;
    }

    const payload = {
      ...event,
      runId: String(runId || ""),
      at: nowIso(),
    };

    for (const listener of listeners) {
      try {
        listener(payload);
      } catch (error) {
        logger.warn?.("[opsCommandService] stream listener failed", {
          runId,
          error: error?.message || error,
        });
      }
    }
  }

  function getControlDefinitions(control) {
    return commandCatalog[sanitizeControl(control)] || [];
  }

  function getCommandDefinition(control, commandKey) {
    const definitions = getControlDefinitions(control);
    return definitions.find((item) => item.commandKey === sanitizeCommandKey(commandKey)) || null;
  }

  async function getCooldownState({ control, commandKey }) {
    const latest = await repository.getLatestOpsCommandRun({ control, commandKey });
    if (!latest) {
      return { latestRun: null, retryAfterSeconds: 0 };
    }

    const referenceIso = latest.finishedAt || latest.updatedAt || latest.createdAt;
    const referenceTs = parseIsoTime(referenceIso);
    if (!referenceTs) {
      return { latestRun: latest, retryAfterSeconds: 0 };
    }

    const waitMs = referenceTs + cooldownSeconds * 1000 - Date.now();
    return {
      latestRun: latest,
      retryAfterSeconds: waitMs > 0 ? Math.ceil(waitMs / 1000) : 0,
    };
  }

  async function getCommands({ control }) {
    const controlKey = sanitizeControl(control);
    const definitions = getControlDefinitions(controlKey);

    if (!definitions.length) {
      throw new OpsCommandError({
        code: "INVALID_CONTROL",
        statusCode: 400,
        message: `Unsupported command control: ${String(control || "")}`,
      });
    }

    const commands = [];
    for (const definition of definitions) {
      const composite = commandCompositeKey(controlKey, definition.commandKey);
      const cooldown = await getCooldownState({
        control: controlKey,
        commandKey: definition.commandKey,
      });
      commands.push({
        control: controlKey,
        commandKey: definition.commandKey,
        label: definition.label,
        description: definition.description,
        preview: definition.preview,
        suggestion: definition.suggestion,
        requiresConfirm: true,
        inFlight: inFlightByCommand.has(composite),
        retryAfterSeconds: cooldown.retryAfterSeconds,
        latestRun: cooldown.latestRun,
      });
    }

    return {
      ok: true,
      enabled: runnerEnabled,
      mode: daemonEnabled ? "daemon" : "sudo-systemctl",
      generatedAt: nowIso(),
      control: controlKey,
      timeoutSeconds,
      cooldownSeconds,
      maxOutputLines,
      commands,
    };
  }

  function getRunState(runId) {
    const key = String(runId || "");
    if (!runStateByRunId.has(key)) {
      runStateByRunId.set(key, {
        seq: 0,
        outputLines: 0,
        truncated: false,
        writeQueue: Promise.resolve(),
      });
    }
    return runStateByRunId.get(key);
  }

  function queueOutput(runId, stream, line) {
    const state = getRunState(runId);
    const safeStream = stream === "stderr" ? "stderr" : "stdout";
    const text = String(line || "");

    state.writeQueue = state.writeQueue.then(async () => {
      if (!text) {
        return;
      }

      if (state.outputLines >= maxOutputLines) {
        if (!state.truncated) {
          state.truncated = true;
          state.seq += 1;
          await repository.appendOpsCommandOutput({
            runId,
            stream: "stderr",
            line: `[output truncated after ${maxOutputLines} lines]`,
            seq: state.seq,
          });
          emitStreamEvent(runId, {
            type: "line",
            stream: "stderr",
            seq: state.seq,
            line: `[output truncated after ${maxOutputLines} lines]`,
          });
        }
        return;
      }

      state.seq += 1;
      state.outputLines += 1;
      const sanitized = text.slice(0, 4000);

      await repository.appendOpsCommandOutput({
        runId,
        stream: safeStream,
        line: sanitized,
        seq: state.seq,
      });
      emitStreamEvent(runId, {
        type: "line",
        stream: safeStream,
        seq: state.seq,
        line: sanitized,
      });
    });

    return state.writeQueue;
  }

  async function appendTextBlock(runId, stream, text) {
    const lines = String(text || "")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);

    for (const line of lines) {
      await queueOutput(runId, stream, line);
    }
  }

  async function executeRun({ runId, controlKey, definition, requestedByIp, requestedByUser }) {
    const composite = commandCompositeKey(controlKey, definition.commandKey);
    const startedAt = nowIso();
    const startedTs = Date.now();

    await repository.updateOpsCommandRun(runId, {
      status: "running",
      startedAt,
      errorCode: null,
      errorMessage: null,
    });

    emitStreamEvent(runId, {
      type: "status",
      status: "running",
      message: `Starting ${definition.label}...`,
    });

    let timedOut = false;
    let exitCode = null;
    let errorCode = null;
    let errorMessage = null;
    if (daemonEnabled) {
      try {
        const daemonResult = await opsDaemonClient.executeAction({
          action: definition.daemonAction || definition.commandKey,
          runId,
          requestedByUser,
          requestedByIp,
          timeoutSeconds,
          onEvent: (event) => {
            if (event?.type === "line") {
              void queueOutput(runId, event.stream === "stderr" ? "stderr" : "stdout", event.line);
              return;
            }
            if (event?.type === "status") {
              emitStreamEvent(runId, {
                type: "status",
                status: String(event.status || "running"),
                message: String(event.message || ""),
              });
            }
          },
        });

        exitCode =
          Number.isFinite(Number(daemonResult?.exitCode)) && Number(daemonResult.exitCode) >= 0
            ? Number(daemonResult.exitCode)
            : null;
        if (!daemonResult?.ok) {
          errorCode = mapDaemonErrorCode(daemonResult?.errorCode || "COMMAND_FAILED");
          errorMessage = daemonResult?.errorMessage || "Daemon-backed command failed.";
        }
      } catch (error) {
        errorCode = mapDaemonErrorCode(error?.code || "COMMAND_EXECUTION_FAILED");
        errorMessage = error?.message || "Daemon-backed command execution failed.";
      }
    } else {
      let stdoutPending = "";
      let stderrPending = "";

      const child = spawn("sudo", ["systemctl", "start", "--wait", definition.unit], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        errorCode = "COMMAND_TIMEOUT";
        errorMessage = `Command timed out after ${timeoutSeconds}s.`;
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
          void queueOutput(runId, "stdout", line);
        }
      });

      child.stderr.on("data", (chunk) => {
        const { lines, pending } = splitChunkLines(stderrPending, chunk);
        stderrPending = pending;
        for (const line of lines) {
          void queueOutput(runId, "stderr", line);
        }
      });

      const closeResult = await new Promise((resolve) => {
        child.once("error", (error) => {
          resolve({ code: null, signal: null, launchError: error });
        });
        child.once("close", (code, signal) => {
          resolve({ code, signal, launchError: null });
        });
      });

      clearTimeout(timeoutHandle);

      if (stdoutPending) {
        await queueOutput(runId, "stdout", stdoutPending);
      }
      if (stderrPending) {
        await queueOutput(runId, "stderr", stderrPending);
      }

      if (closeResult.launchError) {
        errorCode = errorCode || "COMMAND_LAUNCH_FAILED";
        errorMessage =
          errorMessage || closeResult.launchError.message || "Failed to launch command runner.";
      }

      if (!timedOut && closeResult.code != null) {
        exitCode = Number(closeResult.code);
        if (exitCode !== 0) {
          errorCode = errorCode || "COMMAND_FAILED";
          errorMessage = errorMessage || `systemctl start exited with code ${exitCode}.`;
        }
      }

      if (!timedOut && closeResult.signal) {
        errorCode = errorCode || "COMMAND_SIGNALLED";
        errorMessage = errorMessage || `Command terminated by signal ${closeResult.signal}.`;
      }

      const statusProbe = runSudoRead([
        "systemctl",
        "status",
        definition.unit,
        "--no-pager",
        "--lines",
        "30",
      ]);
      if (statusProbe.ok) {
        await appendTextBlock(runId, "stdout", `----- systemctl status ${definition.unit} -----`);
        await appendTextBlock(runId, "stdout", statusProbe.stdout);
      } else {
        await appendTextBlock(runId, "stderr", `----- systemctl status ${definition.unit} failed -----`);
        await appendTextBlock(runId, "stderr", statusProbe.stderr || statusProbe.message || "status unavailable");
      }

      const journalProbe = runSudoRead(["journalctl", "-u", definition.unit, "-n", "60", "--no-pager"]);
      if (journalProbe.ok) {
        await appendTextBlock(runId, "stdout", `----- journalctl -u ${definition.unit} -----`);
        await appendTextBlock(runId, "stdout", journalProbe.stdout);
      } else {
        await appendTextBlock(
          runId,
          "stderr",
          `----- journalctl -u ${definition.unit} unavailable: ${journalProbe.stderr || journalProbe.message || "error"} -----`
        );
      }
    }

    const completedAt = nowIso();
    const durationMs = Date.now() - startedTs;
    const finalStatus = errorCode ? "failed" : "success";

    await getRunState(runId).writeQueue;

    await repository.updateOpsCommandRun(runId, {
      status: finalStatus,
      finishedAt: completedAt,
      durationMs,
      exitCode,
      errorCode,
      errorMessage,
    });

    emitStreamEvent(runId, {
      type: "done",
      status: finalStatus,
      exitCode,
      errorCode,
      errorMessage,
      finishedAt: completedAt,
      durationMs,
      requestedByIp: requestedByIp || null,
      requestedByUser: requestedByUser || null,
    });

    inFlightByCommand.delete(composite);
  }

  async function runCommand({ control, commandKey, requestedByIp = null, requestedByUser = null, confirm = false } = {}) {
    if (!runnerEnabled) {
      throw new OpsCommandError({
        code: "COMMAND_RUNNER_DISABLED",
        statusCode: 403,
        message: "Ops command runner is disabled by runtime configuration.",
      });
    }

    const controlKey = sanitizeControl(control);
    const definition = getCommandDefinition(controlKey, commandKey);
    if (!definition) {
      throw new OpsCommandError({
        code: "INVALID_COMMAND",
        statusCode: 400,
        message: `Unsupported command key ${String(commandKey || "")}`,
      });
    }

    if (!confirm) {
      throw new OpsCommandError({
        code: "CONFIRMATION_REQUIRED",
        statusCode: 400,
        message: "Explicit confirmation is required before executing sudo command actions.",
      });
    }

    const composite = commandCompositeKey(controlKey, definition.commandKey);
    if (inFlightByCommand.has(composite)) {
      const activeRunId = inFlightByCommand.get(composite);
      throw new OpsCommandError({
        code: "COMMAND_ALREADY_RUNNING",
        statusCode: 409,
        message: "A command run for this action is already in progress.",
        runId: activeRunId,
      });
    }

    const cooldownState = await getCooldownState({
      control: controlKey,
      commandKey: definition.commandKey,
    });
    if (cooldownState.retryAfterSeconds > 0) {
      throw new OpsCommandError({
        code: "COMMAND_COOLDOWN_ACTIVE",
        statusCode: 429,
        message: `Cooldown active. Retry in ${cooldownState.retryAfterSeconds}s.`,
        retryAfterSeconds: cooldownState.retryAfterSeconds,
      });
    }

    const runId = crypto.randomUUID();
    const created = await repository.createOpsCommandRun({
      runId,
      control: controlKey,
      commandKey: definition.commandKey,
      commandLabel: definition.label,
      commandPreview: definition.preview,
      requestedByUser,
      requestedByIp,
      status: "queued",
    });

    inFlightByCommand.set(composite, runId);
    emitStreamEvent(runId, {
      type: "status",
      status: "queued",
      message: `${definition.label} queued...`,
    });

    setImmediate(() => {
      executeRun({
        runId,
        controlKey,
        definition,
        requestedByIp,
        requestedByUser,
      }).catch(async (error) => {
        const finishedAt = nowIso();
        const message = error?.message || "Unexpected command execution failure.";
        await queueOutput(runId, "stderr", message);
        await getRunState(runId).writeQueue;
        await repository.updateOpsCommandRun(runId, {
          status: "failed",
          finishedAt,
          errorCode: "COMMAND_EXECUTION_FAILED",
          errorMessage: message,
        });
        inFlightByCommand.delete(composite);
        emitStreamEvent(runId, {
          type: "done",
          status: "failed",
          errorCode: "COMMAND_EXECUTION_FAILED",
          errorMessage: message,
          finishedAt,
        });
      });
    });

    return {
      ok: true,
      accepted: true,
      runId,
      status: "queued",
      command: {
        control: controlKey,
        commandKey: definition.commandKey,
        label: definition.label,
        description: definition.description,
        preview: definition.preview,
      },
      queuedAt: created?.createdAt || nowIso(),
    };
  }

  async function getRun(runId, { outputLimit = 400 } = {}) {
    const run = await repository.getOpsCommandRunByRunId(runId);
    if (!run) {
      throw new OpsCommandError({
        code: "RUN_NOT_FOUND",
        statusCode: 404,
        message: `No command run found for id ${String(runId || "")}.`,
      });
    }

    const output = await repository.listOpsCommandOutput(runId, {
      limit: outputLimit,
    });

    return {
      ok: true,
      run,
      output,
    };
  }

  function subscribeRun(runId, listener) {
    const key = String(runId || "");
    if (!listenersByRunId.has(key)) {
      listenersByRunId.set(key, new Set());
    }

    const set = listenersByRunId.get(key);
    set.add(listener);

    return () => {
      set.delete(listener);
      if (set.size === 0) {
        listenersByRunId.delete(key);
      }
    };
  }

  return {
    getCommands,
    runCommand,
    getRun,
    subscribeRun,
    status() {
      return {
        enabled: runnerEnabled,
        mode: daemonEnabled ? "daemon" : "sudo-systemctl",
        cooldownSeconds,
        timeoutSeconds,
        maxOutputLines,
        daemon: daemonEnabled && typeof opsDaemonClient.status === "function" ? opsDaemonClient.status() : null,
        inFlight: Array.from(inFlightByCommand.entries()).map(([key, runId]) => ({
          key,
          runId,
        })),
      };
    },
  };
}

module.exports = {
  createOpsCommandService,
  OpsCommandError,
};
