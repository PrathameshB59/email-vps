const fs = require("fs");
const path = require("path");
const { MailValidationError } = require("./errors");

const templateDir = path.resolve(__dirname, "templates");

const templateDefinitions = {
  "system-alert": {
    file: "system-alert.html",
    defaultSubject: "[Email-VPS] System Alert: {{title}}",
    defaultText: "System alert from Email-VPS\nTitle: {{title}}\nSeverity: {{severity}}\nService: {{service}}\nDetails: {{details}}\nTimestamp: {{timestamp}}",
  },
  "app-notification": {
    file: "app-notification.html",
    defaultSubject: "[Email-VPS] App Notification: {{title}}",
    defaultText: "Application notification\nTitle: {{title}}\nSummary: {{summary}}\nAction: {{action_url}}\nTimestamp: {{timestamp}}",
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

function renderTemplate(templateName, variables = {}, overrides = {}) {
  const definition = templateDefinitions[templateName];
  if (!definition) {
    throw new MailValidationError(`Unknown template: ${templateName}`);
  }

  const mergedVariables = {
    title: "Untitled",
    severity: "info",
    service: "email-vps",
    details: "No details provided",
    summary: "No summary provided",
    action_url: "",
    timestamp: new Date().toISOString(),
    ...variables,
  };

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
