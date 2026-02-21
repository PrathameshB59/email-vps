const net = require("net");
const {
  coercePositiveInt,
  createOpsDaemonEnvelope,
} = require("./opsDaemonProtocol");

function createOpsDaemonClient({ env, logger = console } = {}) {
  const socketPath = String(env.DASHBOARD_OPS_DAEMON_SOCKET_PATH || "/run/email-vps-opsd.sock").trim();
  const secret = String(env.DASHBOARD_OPS_DAEMON_HMAC_SECRET || "");
  const ttlSeconds = coercePositiveInt(env.DASHBOARD_OPS_DAEMON_REQUEST_TTL_SECONDS, 30);
  const connectTimeoutMs = coercePositiveInt(env.DASHBOARD_OPS_DAEMON_CONNECT_TIMEOUT_MS, 5000);
  const ioTimeoutMs = coercePositiveInt(env.DASHBOARD_OPS_DAEMON_IO_TIMEOUT_MS, 240000);

  async function executeAction({
    action,
    runId,
    requestedByUser = null,
    requestedByIp = null,
    timeoutSeconds = null,
    onEvent = null,
  } = {}) {
    if (!secret || secret.length < 16) {
      const error = new Error("Ops daemon HMAC secret is not configured.");
      error.code = "OPS_DAEMON_SECRET_MISSING";
      throw error;
    }

    const actionName = String(action || "").trim();
    if (!actionName) {
      const error = new Error("Daemon action is required.");
      error.code = "OPS_DAEMON_ACTION_REQUIRED";
      throw error;
    }

    const envelope = createOpsDaemonEnvelope({
      action: actionName,
      runId,
      requestedByUser,
      requestedByIp,
      timeoutSeconds,
      ttlSeconds,
      secret,
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      let connected = false;
      let buffer = "";
      let ioTimer = null;
      let connectTimer = null;

      const socket = net.createConnection({ path: socketPath });

      function cleanup() {
        if (ioTimer) {
          clearTimeout(ioTimer);
          ioTimer = null;
        }
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
      }

      function fail(error) {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        try {
          socket.destroy();
        } catch (socketError) {
          logger.warn?.("[opsDaemonClient] socket destroy failed", {
            message: socketError?.message || socketError,
          });
        }
        reject(error);
      }

      function succeed(result) {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        try {
          socket.end();
        } catch (socketError) {
          logger.warn?.("[opsDaemonClient] socket end failed", {
            message: socketError?.message || socketError,
          });
        }
        resolve(result);
      }

      function armIoTimer() {
        if (ioTimer) {
          clearTimeout(ioTimer);
        }
        ioTimer = setTimeout(() => {
          const error = new Error(`Ops daemon IO timeout after ${Math.ceil(ioTimeoutMs / 1000)}s.`);
          error.code = "OPS_DAEMON_IO_TIMEOUT";
          fail(error);
        }, ioTimeoutMs);
      }

      function handleMessage(message) {
        if (!message || typeof message !== "object") {
          return;
        }
        armIoTimer();

        if (message.type === "line") {
          if (typeof onEvent === "function") {
            onEvent({
              type: "line",
              stream: message.stream === "stderr" ? "stderr" : "stdout",
              line: String(message.line || ""),
            });
          }
          return;
        }

        if (message.type === "status" || message.type === "ack") {
          if (typeof onEvent === "function") {
            onEvent({
              type: "status",
              status: String(message.status || "running"),
              message: String(message.message || ""),
            });
          }
          return;
        }

        if (message.type === "done") {
          return succeed({
            ok: Boolean(message.ok),
            exitCode:
              Number.isFinite(Number(message.exitCode)) && Number(message.exitCode) >= 0
                ? Number(message.exitCode)
                : null,
            errorCode: message.errorCode ? String(message.errorCode) : null,
            errorMessage: message.errorMessage ? String(message.errorMessage) : null,
            durationMs:
              Number.isFinite(Number(message.durationMs)) && Number(message.durationMs) >= 0
                ? Number(message.durationMs)
                : null,
          });
        }

        if (message.type === "error") {
          const error = new Error(String(message.message || "Ops daemon rejected command."));
          error.code = String(message.code || "OPS_DAEMON_ERROR");
          return fail(error);
        }
      }

      connectTimer = setTimeout(() => {
        const error = new Error(`Unable to connect to ops daemon socket: ${socketPath}`);
        error.code = "OPS_DAEMON_CONNECT_TIMEOUT";
        fail(error);
      }, connectTimeoutMs);

      socket.on("connect", () => {
        connected = true;
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        armIoTimer();
        socket.write(`${JSON.stringify(envelope)}\n`);
      });

      socket.on("data", (chunk) => {
        buffer += String(chunk || "");
        let idx = buffer.indexOf("\n");
        while (idx >= 0) {
          const raw = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (raw) {
            try {
              handleMessage(JSON.parse(raw));
            } catch (error) {
              const parseError = new Error("Invalid response from ops daemon.");
              parseError.code = "OPS_DAEMON_PROTOCOL_ERROR";
              return fail(parseError);
            }
          }
          idx = buffer.indexOf("\n");
        }
      });

      socket.on("error", (error) => {
        if (!connected && connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        const wrapped = new Error(error?.message || "Ops daemon socket error.");
        wrapped.code = error?.code || "OPS_DAEMON_SOCKET_ERROR";
        fail(wrapped);
      });

      socket.on("close", () => {
        if (!settled) {
          const error = new Error("Ops daemon connection closed before completion.");
          error.code = "OPS_DAEMON_CLOSED";
          fail(error);
        }
      });
    });
  }

  return {
    executeAction,
    status() {
      return {
        socketPath,
        ttlSeconds,
        connectTimeoutMs,
        ioTimeoutMs,
      };
    },
  };
}

module.exports = {
  createOpsDaemonClient,
};
