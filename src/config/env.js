const path = require("path");
const dotenv = require("dotenv");
const { z } = require("zod");

const envFile = process.env.EMAIL_VPS_ENV_FILE || path.resolve(process.cwd(), ".env");
dotenv.config({ path: envFile });

const boolFromString = z.preprocess((value) => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return value;
  }
  const lowered = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(lowered)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(lowered)) {
    return false;
  }
  return value;
}, z.boolean());

const csvStringArray = z.preprocess((value) => {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return value;
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}, z.array(z.string().min(1)));

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(8081),

  MAIL_API_TOKEN: z.string().min(1, "MAIL_API_TOKEN is required"),
  MAIL_ALLOW_NON_LOCAL: boolFromString.default(false),

  MAIL_FROM: z.string().min(3, "MAIL_FROM is required"),
  MAIL_DAILY_LIMIT: z.coerce.number().int().positive().default(500),
  MAIL_RETRY_MAX: z.coerce.number().int().positive().default(3),
  MAIL_RETRY_BASE_MS: z.coerce.number().int().positive().default(30000),

  MAIL_RELAY_HOST: z.string().default("127.0.0.1"),
  MAIL_RELAY_PORT: z.coerce.number().int().positive().default(25),
  MAIL_RELAY_SECURE: boolFromString.default(false),

  DB_PATH: z.string().default(path.resolve(process.cwd(), "data", "email_vps.sqlite")),
  LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  QUEUE_POLL_MS: z.coerce.number().int().positive().default(5000),
  QUEUE_BATCH_SIZE: z.coerce.number().int().positive().default(20),

  DASHBOARD_LOGIN_USER: z.string().min(1, "DASHBOARD_LOGIN_USER is required"),
  DASHBOARD_LOGIN_PASS: z.string().min(1, "DASHBOARD_LOGIN_PASS is required"),
  DASHBOARD_SESSION_SECRET: z
    .string()
    .min(16, "DASHBOARD_SESSION_SECRET must be at least 16 characters"),
  DASHBOARD_SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  DASHBOARD_AUTH_FLOW: z.enum(["otp_then_credentials"]).default("otp_then_credentials"),
  DASHBOARD_IP_ALLOWLIST_ENABLED: boolFromString.default(false),
  DASHBOARD_ALLOWED_IPS: csvStringArray.default(["127.0.0.1", "::1"]),
  DASHBOARD_TRUST_PROXY: boolFromString.default(true),
  DASHBOARD_CSP_ENFORCE: boolFromString.default(false),
  DASHBOARD_HSTS_MAX_AGE: z.coerce.number().int().nonnegative().default(86400),
  DASHBOARD_LOCAL_FALLBACK_ENABLED: boolFromString.default(true),
  DASHBOARD_PREAUTH_TTL_MINUTES: z.coerce.number().int().positive().default(5),
  DASHBOARD_METRIC_SNAPSHOT_MINUTES: z.coerce.number().int().positive().default(5),
  DASHBOARD_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  DASHBOARD_METRICS_PATH: z
    .string()
    .default(path.resolve(process.cwd(), "metrics.json")),
  DASHBOARD_LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(5),
  DASHBOARD_LOGIN_RATE_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  DASHBOARD_LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),
  DASHBOARD_OPS_COLLECT_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
  DASHBOARD_OPS_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  DASHBOARD_OPS_LOG_TAIL_LINES: z.coerce.number().int().positive().default(400),
  DASHBOARD_POSTFIX_MAIN_CF_PATH: z.string().default("/etc/postfix/main.cf"),
  DASHBOARD_OTP_PRIMARY_ENABLED: boolFromString.default(true),
  DASHBOARD_OTP_TO: z.string().email("DASHBOARD_OTP_TO must be a valid email"),
  DASHBOARD_OTP_FROM: z.string().default(""),
  DASHBOARD_OTP_DIAGNOSTICS_ENABLED: boolFromString.default(true),
  DASHBOARD_OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  DASHBOARD_OTP_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  DASHBOARD_OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),
  DASHBOARD_OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  DASHBOARD_OTP_REQUEST_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  DASHBOARD_OTP_REQUEST_RATE_WINDOW_MS: z.coerce.number().int().positive().default(900000),
  DASHBOARD_OTP_DAILY_LIMIT: z.coerce.number().int().positive().default(50),
  DASHBOARD_ACTIVITY_TOP_N: z.coerce.number().int().positive().default(20),
  DASHBOARD_ACTIVITY_REFRESH_SECONDS: z.coerce.number().int().positive().default(5),
  DASHBOARD_MAIL_PROBE_TO: z.string().default(""),
  DASHBOARD_MAIL_PROBE_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(300),
});

function parseEnv(rawEnv) {
  const parsed = envSchema.safeParse(rawEnv);
  if (parsed.success) {
    const data = parsed.data;
    if (data.DASHBOARD_IP_ALLOWLIST_ENABLED && (!data.DASHBOARD_ALLOWED_IPS || data.DASHBOARD_ALLOWED_IPS.length === 0)) {
      throw new Error("Invalid environment configuration: DASHBOARD_ALLOWED_IPS: required when DASHBOARD_IP_ALLOWLIST_ENABLED=true");
    }

    return data;
  }

  const issueText = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
    .join("; ");

  throw new Error(`Invalid environment configuration: ${issueText}`);
}

function loadEnv(overrides = {}) {
  return parseEnv({ ...process.env, ...overrides });
}

module.exports = {
  loadEnv,
  parseEnv,
};
