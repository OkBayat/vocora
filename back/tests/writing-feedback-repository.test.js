import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { MySqlWritingFeedbackRepository } from "../src/infrastructure/persistence/mysql/writing-feedback/MySqlWritingFeedbackRepository.js";

const now = "2026-09-12T12:00:00.000Z";
const leaseUntil = "2026-09-12T12:05:00.000Z";
const gate = { id: 1, jobId: null, leaseToken: null, leaseUntil: null };
const record = (overrides = {}) => ({
  id: "submission-1", userId: "7", requestHash: "a".repeat(64), idempotencyKey: "request-1",
  parentSubmissionId: null, pathId: "path-1", lessonId: "lesson-1", exerciseId: "exercise-1",
  slideId: "writing-1", exerciseStartedAt: now, draftText: "I drink water.", notes: "Check the full stop.",
  taskContext: { prompt: "Describe breakfast." }, evaluationProfile: { model: "reviewed-model", promptVersion: "1" }, contentVersion: "source-v1", status: "queued",
  attemptCount: 0, createdAt: now, updatedAt: now, expiresAt: "2026-10-12T12:00:00.000Z",
  errorCode: null, result: null, identity: null, metrics: null, ...overrides,
});
const rows = (value) => [value, []];
const changed = (count = 1) => [{ affectedRows: count }, []];
const step = (pattern, result, inspect = () => {}) => ({ pattern, result, inspect });
const lock = (value = gate) => step(/FROM writing_feedback_gate WHERE id = 1 FOR UPDATE/u, rows([value]));
const duplicate = (value) => step(/WHERE user_id = \? AND idempotency_key = \?/u, rows(value ? [value] : []));
const quota = (count = 0) => step(/FROM writing_feedback_daily_quotas/u, rows([{ submissionCount: count }]));
const revisionCount = (count = 0) => step(/COUNT\(\*\) AS revisionCount/u, rows([{ revisionCount: count }]));
const capacity = (global = 0, owner = 0) => step(/COUNT\(\*\) AS activeCount/u, rows([{ activeCount: global, ownerCount: owner }]));
const increaseQuota = () => step(/INSERT INTO writing_feedback_daily_quotas/u, changed());
const insert = (inspect) => step(/INSERT INTO writing_feedback_submissions/u, changed(), inspect);

class ScriptedPool {
  constructor(steps) { this.steps = [...steps]; this.events = []; }
  async getConnection() { return this; }
  async beginTransaction() { this.events.push("begin"); }
  async commit() { this.events.push("commit"); }
  async rollback() { this.events.push("rollback"); }
  release() { this.events.push("release"); }
  async execute(sql, parameters = []) {
    this.events.push({ sql, parameters });
    const next = this.steps.shift();
    assert.ok(next, `Unexpected query: ${sql}`);
    assert.match(sql, next.pattern);
    next.inspect(parameters, sql);
    if (next.result instanceof Error) throw next.result;
    return next.result;
  }
  done() { assert.equal(this.steps.length, 0); }
}
function fixture(steps) {
  const pool = new ScriptedPool(steps);
  return { pool, repository: new MySqlWritingFeedbackRepository(pool) };
}
function transactionSucceeded(pool) {
  pool.done();
  assert.deepEqual([pool.events[0], ...pool.events.slice(-2)], ["begin", "commit", "release"]);
}

describe("Writing feedback persistence contract", () => {
  it("serializes admission and persists immutable text, notes, context and UTC snapshot", async () => {
    const { repository, pool } = fixture([lock(), duplicate(), quota(), revisionCount(), capacity(), increaseQuota(), insert((values) => {
      assert.ok(values.includes("I drink water."));
      assert.ok(values.includes("Check the full stop."));
      assert.ok(values.includes(JSON.stringify(record().taskContext)));
      assert.ok(values.includes(JSON.stringify(record().evaluationProfile)));
      assert.ok(values.includes("2026-09-12 12:00:00.000"));
    })]);
    const saved = await repository.enqueue(record(), { now });
    assert.equal(saved.id, "submission-1");
    assert.equal(saved.status, "queued");
    transactionSucceeded(pool);
  });

  it("deduplicates before charging quota or admitting another job", async () => {
    const existing = record({ taskContext: JSON.stringify(record().taskContext), attemptCount: "1" });
    const { repository, pool } = fixture([lock(), duplicate(existing)]);
    const saved = await repository.enqueue(record({ id: "ignored-new-id" }), { now });
    assert.equal(saved.id, existing.id);
    assert.deepEqual(saved.taskContext, record().taskContext);
    assert.equal(saved.attemptCount, 1);
    transactionSucceeded(pool);
  });

  for (const expiresAt of ["2026-09-01T12:00:00.000Z", now]) {
    it(`hides an expired duplicate without reusing its key or returning feedback (${expiresAt})`, async () => {
      const existing = record({ status: "completed", expiresAt, result: { comment: "Old private feedback." } });
      const before = structuredClone(existing);
      const { repository, pool } = fixture([lock(), duplicate(existing)]);
      await assert.rejects(repository.enqueue(record({ id: "must-not-be-inserted" }), { now }), { statusCode: 404, code: "WRITING_FEEDBACK_NOT_FOUND" });
      assert.deepEqual(existing, before);
      assert.deepEqual(pool.events.slice(-2), ["rollback", "release"]);
      pool.done();
    });
  }

  it("keeps expired idempotency conflicts opaque", async () => {
    const { repository, pool } = fixture([lock(), duplicate(record({ expiresAt: now, requestHash: "b".repeat(64) }))]);
    await assert.rejects(repository.enqueue(record(), { now }), { statusCode: 404, code: "WRITING_FEEDBACK_NOT_FOUND" });
    pool.done();
  });

  it("rejects reuse of an idempotency key for a different immutable request", async () => {
    const { repository, pool } = fixture([lock(), duplicate(record({ requestHash: "b".repeat(64) }))]);
    await assert.rejects(repository.enqueue(record(), { now }), { statusCode: 409, code: "WRITING_FEEDBACK_IDEMPOTENCY_CONFLICT" });
    assert.deepEqual(pool.events.slice(-2), ["rollback", "release"]);
    pool.done();
  });

  it("persists a disabled draft without consuming queue capacity", async () => {
    const { repository, pool } = fixture([lock(), duplicate(), quota(), revisionCount(), increaseQuota(), insert()]);
    const saved = await repository.enqueue(record({ status: "unavailable", errorCode: "WRITING_FEEDBACK_DISABLED" }), { now });
    assert.equal(saved.status, "unavailable");
    assert.equal(saved.errorCode, "WRITING_FEEDBACK_DISABLED");
    assert.equal(saved.draftText, record().draftText);
    transactionSucceeded(pool);
  });

  for (const [global, owner] of [[8, 0], [1, 2]]) {
    it(`preserves the draft when queue admission is full (${global} global, ${owner} owner)`, async () => {
      const { repository, pool } = fixture([lock(), duplicate(), quota(), revisionCount(), capacity(global, owner), increaseQuota(), insert()]);
      const saved = await repository.enqueue(record(), { now });
      assert.equal(saved.status, "unavailable");
      assert.equal(saved.errorCode, "WRITING_FEEDBACK_QUEUE_FULL");
      transactionSucceeded(pool);
    });
  }

  it("enforces a separate daily quota that draft deletion cannot reset", async () => {
    const { repository, pool } = fixture([lock(), duplicate(), quota(20)]);
    await assert.rejects(repository.enqueue(record(), { now }), { statusCode: 429, code: "WRITING_FEEDBACK_DAILY_LIMIT" });
    pool.done();
    assert.deepEqual(pool.events.slice(-2), ["rollback", "release"]);
  });

  it("checks an owned, unexpired revision parent in the same exercise run under the gate", async () => {
    const parent = step(/WHERE user_id = \? AND id = \? AND exercise_id = \? AND exercise_started_at = \? AND expires_at > \?/u,
      rows([]), (values) => assert.deepEqual(values, ["7", "parent-1", "exercise-1", "2026-09-12 12:00:00.000", "2026-09-12 12:00:00.000"]));
    const { repository, pool } = fixture([lock(), duplicate(), parent]);
    await assert.rejects(repository.enqueue(record({ parentSubmissionId: "parent-1" }), { now }), { statusCode: 404, code: "WRITING_FEEDBACK_PARENT_NOT_FOUND" });
    pool.done();
  });

  it("bounds each writing slide in an exercise run to ten snapshots so history retains the original", async () => {
    const { repository, pool } = fixture([lock(), duplicate(), quota(), revisionCount(10)]);
    await assert.rejects(repository.enqueue(record(), { now }), { statusCode: 429, code: "WRITING_FEEDBACK_REVISION_LIMIT" });
    pool.done();
  });

  it("returns no work while another lease is active, including cancelled jobs", async () => {
    const { repository, pool } = fixture([lock({ ...gate, jobId: "cancelled-1", leaseToken: "old-token", leaseUntil })]);
    assert.equal(await repository.claim({ workerId: "worker-2", leaseToken: "new-token", now, leaseUntil }), null);
    transactionSucceeded(pool);
  });

  it("claims one queued job and advances attempts while holding the global gate", async () => {
    const { repository, pool } = fixture([
      lock(),
      step(/status = 'queued'.*expires_at > \?.*attempt_count < \?/su, rows([record()]), (values, sql) => {
        assert.equal(values[1], 3);
        assert.match(sql, /LIMIT 1 FOR UPDATE/u);
      }),
      step(/SET status = 'running', attempt_count = attempt_count \+ 1/u, changed()),
      step(/UPDATE writing_feedback_gate SET job_id = \?, worker_id = \?, lease_token = \?, lease_until = \?/u, changed()),
    ]);
    const claimed = await repository.claim({ workerId: "worker-1", leaseToken: "token-1", now, leaseUntil, maxAttempts: 99 });
    assert.equal(claimed.status, "running");
    assert.equal(claimed.attemptCount, 1);
    assert.equal(claimed.leaseToken, "token-1");
    transactionSucceeded(pool);
  });

  it("binds a previously disabled draft to the evaluation profile on its first claim only", async () => {
    const profile = record().evaluationProfile;
    const { repository, pool } = fixture([
      lock(), step(/status = 'queued'/u, rows([record({ evaluationProfile: null })])),
      step(/evaluation_profile = COALESCE\(evaluation_profile, \?\)/u, changed(), (values) => assert.ok(values.includes(JSON.stringify(profile)))),
      step(/UPDATE writing_feedback_gate SET job_id/u, changed()),
    ]);
    const claimed = await repository.claim({ workerId: "worker", leaseToken: "token", now, leaseUntil, evaluationProfile: profile });
    assert.deepEqual(claimed.evaluationProfile, profile);
    transactionSucceeded(pool);
  });

  it("fences an expired worker before claiming new work", async () => {
    const { repository, pool } = fixture([
      lock({ ...gate, jobId: "old-job", leaseToken: "old-token", leaseUntil: now }),
      step(/UPDATE writing_feedback_submissions.*status = 'unavailable'.*WHERE id = \? AND status = 'running' AND lease_token = \?/su, changed(), (values) => {
        assert.ok(values.includes("old-job"));
        assert.ok(values.includes("old-token"));
      }),
      step(/UPDATE writing_feedback_gate SET job_id = NULL/u, changed()),
      step(/status = 'queued'/u, rows([])),
    ]);
    assert.equal(await repository.claim({ workerId: "worker-2", leaseToken: "token-2", now, leaseUntil }), null);
    transactionSucceeded(pool);
  });

  it("rejects a stale completion without writing result data", async () => {
    const { repository, pool } = fixture([lock({ ...gate, jobId: "submission-1", leaseToken: "new-token", leaseUntil })]);
    assert.equal(await repository.finish({ id: "submission-1", leaseToken: "old-token", now, status: "completed", result: { feedback: "Unsafe stale result" } }), false);
    transactionSucceeded(pool);
  });

  it("does not publish a result at or beyond the lease deadline", async () => {
    const { repository, pool } = fixture([lock({ ...gate, jobId: "submission-1", leaseToken: "token-1", leaseUntil: now })]);
    assert.equal(await repository.finish({ id: "submission-1", leaseToken: "token-1", now, status: "completed" }), false);
    transactionSucceeded(pool);
  });

  it("commits a result only against the running owner lease, then frees the gate", async () => {
    const { repository, pool } = fixture([
      lock({ ...gate, jobId: "submission-1", leaseToken: "token-1", leaseUntil }),
      step(/WHERE id = \? AND status = 'running' AND lease_token = \? AND lease_until > \? AND expires_at > \?/u, changed()),
      step(/UPDATE writing_feedback_gate SET job_id = NULL/u, changed()),
    ]);
    assert.equal(await repository.finish({ id: "submission-1", leaseToken: "token-1", now, status: "completed", result: { comment: "Review the full stop." }, identity: { model: "reviewed-model" }, metrics: { durationMs: 100 } }), true);
    transactionSucceeded(pool);
  });

  it("cannot restore a cancelled/deleted job when its worker finishes", async () => {
    const { repository, pool } = fixture([
      lock({ ...gate, jobId: "submission-1", leaseToken: "token-1", leaseUntil }),
      step(/WHERE id = \? AND status = 'running' AND lease_token = \?/u, changed(0)),
      step(/UPDATE writing_feedback_gate SET job_id = NULL/u, changed()),
    ]);
    assert.equal(await repository.finish({ id: "submission-1", leaseToken: "token-1", now, status: "unavailable", errorCode: "WRITING_FEEDBACK_PROVIDER_UNAVAILABLE" }), false);
    transactionSucceeded(pool);
  });

  it("owner-scopes reads and bounds exact exercise-run history", async () => {
    const { repository, pool } = fixture([
      step(/WHERE user_id = \? AND id = \? LIMIT 1/u, rows([]), (values) => assert.deepEqual(values, ["other-owner", "submission-1"])),
      step(/WHERE user_id = \? AND exercise_id = \? AND slide_id = \? AND exercise_started_at = \?/u, rows([record()]), (values, sql) => {
        assert.deepEqual(values, ["7", "exercise-1", "writing-1", "2026-09-12 12:00:00.000"]);
        assert.match(sql, /LIMIT 10/u);
      }),
    ]);
    assert.equal(await repository.findOwned("other-owner", "submission-1"), null);
    assert.equal((await repository.listOwned("7", record(), 999)).length, 1);
    pool.done();
  });

  it("rejects a fourth attempt even when a caller raises maxAttempts", async () => {
    const { repository, pool } = fixture([lock(), step(/WHERE user_id = \? AND id = \? LIMIT 1 FOR UPDATE/u, rows([record({ status: "unavailable", attemptCount: 3 })]))]);
    await assert.rejects(repository.retryOwned("7", "submission-1", { now, maxAttempts: 100 }), { statusCode: 409, code: "WRITING_FEEDBACK_ATTEMPTS_EXHAUSTED" });
    pool.done();
  });

  it("retries only immutable unavailable drafts and refuses full queues atomically", async () => {
    const { repository, pool } = fixture([lock(), step(/WHERE user_id = \? AND id = \? LIMIT 1 FOR UPDATE/u, rows([record({ status: "unavailable", attemptCount: 1 })])), capacity(8)]);
    await assert.rejects(repository.retryOwned("7", "submission-1", { now }), { statusCode: 429, code: "WRITING_FEEDBACK_QUEUE_FULL" });
    pool.done();
  });

  it("requeues an unavailable draft without changing snapshot, profile or attempt count", async () => {
    const original = record({ status: "unavailable", attemptCount: 1, errorCode: "WRITING_FEEDBACK_TIMEOUT" });
    const { repository, pool } = fixture([
      lock(), step(/WHERE user_id = \? AND id = \? LIMIT 1 FOR UPDATE/u, rows([original])), capacity(),
      step(/UPDATE writing_feedback_submissions SET status = 'queued'/u, changed(), (_values, sql) => {
        assert.doesNotMatch(sql, /(?:draft_text|notes|task_context|evaluation_profile|attempt_count) =/u);
        assert.match(sql, /WHERE user_id = \? AND id = \? AND status = 'unavailable'/u);
      }),
    ]);
    const retried = await repository.retryOwned("7", original.id, { now });
    for (const key of ["draftText", "notes", "taskContext", "evaluationProfile", "attemptCount"]) assert.deepEqual(retried[key], original[key]);
    assert.equal(retried.status, "queued");
    assert.equal(retried.errorCode, null);
    transactionSucceeded(pool);
  });

  it("cancels a running job without clearing its independent provider lease", async () => {
    const { repository, pool } = fixture([
      lock({ ...gate, jobId: "submission-1", leaseToken: "token-1", leaseUntil }),
      step(/WHERE user_id = \? AND id = \? LIMIT 1 FOR UPDATE/u, rows([record({ status: "running" })])),
      step(/UPDATE writing_feedback_submissions SET status = 'cancelled'/u, changed(), (_values, sql) => assert.match(sql, /WHERE user_id = \? AND id = \?/u)),
    ]);
    const cancelled = await repository.cancelOwned("7", "submission-1", now);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.draftText, record().draftText);
    transactionSucceeded(pool);
  });

  for (const action of ["retryOwned", "cancelOwned"]) {
    it(`returns an opaque owner-scoped 404 for ${action}`, async () => {
      const { repository, pool } = fixture([lock(), step(/WHERE user_id = \? AND id = \? LIMIT 1 FOR UPDATE/u, rows([]), (values) => assert.deepEqual(values, ["wrong-owner", "submission-1"]))]);
      await assert.rejects(repository[action]("wrong-owner", "submission-1", action === "retryOwned" ? { now } : now), { statusCode: 404, code: "WRITING_FEEDBACK_NOT_FOUND" });
      pool.done();
    });
  }

  it("deletes only owned drafts without touching quota or the active worker gate", async () => {
    const { repository, pool } = fixture([lock(), step(/DELETE FROM writing_feedback_submissions WHERE user_id = \? AND id = \?/u, changed(0), (values) => assert.deepEqual(values, ["wrong-owner", "submission-1"]))]);
    assert.equal(await repository.deleteOwned("wrong-owner", "submission-1"), false);
    transactionSucceeded(pool);
  });

  it("rolls back insertion failure and always releases the acquired connection", async () => {
    const failure = new Error("storage unavailable");
    const { repository, pool } = fixture([lock(), duplicate(), quota(), revisionCount(), capacity(), increaseQuota(), step(/INSERT INTO writing_feedback_submissions/u, failure)]);
    await assert.rejects(repository.enqueue(record(), { now }), failure);
    assert.deepEqual(pool.events.slice(-2), ["rollback", "release"]);
    pool.done();
  });

  it("bounds retention batches and preserves the current day's quota", async () => {
    const { repository, pool } = fixture([
      lock(), step(/DELETE FROM writing_feedback_submissions WHERE expires_at <= \? ORDER BY expires_at LIMIT 100/u, changed(3)),
      step(/DELETE FROM writing_feedback_daily_quotas WHERE quota_day < \? ORDER BY quota_day LIMIT 100/u, changed(), (values) => assert.deepEqual(values, ["2026-09-12"])),
    ]);
    assert.equal(await repository.purgeExpired(now, 10000), 3);
    transactionSucceeded(pool);
  });

  it("defines bounded statuses, immutable dedupe and deletion-resistant quotas in migration 024", async () => {
    const sql = await readFile(new URL("../database/migrations/024_writing_feedback.sql", import.meta.url), "utf8");
    assert.match(sql, /UNIQUE KEY writing_feedback_owner_idempotency_unique \(user_id, idempotency_key\)/u);
    assert.match(sql, /CHECK \(attempt_count <= 3\)/u);
    assert.match(sql, /PRIMARY KEY \(user_id, quota_day\)/u);
    assert.match(sql, /INSERT IGNORE INTO writing_feedback_gate \(id\) VALUES \(1\)/u);
    assert.match(sql, /FOREIGN KEY \(user_id\) REFERENCES users \(id\)/u);
    assert.doesNotMatch(sql, /FOREIGN KEY \(job_id\)/u);
  });
});
