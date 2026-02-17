const { loadEnv } = require("../config/env");
const { createRepository } = require("../mail/repository");
const { createMailTransport, verifyMailTransport } = require("../mail/transporter");
const { createAdminAuthService } = require("./services/authService");
const { createAlertService } = require("./services/alertService");
const { createAdminService } = require("./services/adminService");
const { createAdminApp } = require("./app");

async function createAdminRuntime({ envOverrides = {}, transport = null } = {}) {
  const env = loadEnv(envOverrides);
  const repository = await createRepository({ dbPath: env.DB_PATH });
  const mailTransport = transport || createMailTransport(env);

  const verifyRelay = async () => verifyMailTransport(mailTransport);

  const authService = createAdminAuthService({ repository, env });
  await authService.ensureSeedAdminIfConfigured();

  const alertService = createAlertService({
    repository,
    env,
    verifyRelay,
  });

  const adminService = createAdminService({
    repository,
    env,
    alertService,
  });

  const app = createAdminApp({
    env,
    authService,
    adminService,
  });

  async function close() {
    if (mailTransport && typeof mailTransport.close === "function") {
      mailTransport.close();
    }
    await repository.close();
  }

  return {
    env,
    repository,
    authService,
    adminService,
    app,
    close,
  };
}

module.exports = {
  createAdminRuntime,
};
