import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { loadConfig } from "../../src/config/loadConfig.js";
import { createPool } from "../../src/infrastructure/persistence/mysql/createPool.js";
import { MySqlWritingFeedbackRepository } from "../../src/infrastructure/persistence/mysql/writing-feedback/MySqlWritingFeedbackRepository.js";

const NOW = "2026-09-12T12:00:00.000Z";
const LATER = "2026-09-12T12:01:00.000Z";
const END = "2026-09-12T12:02:00.000Z";
const PROFILE = { model: "fixture-model", promptVersion: "fixture-v1", modelDigest: "sha256:fixture" };

// Mutating repository fixtures require the existing explicit, disposable MySQL CI gate.
test("Writing feedback migration, concurrency and lease contracts execute against MySQL", {
  skip: process.env.LEARNING_PATH_MYSQL_INTEGRATION !== "1",
}, async (t) => {
  assert.match(process.env.DB_NAME || "", /_ci$/u, "Never run writing feedback fixtures against a production database.");
  const pool = createPool(loadConfig(process.env).database);
  const repository = new MySqlWritingFeedbackRepository(pool);
  const otherProcess = new MySqlWritingFeedbackRepository(pool);
  const userIds = [];
  const workerId = `wf-ci-${randomUUID()}`;

  t.after(async () => {
    try {
      // Only this suite's worker owns these temporary leases in the isolated CI database.
      await pool.execute("UPDATE writing_feedback_gate SET job_id = NULL, worker_id = NULL, lease_token = NULL, lease_until = NULL WHERE worker_id = ?", [workerId]);
      for (const id of userIds) await pool.execute("DELETE FROM users WHERE id = ?", [id]);
    } finally { await pool.end(); }
  });

  async function owner() {
    const [inserted] = await pool.execute("INSERT INTO users (email, password_hash) VALUES (?, 'integration-only')", [`wf-${randomUUID()}@example.test`]);
    const id = String(inserted.insertId);
    userIds.push(id);
    return id;
  }
  function draft(userId, overrides = {}) {
    const id = randomUUID();
    return {
      id, userId, requestHash: "a".repeat(64), idempotencyKey: randomUUID(), parentSubmissionId: null,
      pathId: "wf-path", lessonId: "wf-lesson", exerciseId: "wf-exercise", slideId: "wf-writing",
      exerciseStartedAt: NOW, draftText: "I drink water. Café ☕", notes: "Keep my planning notes.",
      taskContext: { prompt: "Describe breakfast.", objectives: ["Present simple"] },
      evaluationProfile: PROFILE, contentVersion: "fixture-v1", status: "queued", attemptCount: 0,
      errorCode: null, createdAt: NOW, updatedAt: NOW, expiresAt: "2026-10-12T12:00:00.000Z", ...overrides,
    };
  }
  async function claim(now = NOW, leaseUntil = LATER, repo = repository, evaluationProfile = PROFILE) {
    return repo.claim({ workerId, leaseToken: randomUUID(), now, leaseUntil, evaluationProfile });
  }
  async function finish(job, { now = NOW, status = "completed", ...rest } = {}) {
    return repository.finish({ id: job.id, leaseToken: job.leaseToken, now, status, result: { comment: "Review the sentence." }, identity: PROFILE, metrics: { durationMs: 10 }, ...rest });
  }

  await t.test("migration 024 is applied and concurrent duplicate submissions charge once", async () => {
    const [[migration]] = await pool.execute("SELECT version FROM schema_migrations WHERE version = '024_writing_feedback.sql'");
    assert.equal(migration.version, "024_writing_feedback.sql");
    const userId = await owner();
    const original = draft(userId, { status: "unavailable", errorCode: "WRITING_FEEDBACK_DISABLED", evaluationProfile: null });
    const [first, duplicate] = await Promise.all([
      repository.enqueue(original, { now: NOW }),
      otherProcess.enqueue({ ...original, id: randomUUID() }, { now: NOW }),
    ]);
    assert.equal(first.id, duplicate.id);
    const stored = await repository.findOwned(userId, first.id);
    assert.equal(stored.draftText, original.draftText);
    assert.equal(stored.notes, original.notes);
    assert.deepEqual(stored.taskContext, original.taskContext);
    assert.equal(stored.exerciseStartedAt, NOW);
    assert.equal(stored.createdAt, NOW);
    assert.equal(stored.evaluationProfile, null);
    const [[count]] = await pool.execute("SELECT COUNT(*) AS total FROM writing_feedback_submissions WHERE user_id = ?", [userId]);
    const [[quota]] = await pool.execute("SELECT submission_count FROM writing_feedback_daily_quotas WHERE user_id = ?", [userId]);
    assert.equal(Number(count.total), 1);
    assert.equal(Number(quota.submission_count), 1);
    await assert.rejects(repository.enqueue({ ...original, requestHash: "b".repeat(64) }, { now: NOW }), { code: "WRITING_FEEDBACK_IDEMPOTENCY_CONFLICT" });
    await assert.rejects(pool.execute("UPDATE writing_feedback_submissions SET attempt_count = 4 WHERE id = ?", [first.id]), { code: "ER_CHECK_CONSTRAINT_VIOLATED" });
  });

  await t.test("owner predicates protect reads, retry, cancel, delete and revision links", async () => {
    const userId = await owner();
    const stranger = await owner();
    const saved = await repository.enqueue(draft(userId, { status: "unavailable" }), { now: NOW });
    assert.equal(await repository.findOwned(stranger, saved.id), null);
    assert.deepEqual(await repository.listOwned(stranger, saved), []);
    await assert.rejects(repository.retryOwned(stranger, saved.id, { now: NOW }), { code: "WRITING_FEEDBACK_NOT_FOUND" });
    await assert.rejects(repository.cancelOwned(stranger, saved.id, NOW), { code: "WRITING_FEEDBACK_NOT_FOUND" });
    assert.equal(await repository.deleteOwned(stranger, saved.id), false);
    await assert.rejects(repository.enqueue(draft(stranger, { parentSubmissionId: saved.id }), { now: NOW }), { code: "WRITING_FEEDBACK_PARENT_NOT_FOUND" });
    const revision = await repository.enqueue(draft(userId, { parentSubmissionId: saved.id, slideId: "wf-revision", status: "unavailable" }), { now: NOW });
    assert.equal(revision.parentSubmissionId, saved.id);
    await assert.rejects(repository.enqueue(draft(userId, { parentSubmissionId: saved.id, exerciseStartedAt: LATER }), { now: NOW }), { code: "WRITING_FEEDBACK_PARENT_NOT_FOUND" });
  });

  await t.test("expired idempotent submissions hide old feedback without replacing the snapshot or key", async () => {
    const userId = await owner();
    const original = draft(userId, { expiresAt: LATER });
    const saved = await repository.enqueue(original, { now: NOW });
    const active = await claim(NOW, END);
    assert.equal(active.id, saved.id);
    assert.equal(await finish(active), true);
    const completed = await repository.findOwned(userId, saved.id);
    for (const replayTime of [LATER, END]) {
      await assert.rejects(repository.enqueue({ ...original, id: randomUUID() }, { now: replayTime }), { statusCode: 404, code: "WRITING_FEEDBACK_NOT_FOUND" });
    }
    await assert.rejects(repository.enqueue({ ...original, requestHash: "b".repeat(64) }, { now: LATER }), { statusCode: 404, code: "WRITING_FEEDBACK_NOT_FOUND" });
    assert.deepEqual(await repository.findOwned(userId, saved.id), completed);
    const [[count]] = await pool.execute("SELECT COUNT(*) AS total FROM writing_feedback_submissions WHERE user_id = ?", [userId]);
    const [[quota]] = await pool.execute("SELECT submission_count FROM writing_feedback_daily_quotas WHERE user_id = ?", [userId]);
    assert.equal(Number(count.total), 1);
    assert.equal(Number(quota.submission_count), 1);
    await repository.deleteOwned(userId, saved.id);
  });

  await t.test("concurrent admissions preserve every draft and bound global and owner queues", async () => {
    const owners = await Promise.all(Array.from({ length: 5 }, () => owner()));
    const saved = await Promise.all(owners.flatMap((userId) => Array.from({ length: 3 }, () => repository.enqueue(draft(userId), { now: NOW }))));
    assert.equal(saved.filter((row) => row.status === "queued").length, 8);
    assert.equal(saved.filter((row) => row.errorCode === "WRITING_FEEDBACK_QUEUE_FULL").length, 7);
    for (const userId of owners) assert.ok(saved.filter((row) => row.userId === userId && row.status === "queued").length <= 2);
    for (const row of saved) await repository.cancelOwned(row.userId, row.id, NOW);
  });

  await t.test("two workers cannot claim together and a first profile remains pinned", async () => {
    const userId = await owner();
    const saved = await repository.enqueue(draft(userId, { status: "unavailable", evaluationProfile: null }), { now: NOW });
    await repository.retryOwned(userId, saved.id, { now: NOW });
    const claims = await Promise.all([claim(), claim(NOW, LATER, otherProcess)]);
    assert.equal(claims.filter(Boolean).length, 1);
    const active = claims.find(Boolean);
    assert.equal(active.id, saved.id);
    assert.deepEqual(active.evaluationProfile, PROFILE);
    assert.equal(await finish(active, { status: "unavailable", result: null, errorCode: "WRITING_FEEDBACK_TIMEOUT" }), true);
    await repository.retryOwned(userId, saved.id, { now: NOW });
    const retried = await claim(NOW, LATER, repository, { model: "changed-model" });
    assert.deepEqual(retried.evaluationProfile, PROFILE);
    assert.equal(retried.attemptCount, 2);
    assert.equal(await finish(retried), true);
    assert.equal((await repository.findOwned(userId, saved.id)).status, "completed");
  });

  await t.test("cancelling or deleting a running job cannot prematurely free provider concurrency", async () => {
    const userId = await owner();
    const a = await repository.enqueue(draft(userId), { now: NOW });
    const runningA = await claim();
    assert.equal(runningA.id, a.id);
    const b = await repository.enqueue(draft(userId), { now: NOW });
    await repository.cancelOwned(userId, a.id, NOW);
    assert.equal(await claim(), null);
    assert.equal(await finish(runningA), false);
    assert.equal((await repository.findOwned(userId, a.id)).status, "cancelled");
    const runningB = await claim();
    assert.equal(runningB.id, b.id);
    await repository.deleteOwned(userId, b.id);
    const c = await repository.enqueue(draft(userId), { now: NOW });
    assert.equal(await claim(), null);
    assert.equal(await finish(runningB), false);
    const runningC = await claim();
    assert.equal(runningC.id, c.id);
    assert.equal(await finish(runningC), true);
    assert.equal(await repository.findOwned(userId, b.id), null);
  });

  await t.test("lease expiry fences restarted workers and no draft can exceed three attempts", async () => {
    const userId = await owner();
    const a = await repository.enqueue(draft(userId), { now: NOW });
    const old = await claim();
    const b = await repository.enqueue(draft(userId), { now: NOW });
    const active = await claim(LATER, END, otherProcess);
    assert.equal(active.id, b.id);
    assert.equal(await finish(old, { now: LATER }), false);
    assert.equal((await repository.findOwned(userId, a.id)).errorCode, "WRITING_FEEDBACK_INTERRUPTED");
    assert.equal(await finish(active, { now: LATER }), true);
    for (const attempt of [2, 3]) {
      await repository.retryOwned(userId, a.id, { now: LATER });
      const retried = await claim(LATER, END);
      assert.equal(retried.attemptCount, attempt);
      assert.equal(retried.draftText, a.draftText);
      assert.equal(retried.notes, a.notes);
      await finish(retried, { now: LATER, status: "unavailable", errorCode: "WRITING_FEEDBACK_TIMEOUT", result: null });
    }
    await assert.rejects(repository.retryOwned(userId, a.id, { now: LATER, maxAttempts: 999 }), { code: "WRITING_FEEDBACK_ATTEMPTS_EXHAUSTED" });
  });

  await t.test("deletion cannot reset the daily quota and each slide retains its complete bounded history", async () => {
    const userId = await owner();
    for (let index = 0; index < 2; index += 1) {
      const saved = await repository.enqueue(draft(userId, { status: "unavailable" }), { now: NOW, maxPerOwnerDay: 2 });
      await repository.deleteOwned(userId, saved.id);
    }
    await assert.rejects(repository.enqueue(draft(userId, { status: "unavailable" }), { now: NOW, maxPerOwnerDay: 2 }), { code: "WRITING_FEEDBACK_DAILY_LIMIT" });
    const revisionsOwner = await owner();
    const saved = [];
    for (let index = 0; index < 10; index += 1) saved.push(await repository.enqueue(draft(revisionsOwner, { status: "unavailable" }), { now: NOW }));
    await assert.rejects(repository.enqueue(draft(revisionsOwner, { status: "unavailable" }), { now: NOW }), { code: "WRITING_FEEDBACK_REVISION_LIMIT" });
    const history = await repository.listOwned(revisionsOwner, saved[0]);
    assert.equal(history.length, 10);
    assert.ok(history.some((row) => row.id === saved[0].id));
    const otherSlide = await repository.enqueue(draft(revisionsOwner, { status: "unavailable", slideId: "wf-other-slide" }), { now: NOW });
    assert.equal(otherSlide.status, "unavailable");
  });

  await t.test("retention removes expired drafts in bounded batches", async () => {
    const userId = await owner();
    const saved = await Promise.all(Array.from({ length: 3 }, () => repository.enqueue(draft(userId, { status: "unavailable", expiresAt: LATER }), { now: NOW })));
    assert.equal(await repository.purgeExpired(LATER, 2), 2);
    const remaining = await repository.listOwned(userId, saved[0]);
    assert.equal(remaining.length, 1);
    assert.equal(await repository.purgeExpired(LATER, 2), 1);
  });
});
