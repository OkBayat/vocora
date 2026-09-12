import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MySqlConversationRepository } from "../src/infrastructure/persistence/mysql/adaptive-conversation/MySqlConversationRepository.js";

const NOW = "2026-09-12T12:00:00.000Z";
const LATER = "2026-09-12T12:30:00.000Z";
const session = (changes = {}) => ({
  id: "session-1", userId: "7", pathId: "path", lessonId: "lesson", exerciseId: "exercise", slideId: "slide",
  exerciseStartedAt: NOW, contentVersion: "v1", pathContentVersion: 2, config: { minimumTurns: 2, maximumTurns: 4 },
  evaluationProfile: null, idempotencyKey: "request-1", requestHash: "a".repeat(64), createdAt: NOW, expiresAt: "2026-10-12T12:00:00.000Z",
  state: { status: "active", revision: 1, activeUntil: LATER, currentTurnId: "turn-1", acceptedTurnCount: 0,
    turns: [{ id: "turn-1", index: 1, question: "What do you drink?", status: "ready", recordings: [], selectedRecordingId: null, transcript: null, feedback: null, attemptCount: 0, errorCode: null }], completionEvidenceId: null }, ...changes,
});
const result = (rows) => [rows, []];
const write = [{ affectedRows: 1 }, []];
const gate = () => [/FROM writing_feedback_gate WHERE id = 1 FOR UPDATE/u, result([{ id: 1, jobKind: null, jobId: null, leaseToken: null, leaseUntil: null }])];
const owned = (value = session()) => [/WHERE user_id = \? AND id = \? LIMIT 1 FOR UPDATE/u, result(value ? [value] : [])];
class Pool {
  constructor(steps) { this.steps = [...steps]; this.events = []; }
  async getConnection() { return this; }
  async beginTransaction() { this.events.push("begin"); }
  async commit() { this.events.push("commit"); }
  async rollback() { this.events.push("rollback"); }
  release() { this.events.push("release"); }
  async execute(sql, values = []) {
    this.events.push({ sql, values });
    const [pattern, answer, inspect] = this.steps.shift() ?? [];
    assert.ok(pattern, `Unexpected query: ${sql}`);
    assert.match(sql, pattern);
    inspect?.(values, sql);
    return answer;
  }
  done() { assert.equal(this.steps.length, 0); }
}
const fixture = (steps) => { const pool = new Pool(steps); return { pool, repository: new MySqlConversationRepository(pool) }; };

describe("Conversation session persistence", () => {
  it("deduplicates an owned session before quota or active-session admission", async () => {
    const { repository, pool } = fixture([gate(), [/idempotency_key = \?/u, result([session()])]]);
    assert.equal((await repository.create(session({ id: "ignored" }), { now: NOW })).id, "session-1");
    pool.done();
  });
  it("rejects expired duplicate sessions before checking their request hash", async () => {
    const { repository, pool } = fixture([gate(), [/idempotency_key = \?/u, result([session({ expiresAt: NOW, requestHash: "b".repeat(64) })])]]);
    await assert.rejects(repository.create(session(), { now: NOW }), { statusCode: 404, code: "CONVERSATION_NOT_FOUND" });
    pool.done();
  });
  it("resumes the same active owned task without inserting or charging another session", async () => {
    const { repository, pool } = fixture([gate(), [/idempotency_key = \?/u, result([])], [/status = 'active'/u, result([session()])]]);
    assert.equal((await repository.create(session({ id: "ignored", idempotencyKey: "another" }), { now: NOW })).id, "session-1");
    pool.done();
  });
  it("rejects a conflicting active task", async () => {
    const { repository, pool } = fixture([gate(), [/idempotency_key = \?/u, result([])], [/status = 'active'/u, result([session()])]]);
    await assert.rejects(repository.create(session({ slideId: "other-slide" }), { now: NOW }), { statusCode: 409, code: "CONVERSATION_ACTIVE_SESSION" });
    pool.done();
  });

  it("saves a first immutable session and charges daily quota under the gate", async () => {
    const { repository, pool } = fixture([gate(), [/idempotency_key = \?/u, result([])], [/status = 'active'/u, result([])],
      [/COUNT\(\*\) AS activeCount/u, result([{ activeCount: 0 }])], [/FROM conversation_daily_quotas/u, result([])],
      [/INSERT INTO conversation_daily_quotas/u, write], [/INSERT INTO conversation_sessions/u, write, (values) => { assert.ok(values.includes("2026-09-12 12:00:00.000")); assert.ok(values.includes(JSON.stringify(session().config))); }],
    ]);
    assert.equal((await repository.create(session(), { now: NOW })).state.revision, 1); pool.done();
  });

  it("enforces the global active-session bound before charging quota", async () => {
    const { repository, pool } = fixture([gate(), [/idempotency_key = \?/u, result([])], [/status = 'active'/u, result([])], [/COUNT\(\*\) AS activeCount/u, result([{ activeCount: 16 }])]]);
    await assert.rejects(repository.create(session(), { now: NOW }), { statusCode: 429, code: "CONVERSATION_SESSION_LIMIT" }); pool.done();
  });

  it("keeps the five-session daily quota independent of private deletion", async () => {
    const { repository, pool } = fixture([gate(), [/idempotency_key = \?/u, result([])], [/status = 'active'/u, result([])], [/COUNT\(\*\) AS activeCount/u, result([{ activeCount: 0 }])], [/FROM conversation_daily_quotas/u, result([{ sessionCount: 5 }])]]);
    await assert.rejects(repository.create(session(), { now: NOW }), { statusCode: 429, code: "CONVERSATION_DAILY_LIMIT" }); pool.done();
  });
  it("rejects stale mutations before invoking application logic", async () => {
    let calls = 0;
    const { repository, pool } = fixture([gate(), owned()]);
    await assert.rejects(repository.mutateOwned("7", "session-1", 0, () => { calls++; }, { now: NOW }), { statusCode: 409, code: "CONVERSATION_REVISION_CONFLICT" });
    assert.equal(calls, 0);
    pool.done();
  });
  it("rejects asynchronous callbacks without opening a provider transaction", async () => {
    const { repository, pool } = fixture([gate(), owned()]);
    await assert.rejects(repository.mutateOwned("7", "session-1", 1, async (current) => ({ state: current.state }), { now: NOW }), { code: "CONVERSATION_INVALID_TRANSFORM" });
    pool.done();
  });
  it("updates only state and increments its persisted revision", async () => {
    const { repository, pool } = fixture([gate(), owned(), [/UPDATE conversation_sessions SET state_json = \?/u, write, (values, sql) => {
      assert.equal(JSON.parse(values[0]).revision, 2);
      assert.doesNotMatch(sql, /(?:config_json|content_version|evaluation_profile|request_hash) =/u);
    }]]);
    const updated = await repository.mutateOwned("7", "session-1", 1, (current) => ({ state: current.state }), { now: NOW });
    assert.equal(updated.state.revision, 2);
    pool.done();
  });
  it("saves a retryable job and transcript when shared Writing/conversation capacity is full", async () => {
    const { repository, pool } = fixture([gate(), owned(),
      [/COUNT\(\*\) AS activeCount/u, result([{ activeCount: 8, ownerCount: 0 }]), (_values, sql) => assert.match(sql, /UNION ALL/u)],
      [/INSERT INTO conversation_inference_jobs/u, write, (values) => { assert.ok(values.includes("unavailable")); assert.ok(values.includes("CONVERSATION_QUEUE_FULL")); }],
      [/UPDATE conversation_sessions SET state_json/u, write],
    ]);
    const saved = await repository.mutateOwned("7", "session-1", 1, (current) => {
      current.state.turns[0].selectedRecordingId = "recording-1";
      current.state.turns[0].transcript = { text: "I drink water." };
      return { state: current.state, job: { id: "recording-1", userId: "7", sessionId: "session-1", turnId: "turn-1", payload: { transcript: "I drink water." } } };
    }, { now: NOW });
    assert.equal(saved.state.turns[0].status, "retryable_failure");
    assert.deepEqual(saved.state.turns[0].transcript, { text: "I drink water." });
    pool.done();
  });
  it("bounds the private aggregate to two MiB before any state write", async () => {
    const { repository, pool } = fixture([gate(), owned()]);
    await assert.rejects(repository.mutateOwned("7", "session-1", 1, (current) => ({ state: { ...current.state, oversized: "x".repeat(2 * 1024 * 1024) } }), { now: NOW }), { code: "CONVERSATION_STATE_LIMIT" });
    pool.done();
  });

  it("keeps every recording job pinned to the immutable session evaluation profile", async () => {
    const { repository, pool } = fixture([gate(), owned(session({ evaluationProfile: { model: "original" } })),
      [/COUNT\(\*\) AS activeCount/u, result([{ activeCount: 0, ownerCount: 0 }])],
      [/INSERT INTO conversation_inference_jobs/u, write, (values) => { assert.ok(values.includes(JSON.stringify({ model: "original" }))); assert.equal(values.includes(JSON.stringify({ model: "changed" })), false); }],
      [/UPDATE conversation_sessions SET state_json/u, write],
    ]);
    await repository.mutateOwned("7", "session-1", 1, (current) => {
      current.state.turns[0].selectedRecordingId = "recording-1";
      return { state: current.state, job: { id: "recording-1", userId: "7", sessionId: "session-1", turnId: "turn-1", payload: { transcript: "I drink water." }, evaluationProfile: { model: "changed" } } };
    }, { now: NOW }); pool.done();
  });
  it("owner-scopes deletion and preserves independent completion evidence", async () => {
    const { repository, pool } = fixture([gate(), [/DELETE FROM conversation_sessions WHERE user_id = \? AND id = \?/u, write, (values) => assert.deepEqual(values, ["7", "session-1"])]]);
    assert.equal(await repository.deleteOwned("7", "session-1"), true);
    pool.done();
  });
  it("cannot mutate another owner's session", async () => {
    const { repository, pool } = fixture([gate(), owned(null)]);
    await assert.rejects(repository.mutateOwned("8", "session-1", null, () => { throw new Error("must not invoke"); }, { now: NOW }), { code: "CONVERSATION_NOT_FOUND" });
    pool.done();
  });

  it("rejects a completion receipt that does not match the immutable owner scope", async () => {
    const { repository, pool } = fixture([gate(), owned()]);
    await assert.rejects(repository.mutateOwned("7", "session-1", 1, (current) => ({
      state: { ...current.state, status: "completed", acceptedTurnCount: 2, completionEvidenceId: "receipt" },
      completion: { id: "receipt", userId: "8", pathId: "path", lessonId: "lesson", exerciseId: "exercise", slideId: "slide", exerciseStartedAt: NOW, contentVersion: "v1", acceptedTurnCount: 2, minimumTurns: 2, completedAt: NOW, status: "completed" },
    }), { now: NOW }), { code: "CONVERSATION_INVALID_COMPLETION" }); pool.done();
  });

  it("writes minimal completion evidence and session completion atomically", async () => {
    const { repository, pool } = fixture([gate(), owned(), [/INSERT INTO conversation_completion_evidence/u, write, (values) => assert.equal(values.includes("What do you drink?"), false)], [/UPDATE conversation_sessions SET state_json/u, write]]);
    const current = await repository.mutateOwned("7", "session-1", 1, (value) => ({
      state: { ...value.state, status: "completed", acceptedTurnCount: 2, completionEvidenceId: "receipt" },
      completion: { id: "receipt", userId: "7", pathId: "path", lessonId: "lesson", exerciseId: "exercise", slideId: "slide", exerciseStartedAt: NOW, contentVersion: "v1", acceptedTurnCount: 2, minimumTurns: 2, completedAt: NOW, status: "completed" },
    }), { now: NOW });
    assert.equal(current.state.completionEvidenceId, "receipt"); assert.deepEqual(pool.events.slice(-2), ["commit", "release"]); pool.done();
  });

  it("reads larger valid completion sets in bounded owner-scoped batches", async () => {
    const ids = Array.from({ length: 65 }, (_, index) => `receipt-${index}`);
    const { repository, pool } = fixture([
      [/FROM conversation_completion_evidence\s+WHERE user_id = \? AND id IN/u, result([]), (values) => { assert.equal(values[0], "7"); assert.equal(values.length, 65); }],
      [/FROM conversation_completion_evidence\s+WHERE user_id = \? AND id IN/u, result([]), (values) => assert.deepEqual(values, ["7", "receipt-64"])],
    ]);
    assert.deepEqual(await repository.findCompletionEvidence("7", ids), []); pool.done();
  });
});
