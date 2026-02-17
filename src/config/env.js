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
}, z.array(z.string().min(1)).min(1, "DASHBOARD_ALLOWED_IPS is required"));

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
  DASHBOARD_ALLOWED_IPS: csvStringArray,
  DASHBOARD_TRUST_PROXY: boolFromString.default(true),
  DASHBOARD_METRIC_SNAPSHOT_MINUTES: z.coerce.number().int().positive().default(5),
  DASHBOARD_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  DASHBOARD_METRICS_PATH: z
    .string()
    .default(path.resolve(process.cwd(), "metrics.json")),
  DASHBOARD_LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(5),
  DASHBOARD_LOGIN_RATE_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  DASHBOARD_LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),
});

function parseEnv(rawEnv) {
  const parsed = envSchema.safeParse(rawEnv);
  if (parsed.success) {
    return parsed.data;
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
