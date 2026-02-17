const { createAdminRuntime } = require("./runtime");

function getArg(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) {
    return null;
  }
  return process.argv[index + 1];
}

async function main() {
  const email = getArg("--email") || process.env.ADMIN_SEED_EMAIL;
  const password = getArg("--password") || process.env.ADMIN_SEED_PASSWORD;
  const role = getArg("--role") || process.env.ADMIN_DEFAULT_ROLE || "admin";

  if (!email || !password) {
    throw new Error("Usage: npm run seed:admin -- --email admin@example.com --password 'StrongPassword'");
  }

  const runtime = await createAdminRuntime();

  try {
    const user = await runtime.authService.ensureAdminUser({ email, password, role });
    console.log(JSON.stringify({ seeded: true, user }, null, 2));
  } finally {
    await runtime.close();
  }
}

main().catch((error) => {
  console.error("[seed:admin] failed:", error.message);
  process.exit(1);
});
