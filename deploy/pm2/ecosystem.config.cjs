module.exports = {
  apps: [
    {
      name: "email-vps",
      script: "src/server.js",
      cwd: "/home/devuser/dev/email-vps",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "8081",
        DASHBOARD_TRUST_PROXY: "true",
      },
    },
    {
      name: "email-vps-ops-daemon",
      script: "src/cli/ops-daemon.js",
      cwd: "/home/devuser/dev/email-vps",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
