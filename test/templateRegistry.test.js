const test = require("node:test");
const assert = require("node:assert/strict");
const { renderTemplate } = require("../src/mail/templateRegistry");

test("system-alert template renders structured incident digest", () => {
  const rendered = renderTemplate("system-alert", {
    title: "Disk usage above threshold",
    severity: "warning",
    service: "email-vps",
    environment: "production",
    summary: "Disk utilization crossed 90% on root volume.",
    impact: "New queue inserts may fail if disk reaches 100%.",
    probableCause: "Log rotation failed for postfix and pm2 logs.",
    recommendedAction: "Rotate logs and clear stale artifacts.",
    nextUpdateEta: "15 minutes",
    runbookUrl: "https://mail.stackpilot.in/runbook/disk",
    dashboardUrl: "https://mail.stackpilot.in/dashboard",
    incidentId: "INC-2026-0217-001",
    requestId: "req-001",
    details: "Root partition is 92%.",
    timestamp: "2026-02-17T00:00:00.000Z",
  });

  assert.match(rendered.subject, /INC-2026-0217-001/);
  assert.match(rendered.subject, /WARNING/);
  assert.match(rendered.html, /What happened/i);
  assert.match(rendered.html, /Probable cause/i);
  assert.match(rendered.html, /Open Dashboard/i);
  assert.match(rendered.text, /What to do now/i);
  assert.match(rendered.text, /Metadata/i);
  assert.match(rendered.text, /Request ID: req-001/i);
});

test("app-notification template fallback text includes critical expanded fields", () => {
  const rendered = renderTemplate("app-notification", {
    title: "Queue backlog update",
    severity: "info",
    summary: "Queue backlog cleared.",
    incidentId: "NOTIFY-123",
  });

  assert.match(rendered.subject, /NOTIFY-123/);
  assert.match(rendered.html, /Recommended action checklist/i);
  assert.match(rendered.text, /Dashboard:/i);
  assert.match(rendered.text, /Runbook:/i);
  assert.match(rendered.text, /Environment:/i);
});
