const test = require("node:test");
const assert = require("node:assert/strict");
const { renderTemplate } = require("../src/mail/templateRegistry");

test("system-alert template renders variables", () => {
  const rendered = renderTemplate("system-alert", {
    title: "Disk Usage",
    severity: "warning",
    service: "nginx",
    details: "Disk is above 85%",
    timestamp: "2026-02-17T00:00:00.000Z",
  });

  assert.match(rendered.subject, /Disk Usage/);
  assert.match(rendered.html, /Disk is above 85%/);
  assert.match(rendered.text, /severity/i);
});

