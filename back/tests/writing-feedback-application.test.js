import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WritingFeedback } from "../src/application/writing-feedback/WritingFeedback.js";
import { writingFeedbackProfileKey } from "../src/application/writing-feedback/writingFeedbackIdentity.js";
import { WritingFeedbackWorker } from "../src/application/writing-feedback/WritingFeedbackWorker.js";

const NOW = "2026-09-12T12:00:00.000Z";
const task = { pathId: "p", lessonId: "l", exerciseId: "e", slideId: "s", exerciseStartedAt: NOW, contentVersion: "version-1", pathContentVersion: 7, taskContext: { prompt: "Describe breakfast.", mode: "paragraph", wordLimit: 40 } };
function harness(overrides = {}) {
  const records = new Map();
  const calls = [];
  const repository = {
    async enqueue(record) { const existing = [...records.values()].find((r) => r.userId === record.userId && r.idempotencyKey === record.idempotencyKey); if (existing) { if (existing.requestHash !== record.requestHash) throw Object.assign(new Error(), { code: "WRITING_FEEDBACK_IDEMPOTENCY_CONFLICT" }); return existing; } records.set(record.id, structuredClone(record)); return record; },
    async findOwned(userId, id) { const row = records.get(id); return row?.userId === userId ? row : null; },
    async listOwned(userId, scope) { calls.push(scope); return [...records.values()].filter((row) => row.userId === userId && row.exerciseStartedAt === scope.exerciseStartedAt); },
    async retryOwned(userId, id) { const row = await this.findOwned(userId, id); if (!row) return null; row.status = "queued"; return row; },
    async cancelOwned(userId, id) { const row = await this.findOwned(userId, id); if (!row) return null; row.status = "cancelled"; return row; },
    async deleteOwned(userId, id) { const row = await this.findOwned(userId, id); if (!row) return false; records.delete(id); return true; },
  };
  let nextId = 0;
  const service = new WritingFeedback({ repository, taskResolver: { execute: async () => structuredClone(task) }, enabled: true, idFactory: () => `submission-${++nextId}`, hashFactory: (value) => value, clock: () => new Date(NOW), ...overrides });
  return { service, records, calls, repository };
}
const submit = (service, input = {}) => service.submit("u1", "p", "l", "e", "s", { draftText: "  I eat bread.\n", idempotencyKey: "request-key-1", expectedPathContentVersion: 7, notes: "plan", ...input });

describe("Writing feedback application", () => {
  it("persists the immutable original and authoritative context without exposing private context", async () => {
    const { service, records } = harness();
    const result = await submit(service);
    assert.equal(result.submission.draftText, "  I eat bread.\n");
    assert.equal(result.submission.notes, "plan");
    assert.equal(result.submission.status, "queued");
    assert.equal(result.submission.feedback, null);
    assert.equal(result.submission.taskContext, undefined);
    assert.equal(records.get(result.submission.id).taskContext.prompt, "Describe breakfast.");
  });
  it("saves while disabled and never queues retries until enabled", async () => {
    const { service } = harness({ enabled: false });
    const saved = await submit(service);
    assert.equal(saved.submission.status, "unavailable");
    assert.equal(saved.submission.errorCode, "WRITING_FEEDBACK_DISABLED");
    assert.equal((await service.retry("u1", saved.submission.id)).submission.status, "unavailable");
  });
  it("preserves an over-pilot draft without sending it for feedback", async () => {
    const { service } = harness();
    const saved = await submit(service, { draftText: "word ".repeat(81) });
    assert.equal(saved.submission.errorCode, "WRITING_FEEDBACK_INPUT_LIMIT");
    assert.equal(saved.submission.draftText.length, 405);
  });
  it("keeps teaching word targets separate from the technical feedback admission limit", async () => {
    const { service } = harness();
    const saved = await submit(service, { draftText: "word ".repeat(41) });
    assert.equal(saved.submission.status, "queued");
  });
  it("rejects rubric injection, oversized notes and blank drafts before persistence", async () => {
    const { service, records } = harness();
    for (const input of [{ rubric: {} }, { notes: "x".repeat(2001) }, { draftText: "  " }]) await assert.rejects(submit(service, input), { code: "INVALID_WRITING_FEEDBACK_REQUEST" });
    assert.equal(records.size, 0);
  });
  it("rejects a stale displayed content version without saving a draft under a changed prompt", async () => {
    const { service, records } = harness();
    await assert.rejects(submit(service, { expectedPathContentVersion: 6 }), { code: "WRITING_FEEDBACK_CONTENT_CHANGED" });
    assert.equal(records.size, 0);
  });
  it("deduplicates requests and rejects different text under the same key", async () => {
    const { service, records } = harness();
    const first = await submit(service);
    assert.equal((await submit(service)).submission.id, first.submission.id);
    assert.equal(records.size, 1);
    await assert.rejects(submit(service, { draftText: "Changed." }), { code: "WRITING_FEEDBACK_IDEMPOTENCY_CONFLICT" });
  });
  it("checks ownership for get, retry, cancel and delete", async () => {
    const { service } = harness();
    const { submission } = await submit(service);
    for (const method of ["get", "retry", "cancel", "delete"]) await assert.rejects(service[method]("u2", submission.id), { code: "WRITING_FEEDBACK_NOT_FOUND" });
  });
  it("binds reload to authoritative current attempt and exposes only bounded availability", async () => {
    const { service, calls } = harness();
    const result = await service.list("u1", "p", "l", "e", "s");
    assert.deepEqual(calls[0], { exerciseId: "e", slideId: "s", exerciseStartedAt: NOW });
    assert.deepEqual(result.availability, { enabled: true, maxWords: 80, maxCharacters: 2000 });
    assert.equal(result.pathContentVersion, 7);
    assert.equal(result.currentContentVersion, "version-1");
  });
  it("hides expired records even before the retention worker purges them", async () => {
    const { service, records } = harness();
    const { submission } = await submit(service);
    records.get(submission.id).expiresAt = "2026-09-11T12:00:00.000Z";
    await assert.rejects(service.get("u1", submission.id), { code: "WRITING_FEEDBACK_NOT_FOUND" });
  });
});

describe("Writing feedback worker", () => {
  function workerHarness(provider, options = {}) {
    const finishes = [];
    let claimed = false;
    const repository = {
      purgeExpired: async () => 0,
      async claim() { if (claimed) return null; claimed = true; return { id: "job-1", draftText: "I eat bread.", taskContext: task.taskContext, contentVersion: "v1", evaluationProfile: options.recordProfile ?? null }; },
      async finish(outcome) { finishes.push(outcome); return true; },
    };
    return { worker: new WritingFeedbackWorker({ repository, provider, enabled: true, clock: () => new Date(NOW), idFactory: () => "lease-1", timeoutMs: 15, cleanupTimeoutMs: 5, ...options }), finishes };
  }
  it("runs one inference despite overlapping ticks and saves only provider-validated output", async () => {
    let resolve;
    let count = 0;
    const { worker, finishes } = workerHarness({ evaluate: () => { count++; return new Promise((r) => { resolve = r; }); } }, { timeoutMs: 1000 });
    const first = worker.runOnce();
    await new Promise((r) => setImmediate(r));
    const second = worker.runOnce();
    resolve({ result: { assessment_status: "feedback_available" }, identity: { model: "pinned" }, metrics: {} });
    await Promise.all([first, second]);
    assert.equal(count, 1);
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0].status, "completed");
    assert.equal(finishes[0].leaseToken, "lease-1");
  });
  it("rejects a changed evaluation profile without calling the model", async () => {
    let calls = 0;
    const { worker, finishes } = workerHarness({ getIdentity: () => ({ model: "new" }), evaluate: async () => { calls++; } }, { recordProfile: { model: "old" } });
    await worker.runOnce();
    assert.equal(calls, 0);
    assert.equal(finishes[0].errorCode, "WRITING_FEEDBACK_PROFILE_CHANGED");
    assert.equal(writingFeedbackProfileKey({ model: "same", options: { a: 1, b: 2 } }), writingFeedbackProfileKey({ options: { b: 2, a: 1 }, model: "same" }));
  });
  it("does not dispatch inference when shutdown starts while a claim is pending", async () => {
    let releaseClaim;
    let calls = 0;
    const finishes = [];
    const worker = new WritingFeedbackWorker({
      repository: { purgeExpired: async () => {}, claim: () => new Promise((resolve) => { releaseClaim = resolve; }), finish: async (outcome) => finishes.push(outcome) },
      provider: { evaluate: async () => { calls++; } }, enabled: true, idFactory: () => "lease-1", clock: () => new Date(NOW),
    });
    const running = worker.runOnce();
    await new Promise((resolve) => setImmediate(resolve));
    const stopping = worker.stop();
    releaseClaim({ id: "job-1" });
    await Promise.all([running, stopping]);
    assert.equal(calls, 0);
    assert.equal(finishes[0].errorCode, "WRITING_FEEDBACK_CANCELLED");
  });
  it("holds the lease through provider abort cleanup and releases only after it settles", async () => {
    let release;
    let signal;
    const { worker, finishes } = workerHarness({ evaluate: (input) => { signal = input.signal; return new Promise((resolve) => { release = resolve; }); } }, { timeoutMs: 1000, cleanupTimeoutMs: 1000 });
    const running = worker.runOnce();
    await new Promise((r) => setImmediate(r));
    worker.cancel("job-1");
    await new Promise((r) => setImmediate(r));
    assert.equal(signal.aborted, true);
    assert.equal(finishes.length, 0);
    release({ result: {}, identity: {}, metrics: {} });
    await running;
    assert.equal(finishes[0].errorCode, "WRITING_FEEDBACK_CANCELLED");
  });
  it("retains the lease and blocks local dispatch when an adapter ignores bounded cancellation", async () => {
    let release;
    let calls = 0;
    const { worker, finishes } = workerHarness({ evaluate: () => { calls++; return new Promise((resolve) => { release = resolve; }); } });
    await worker.runOnce();
    assert.equal(finishes.length, 0);
    await worker.runOnce();
    assert.equal(calls, 1);
    release({ result: {}, identity: {}, metrics: {} });
    await new Promise((r) => setImmediate(r));
    assert.equal(finishes[0].status, "unavailable");
    assert.equal(finishes[0].errorCode, "WRITING_FEEDBACK_TIMEOUT");
    assert.equal(finishes[0].result, null);
  });
  it("never invokes providers while disabled and sanitizes unexpected provider failures", async () => {
    const disabled = workerHarness({ evaluate: () => { throw new Error("must not call"); } }, { enabled: false });
    await disabled.worker.runOnce();
    assert.equal(disabled.finishes[0].errorCode, "WRITING_FEEDBACK_DISABLED");
    const failed = workerHarness({ evaluate: async () => { throw new Error("private learner text"); } });
    await failed.worker.runOnce();
    assert.equal(failed.finishes[0].errorCode, "WRITING_FEEDBACK_UNAVAILABLE");
    assert.equal(JSON.stringify(failed.finishes).includes("private learner text"), false);
  });
  it("aborts cancelled jobs and fences completion through the repository token", async () => {
    let observedSignal;
    const { worker, finishes } = workerHarness({ evaluate: ({ signal }) => { observedSignal = signal; return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); } }, { timeoutMs: 1000 });
    const running = worker.runOnce();
    await new Promise((r) => setImmediate(r));
    worker.cancel("job-1");
    await running;
    assert.equal(observedSignal.aborted, true);
    assert.equal(finishes[0].errorCode, "WRITING_FEEDBACK_CANCELLED");
    assert.equal(finishes[0].leaseToken, "lease-1");
  });
});
