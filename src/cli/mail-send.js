const { createCore } = require("../runtime");

function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) {
    return null;
  }
  return process.argv[idx + 1];
}

function parseVars(input) {
  if (!input) {
    return {};
  }

  const pairs = input.split(",").map((chunk) => chunk.trim()).filter(Boolean);
  const variables = {};

  for (const pair of pairs) {
    const [rawKey, ...rest] = pair.split("=");
    const key = (rawKey || "").trim();
    const value = rest.join("=").trim();

    if (!key) {
      continue;
    }

    variables[key] = value;
  }

  return variables;
}

async function main() {
  const to = getArg("--to");
  const template = getArg("--template");
  const category = getArg("--category");
  const subject = getArg("--subject");
  const vars = parseVars(getArg("--vars"));

  if (!to || !template) {
    throw new Error(
      "Usage: npm run mail:send -- --to you@example.com --template system-alert --vars title=CPU,details=High"
    );
  }

  const core = await createCore();

  try {
    const result = await core.mailService.sendTemplate(
      {
        to,
        template,
        category: category || template,
        subject,
        variables: vars,
      },
      { processNow: true }
    );

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await core.close();
  }
}

main().catch((error) => {
  console.error("[mail:send] failed:", error.message);
  process.exit(1);
});
