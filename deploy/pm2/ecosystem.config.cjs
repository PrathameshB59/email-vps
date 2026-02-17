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
      },
    },
  ],
};
