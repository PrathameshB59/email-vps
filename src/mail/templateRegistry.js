const fs = require("fs");
const path = require("path");
const { MailValidationError } = require("./errors");

const templateDir = path.resolve(__dirname, "templates");

const templateDefinitions = {
  "system-alert": {
    file: "system-alert.html",
    defaultSubject: "[Email-VPS][{{severityUpper}}] Incident {{incidentId}}: {{title}}",
    defaultText: [
      "Email-VPS Ops Incident Digest",
      "",
      "What happened",
      "- Title: {{title}}",
      "- Summary: {{summary}}",
      "- Severity: {{severityUpper}}",
      "- Incident ID: {{incidentId}}",
      "",
      "Impact",
      "{{impact}}",
      "",
      "Probable cause",
      "{{probableCause}}",
      "",
      "What to do now",
      "{{recommendedAction}}",
      "",
      "Details",
      "{{details}}",
      "",
      "Next update ETA: {{nextUpdateEta}}",
      "Dashboard: {{dashboardUrl}}",
      "Runbook: {{runbookUrl}}",
      "",
      "Metadata",
      "- Service: {{service}}",
      "- Environment: {{environment}}",
      "- Timestamp: {{timestamp}}",
      "- Request ID: {{requestId}}",
    ].join("\n"),
  },
  "delivery-probe": {
    file: "delivery-probe.html",
    defaultSubject:
      "[Email-VPS][{{severityUpper}}] Delivery Probe {{incidentId}}: {{title}}",
    defaultText: [
      "Email-VPS Delivery Probe Report",
      "",
      "Probe summary",
      "- Title: {{title}}",
      "- Incident ID: {{incidentId}}",
      "- Severity: {{severityUpper}}",
      "- Trigger source: {{triggerSource}}",
      "- Trigger actor: {{triggeredBy}}",
      "",
      "What happened",
      "{{summary}}",
      "",
      "Impact",
      "{{impact}}",
      "",
      "Recommended action",
      "{{recommendedAction}}",
      "",
      "Diagnostics",
      "- Probe recipient: {{probeRecipient}}",
      "- Queue pending: {{queuePending}}",
      "- Queue retrying: {{queueRetrying}}",
      "- Queue failed: {{queueFailed}}",
      "- Relay endpoint: {{relayHost}}:{{relayPort}}",
      "",
      "Details",
      "{{details}}",
      "",
      "Dashboard: {{dashboardUrl}}",
      "Runbook: {{runbookUrl}}",
      "",
      "Metadata",
      "- Service: {{service}}",
      "- Environment: {{environment}}",
      "- Timestamp: {{timestamp}}",
      "- Request ID: {{requestId}}",
    ].join("\n"),
  },
  "cron-warning": {
    file: "cron-warning.html",
    defaultSubject: "[Email-VPS][CRON][{{severityUpper}}] {{title}} ({{incidentId}})",
    defaultText: [
      "Email-VPS Cron Warning",
      "",
      "What happened",
      "- Title: {{title}}",
      "- Severity: {{severityUpper}}",
      "- Incident ID: {{incidentId}}",
      "- Schedule: {{cronExpression}}",
      "- Job path: {{jobPath}}",
      "",
      "Summary",
      "{{summary}}",
      "",
      "Impact",
      "{{impact}}",
      "",
      "Probable cause",
      "{{probableCause}}",
      "",
      "Recommended action",
      "{{recommendedAction}}",
      "",
      "Raw snippet",
      "{{rawSnippet}}",
      "",
      "Next update ETA: {{nextUpdateEta}}",
      "Dashboard: {{dashboardUrl}}",
      "Runbook: {{runbookUrl}}",
      "",
      "Metadata",
      "- Service: {{service}}",
      "- Environment: {{environment}}",
      "- Timestamp: {{timestamp}}",
      "- Request ID: {{requestId}}",
    ].join("\n"),
  },
  "logwatch-digest": {
    file: "logwatch-digest.html",
    defaultSubject:
      "[Email-VPS][LOGWATCH][{{severityUpper}}] {{title}} ({{reportPeriod}})",
    defaultText: [
      "Email-VPS Logwatch Digest",
      "",
      "Digest overview",
      "- Title: {{title}}",
      "- Severity: {{severityUpper}}",
      "- Report period: {{reportPeriod}}",
      "- Source window: {{windowLabel}}",
      "- Warning count: {{warningCount}}",
      "",
      "What happened",
      "{{summary}}",
      "",
      "Top warning signatures",
      "{{warningSummary}}",
      "",
      "Relevant snippet",
      "{{rawSnippet}}",
      "",
      "Recommended action",
      "{{recommendedAction}}",
      "",
      "Dashboard: {{dashboardUrl}}",
      "Runbook: {{runbookUrl}}",
      "",
      "Metadata",
      "- Service: {{service}}",
      "- Environment: {{environment}}",
      "- Timestamp: {{timestamp}}",
      "- Request ID: {{requestId}}",
    ].join("\n"),
  },
  "postfix-warning": {
    file: "postfix-warning.html",
    defaultSubject:
      "[Email-VPS][POSTFIX][{{severityUpper}}] {{title}} ({{incidentId}})",
    defaultText: [
      "Email-VPS Postfix Warning",
      "",
      "What happened",
      "- Title: {{title}}",
      "- Severity: {{severityUpper}}",
      "- Incident ID: {{incidentId}}",
      "- Config path: {{mainCfPath}}",
      "- Key: {{configKey}}",
      "- Lines: {{lineList}}",
      "",
      "Summary",
      "{{summary}}",
      "",
      "Impact",
      "{{impact}}",
      "",
      "Probable cause",
      "{{probableCause}}",
      "",
      "Recommended action",
      "{{recommendedAction}}",
      "",
      "Raw snippet",
      "{{rawSnippet}}",
      "",
      "Dashboard: {{dashboardUrl}}",
      "Runbook: {{runbookUrl}}",
      "",
      "Metadata",
      "- Service: {{service}}",
      "- Environment: {{environment}}",
      "- Timestamp: {{timestamp}}",
      "- Request ID: {{requestId}}",
    ].join("\n"),
  },
  "health-check": {
    file: "health-check.html",
    defaultSubject: "[Email-VPS] Health Check ({{frequencyUpper}}): {{triggerType}} — Delivery OK",
    defaultText: [
      "Email-VPS Health Check",
      "",
      "✓ Delivery Verified",
      "If you received this email, end-to-end mail delivery from your VPS is working correctly.",
      "",
      "Details",
      "- Trigger: {{triggerType}}",
      "- Frequency: {{frequencyUpper}}",
      "- Host: {{hostname}}",
      "- Triggered by: {{triggeredBy}}",
      "- Summary: {{summary}}",
      "- Sent at: {{timestamp}}",
      "",
      "Automatic Schedule (UTC)",
      "- Daily:   0 8 * * *   — Every day at 08:00",
      "- Weekly:  0 9 * * 1   — Every Monday at 09:00",
      "- Monthly: 0 10 1 * *  — 1st of month at 10:00",
      "- Yearly:  0 11 1 1 *  — Jan 1st at 11:00",
      "",
      "Dashboard: {{dashboardUrl}}",
      "",
      "Service: {{service}} | Environment: {{environment}} | Request ID: {{requestId}}",
    ].join("\n"),
  },
  "app-notification": {
    file: "app-notification.html",
    defaultSubject: "[Email-VPS][{{severityUpper}}] Notification {{incidentId}}: {{title}}",
    defaultText: [
      "Email-VPS Ops Notification Digest",
      "",
      "What happened",
      "- Title: {{title}}",
      "- Summary: {{summary}}",
      "- Severity: {{severityUpper}}",
      "- Incident ID: {{incidentId}}",
      "",
      "Impact",
      "{{impact}}",
      "",
      "Probable cause",
      "{{probableCause}}",
      "",
      "Recommended action",
      "{{recommendedAction}}",
      "",
      "Details",
      "{{details}}",
      "",
      "Next update ETA: {{nextUpdateEta}}",
      "Dashboard: {{dashboardUrl}}",
      "Runbook: {{runbookUrl}}",
      "",
      "Metadata",
      "- Service: {{service}}",
      "- Environment: {{environment}}",
      "- Timestamp: {{timestamp}}",
      "- Request ID: {{requestId}}",
    ].join("\n"),
  },
};

const htmlCache = new Map();

function interpolate(input, variables) {
  return input.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    const value = variables[key];
    if (value === undefined || value === null) {
      return "";
    }
    return String(value);
  });
}

function getTemplateHtml(templateName) {
  const definition = templateDefinitions[templateName];
  if (!definition) {
    throw new MailValidationError(`Unknown template: ${templateName}`);
  }

  if (!htmlCache.has(templateName)) {
    const templatePath = path.join(templateDir, definition.file);
    const html = fs.readFileSync(templatePath, "utf8");
    htmlCache.set(templateName, html);
  }

  return htmlCache.get(templateName);
}

function normalizeVariables(variables = {}) {
  const severity = String(variables.severity || "info").trim().toLowerCase() || "info";
  const timestamp = String(variables.timestamp || new Date().toISOString());
  const incidentId = String(variables.incidentId || variables.requestId || "N/A");
  const dashboardUrl = String(
    variables.dashboardUrl || variables.action_url || "https://mail.stackpilot.in/dashboard"
  );
  const runbookUrl = String(variables.runbookUrl || dashboardUrl);

  const frequency = String(variables.frequency || "manual").trim().toLowerCase();
  const triggerType = String(variables.triggerType || "Manual").trim();

  return {
    title: "Untitled alert",
    summary: "No summary provided.",
    impact: "Impact is still being assessed.",
    probableCause: "Probable cause not yet identified.",
    recommendedAction: "No immediate action required.",
    nextUpdateEta: "TBD",
    details: "No additional details provided.",
    severity,
    severityUpper: severity.toUpperCase(),
    service: "email-vps",
    environment: "production",
    incidentId,
    dashboardUrl,
    runbookUrl,
    requestId: String(variables.requestId || incidentId),
    timestamp,
    action_url: dashboardUrl,
    // health-check specific defaults
    frequency,
    frequencyUpper: frequency.toUpperCase(),
    triggerType,
    hostname: "vps",
    triggeredBy: "cron",
    triggerSource: "dashboard",
    probeRecipient: "not-configured",
    queuePending: "0",
    queueRetrying: "0",
    queueFailed: "0",
    relayHost: "127.0.0.1",
    relayPort: "25",
    cronExpression: "* * * * *",
    jobPath: "/home/devuser/dev/email-vps/generate_metrics.sh",
    reportPeriod: "daily",
    windowLabel: "24h",
    warningCount: "0",
    warningSummary: "No warning signatures provided.",
    mainCfPath: "/etc/postfix/main.cf",
    configKey: "smtp_tls_security_level",
    lineList: "-",
    rawSnippet: "No raw snippet provided.",
    ...variables,
  };
}

function renderTemplate(templateName, variables = {}, overrides = {}) {
  const definition = templateDefinitions[templateName];
  if (!definition) {
    throw new MailValidationError(`Unknown template: ${templateName}`);
  }

  const mergedVariables = normalizeVariables(variables);

  const subjectTemplate = overrides.subject || definition.defaultSubject;
  const textTemplate = overrides.text || definition.defaultText;
  const htmlTemplate = overrides.html || getTemplateHtml(templateName);

  return {
    templateName,
    subject: interpolate(subjectTemplate, mergedVariables).trim(),
    text: interpolate(textTemplate, mergedVariables).trim(),
    html: interpolate(htmlTemplate, mergedVariables),
  };
}

function listTemplates() {
  return Object.keys(templateDefinitions);
}

module.exports = {
  interpolate,
  listTemplates,
  renderTemplate,
};
