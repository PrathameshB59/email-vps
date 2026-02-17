const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

test("generate_metrics.sh no longer depends on /opt path", () => {
  const scriptPath = path.resolve(__dirname, "..", "generate_metrics.sh");
  const content = fs.readFileSync(scriptPath, "utf8");

  assert.equal(content.includes("/opt/stackpilot-monitor"), false);
  assert.match(content, /SCRIPT_DIR=/);
  assert.match(content, /OUTPUT=.*metrics\.json/);
});
