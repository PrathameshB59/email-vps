const nodemailer = require("nodemailer");

function createMailTransport(env) {
  return nodemailer.createTransport({
    host: env.MAIL_RELAY_HOST,
    port: env.MAIL_RELAY_PORT,
    secure: env.MAIL_RELAY_SECURE,
    tls: {
      rejectUnauthorized: false,
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  });
}

async function verifyMailTransport(transport) {
  try {
    await transport.verify();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      code: error.code || "VERIFY_FAILED",
      message: error.message,
    };
  }
}

module.exports = {
  createMailTransport,
  verifyMailTransport,
};
