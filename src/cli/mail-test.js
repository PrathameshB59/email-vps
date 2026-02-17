const { createCore } = require("../runtime");

function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) {
    return null;
  }
  return process.argv[idx + 1];
}

async function main() {
  const to = getArg("--to");

  if (!to) {
    throw new Error("Usage: npm run mail:test -- --to you@example.com");
  }

  const core = await createCore();

  try {
    const result = await core.mailService.send(
      {
        to,
        subject: "Email-VPS Test Delivery",
        text: "This is a test delivery from email-vps CLI.",
        category: "system-alert",
      },
      { processNow: true }
    );

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await core.close();
  }
}

main().catch((error) => {
  console.error("[mail:test] failed:", error.message);
  process.exit(1);
});
