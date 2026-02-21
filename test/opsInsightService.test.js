const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRepository } = require("../src/mail/repository");
const { __private } = require("../src/dashboard/services/opsInsightService");

const {
  parsePostfixConfig,
  extractLogWarnings,
  makeOpsEvent,
  summarizeLogWarnings,
  parseRcloneLogDiagnostics,
  detectRcloneProfileMode,
} = __private;

test("postfix parser detects duplicate keys and warning severities", () => {
  const parsed = parsePostfixConfig(`
# postfix configuration
relayhost = [smtp.gmail.com]:587
smtp_tls_security_level = may
myhostname = stackpilot
relayhost = [smtp.gmail.com]:587
smtp_tls_security_level = may
`);

  assert.equal(Array.isArray(parsed.issues), true);
  assert.equal(parsed.issues.length, 2);

  const relayIssue = parsed.issues.find((issue) => issue.key === "relayhost");
  assert.ok(relayIssue);
  assert.equal(relayIssue.severity, "warning");
  assert.match(relayIssue.lineList, /3, 6/);

  const tlsIssue = parsed.issues.find((issue) => issue.key === "smtp_tls_security_level");
  assert.ok(tlsIssue);
  assert.equal(tlsIssue.severity, "warning");
  assert.match(tlsIssue.rawSnippet, /smtp_tls_security_level=may/);
});

test("log warning extractor classifies cron, postfix, and logwatch signals", () => {
  const warnings = extractLogWarnings(`
Feb 19 00:00:01 stackpilot sendmail: warning: /etc/postfix/main.cf, line 50: overriding earlier entry: smtp_tls_security_level=may
Feb 19 00:00:02 stackpilot cron[123]: /bin/sh: 1: /opt/stackpilot-monitor/generate_metrics.sh: not found
Feb 19 00:00:03 stackpilot logwatch: Warning: unmatched entry
`);

  assert.equal(warnings.length, 3);
  assert.equal(warnings.some((event) => event.code === "POSTFIX_DUPLICATE_WARNING"), true);
  assert.equal(warnings.some((event) => event.code === "CRON_STALE_METRICS_PATH"), true);
  assert.equal(warnings.some((event) => event.code === "LOGWATCH_WARNING"), true);

  const summary = summarizeLogWarnings(warnings);
  assert.equal(summary.total, 3);
  assert.equal(summary.bySource.postfix, 1);
  assert.equal(summary.bySource.cron, 1);
  assert.equal(summary.byCode.POSTFIX_DUPLICATE_WARNING, 1);
});

test("ops fingerprint generation is stable for repeated signatures", () => {
  const first = makeOpsEvent({
    source: "postfix",
    severity: "warning",
    code: "POSTFIX_DUPLICATE_KEY",
    title: "Duplicate Postfix key",
    message: "Duplicate relayhost entries detected",
    fingerprintSeed: "relayhost:3,6",
  });

  const second = makeOpsEvent({
    source: "postfix",
    severity: "warning",
    code: "POSTFIX_DUPLICATE_KEY",
    title: "Duplicate Postfix key",
    message: "Duplicate relayhost entries detected",
    fingerprintSeed: "relayhost:3,6",
  });

  const changed = makeOpsEvent({
    source: "postfix",
    severity: "warning",
    code: "POSTFIX_DUPLICATE_KEY",
    title: "Duplicate Postfix key",
    message: "Duplicate smtp_tls_security_level entries detected",
    fingerprintSeed: "smtp_tls_security_level:4,7",
  });

  assert.equal(first.fingerprint, second.fingerprint);
  assert.notEqual(first.fingerprint, changed.fingerprint);
});

test("rclone log diagnostics classify error, warning, and success lines", () => {
  const diagnostics = parseRcloneLogDiagnostics(`
2026/02/19 11:12:01 INFO  : There was nothing to transfer
2026/02/19 11:12:03 NOTICE: copied (new) file
2026/02/19 11:12:08 ERROR : Failed to copy: directory not found
2026/02/19 11:12:12 WARNING: retrying after temporary issue
`);

  assert.equal(diagnostics.lineCount, 4);
  assert.equal(diagnostics.errorCount, 1);
  assert.equal(diagnostics.warningCount, 1);
  assert.match(String(diagnostics.lastErrorLine || ""), /directory not found/i);
  assert.match(String(diagnostics.lastSuccessLine || ""), /nothing to transfer|copied/i);
});

test("rclone profile detection supports hybrid/nightly/autosync/none", () => {
  assert.equal(
    detectRcloneProfileMode({
      hasNightly: true,
      hasAutosync: true,
      cronNightly: true,
      cronAutosync: true,
    }),
    "hybrid"
  );

  assert.equal(
    detectRcloneProfileMode({
      hasNightly: true,
      hasAutosync: false,
      cronNightly: false,
      cronAutosync: false,
    }),
    "nightly"
  );

  assert.equal(
    detectRcloneProfileMode({
      hasNightly: false,
      hasAutosync: false,
      cronNightly: false,
      cronAutosync: true,
    }),
    "autosync"
  );

  assert.equal(
    detectRcloneProfileMode({
      hasNightly: false,
      hasAutosync: false,
      cronNightly: false,
      cronAutosync: false,
    }),
    "none"
  );
});

test("ops events transition open to resolved and reopen on repeat detection", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "email-vps-ops-events-"));
  const dbPath = path.join(tempDir, "ops-events.sqlite");
  const repository = await createRepository({ dbPath });

  try {
    await repository.upsertOpsEvent({
      source: "postfix",
      severity: "warning",
      code: "POSTFIX_DUPLICATE_KEY",
      title: "Duplicate postfix key",
      message: "duplicate relayhost",
      fingerprint: "fp-postfix-relayhost",
      status: "open",
    });

    let openRows = await repository.listOpsEvents({ status: "open" });
    assert.equal(openRows.length, 1);
    assert.equal(openRows[0].status, "open");
    assert.equal(Number(openRows[0].count), 1);

    const resolvedChanges = await repository.resolveOpsEventsNotInFingerprints({
      source: "postfix",
      activeFingerprints: [],
    });
    assert.equal(resolvedChanges, 1);

    openRows = await repository.listOpsEvents({ status: "open" });
    assert.equal(openRows.length, 0);

    const resolvedRows = await repository.listOpsEvents({ status: "resolved" });
    assert.equal(resolvedRows.length, 1);

    await repository.upsertOpsEvent({
      source: "postfix",
      severity: "warning",
      code: "POSTFIX_DUPLICATE_KEY",
      title: "Duplicate postfix key",
      message: "duplicate relayhost",
      fingerprint: "fp-postfix-relayhost",
      status: "open",
    });

    openRows = await repository.listOpsEvents({ status: "open" });
    assert.equal(openRows.length, 1);
    assert.equal(Number(openRows[0].count), 2);
  } finally {
    await repository.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
