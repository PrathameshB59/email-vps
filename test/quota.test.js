const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRepository } = require("../src/mail/repository");
const { createRateLimiter } = require("../src/mail/rateLimiter");

test("daily quota blocks after configured limit and resets by date", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "email-vps-quota-"));
  const dbPath = path.join(tempDir, "quota.sqlite");

  const repository = await createRepository({ dbPath });
  const limiter = createRateLimiter({ repository, dailyLimit: 2 });

  const now = new Date("2026-02-17T10:00:00.000Z");
  const sameDay1 = await limiter.reserveSlot(now);
  const sameDay2 = await limiter.reserveSlot(now);
  const sameDay3 = await limiter.reserveSlot(now);

  assert.equal(sameDay1.reserved, true);
  assert.equal(sameDay2.reserved, true);
  assert.equal(sameDay3.reserved, false);

  const nextDay = new Date("2026-02-18T01:00:00.000Z");
  const nextDayResult = await limiter.reserveSlot(nextDay);
  assert.equal(nextDayResult.reserved, true);

  await repository.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
