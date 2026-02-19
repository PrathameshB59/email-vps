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

test("delivery-probe template renders probe diagnostics sections", () => {
  const rendered = renderTemplate("delivery-probe", {
    title: "Manual Delivery Probe",
    severity: "info",
    incidentId: "probe-123",
    requestId: "probe-123",
    triggerSource: "dashboard-manual-probe",
    triggeredBy: "owner (198.51.100.22)",
    probeRecipient: "owner@example.com",
    queuePending: "1",
    queueRetrying: "0",
    queueFailed: "0",
    relayHost: "127.0.0.1",
    relayPort: "25",
  });

  assert.match(rendered.subject, /Delivery Probe/i);
  assert.match(rendered.html, /Probe diagnostics/i);
  assert.match(rendered.html, /Queue state/i);
  assert.match(rendered.text, /Probe summary/i);
  assert.match(rendered.text, /Relay endpoint/i);
});

test("postfix-warning template renders config issue diagnostics", () => {
  const rendered = renderTemplate("postfix-warning", {
    title: "Duplicate Postfix key",
    severity: "warning",
    incidentId: "postfix-01",
    configKey: "smtp_tls_security_level",
    lineList: "49, 51",
    rawSnippet: "smtp_tls_security_level=may",
  });

  assert.match(rendered.subject, /POSTFIX/i);
  assert.match(rendered.html, /Configuration key/i);
  assert.match(rendered.html, /line list/i);
  assert.match(rendered.text, /Config path/i);
  assert.match(rendered.text, /Raw snippet/i);
});

test("cron-warning template renders schedule and remediation blocks", () => {
  const rendered = renderTemplate("cron-warning", {
    title: "Metrics cron path mismatch",
    severity: "warning",
    incidentId: "cron-01",
    cronExpression: "* * * * *",
    jobPath: "/home/devuser/dev/email-vps/generate_metrics.sh",
    rawSnippet: "/bin/sh: 1: /opt/stackpilot-monitor/generate_metrics.sh: not found",
  });

  assert.match(rendered.subject, /CRON/i);
  assert.match(rendered.html, /Job Context/i);
  assert.match(rendered.html, /What to do now/i);
  assert.match(rendered.text, /Schedule:/i);
  assert.match(rendered.text, /Job path:/i);
});

test("logwatch-digest template renders warning summary and snippets", () => {
  const rendered = renderTemplate("logwatch-digest", {
    title: "Daily Logwatch Digest",
    severity: "warning",
    reportPeriod: "daily",
    warningCount: "4",
    warningSummary: "postfix duplicate warning x2 | fail2ban warning x2",
    rawSnippet: "sendmail: warning: /etc/postfix/main.cf line 50 overriding earlier entry",
  });

  assert.match(rendered.subject, /LOGWATCH/i);
  assert.match(rendered.html, /Top warning signatures/i);
  assert.match(rendered.html, /sendmail: warning/i);
  assert.match(rendered.text, /Warning count:/i);
  assert.match(rendered.text, /Top warning signatures/i);
});

test("health-check template renders delivery confirmation details", () => {
  const rendered = renderTemplate("health-check", {
    triggerType: "Manual",
    frequency: "manual",
    hostname: "stackpilot",
    triggeredBy: "Prathamesh Birajdar (203.0.113.22)",
    requestId: "health-01",
  });

  assert.match(rendered.subject, /Health Check/i);
  assert.match(rendered.html, /Delivery Verified/i);
  assert.match(rendered.html, /Check Details/i);
  assert.match(rendered.text, /Automatic Schedule/i);
  assert.match(rendered.text, /Trigger:/i);
});
