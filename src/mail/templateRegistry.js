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
