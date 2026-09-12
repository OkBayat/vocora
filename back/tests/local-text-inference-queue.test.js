import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MySqlLocalTextInferenceQueue } from "../src/infrastructure/persistence/mysql/local-text-inference/MySqlLocalTextInferenceQueue.js";

const NOW = "2026-09-12T12:00:00.000Z";
const LATER = "2026-09-12T12:02:00.000Z";
const rows = (value) => [value, []];
const changed = [{ affectedRows: 1 }, []];
const session = () => ({ id: "session", userId: "7", pathId: "path", lessonId: "lesson", exerciseId: "exercise", slideId: "slide", exerciseStartedAt: NOW,
  contentVersion: "v1", pathContentVersion: 1, config: { minimumTurns: 2, maximumTurns: 4 }, evaluationProfile: { model: "pinned" },
  state: { status: "active", revision: 3, activeUntil: LATER, currentTurnId: "turn", acceptedTurnCount: 0, completionEvidenceId: null,
    turns: [{ id: "turn", question: "What do you drink?", status: "queued", selectedRecordingId: "recording", recordings: [], attemptCount: 0 }] },
  createdAt: NOW, expiresAt: "2026-10-12T12:00:00.000Z" });
const job = (changes = {}) => ({ id: "recording", userId: "7", sessionId: "session", turnId: "turn", payload: { transcript: "I drink water." },
  evaluationProfile: { model: "pinned" }, status: "running", attemptCount: 1, leaseToken: "token", leaseUntil: LATER,
  createdAt: NOW, updatedAt: NOW, expiresAt: LATER, ...changes });
const loadSession = () => [/FROM conversation_sessions WHERE user_id = \? AND id = \? LIMIT 1 FOR UPDATE/u, rows([session()])];
const loadJob = (value = job()) => [/FROM conversation_inference_jobs WHERE id = \? LIMIT 1 FOR UPDATE/u, rows([value])];
class Pool {
  constructor(steps) { this.steps = [...steps]; this.events = []; }
  async getConnection() { return this; }
  async beginTransaction() { this.events.push("begin"); }
  async commit() { this.events.push("commit"); }
  async rollback() { this.events.push("rollback"); }
  release() { this.events.push("release"); }
  async execute(sql, parameters = []) {
    const [pattern, result, inspect] = this.steps.shift() ?? [];
    assert.ok(pattern, `Unexpected query: ${sql}`); assert.match(sql, pattern); inspect?.(parameters, sql);
    return result;
  }
}
const locked = (extra = {}) => [/FROM writing_feedback_gate WHERE id = 1 FOR UPDATE/u, rows([{ id: 1, jobKind: null, jobId: null, leaseToken: null, leaseUntil: null, ...extra }])];
const fixture = (steps) => { const pool = new Pool(steps); return { pool, queue: new MySqlLocalTextInferenceQueue(pool) }; };

describe("Shared local text inference queue", () => {
  it("rechecks the Writing job and shared gate together without opening a transaction", async () => {
    const { pool, queue } = fixture([[/FROM writing_feedback_submissions j/u, rows([{ id: "draft" }]), (values, sql) => {
      assert.match(sql, /JOIN writing_feedback_gate g ON g\.id = 1/u);
      assert.match(sql, /g\.job_id = j\.id/u); assert.match(sql, /g\.lease_token = j\.lease_token/u);
      assert.match(sql, /COALESCE\(g\.job_kind, 'writing-feedback'\) = \?/u);
      assert.match(sql, /j\.status = 'running'/u); assert.match(sql, /j\.lease_token = \?/u);
      for (const column of ["j.lease_until", "j.expires_at", "g.lease_until"]) assert.ok(sql.includes(`${column} > ?`));
      assert.equal(values[0], "writing-feedback"); assert.ok(values.includes("draft")); assert.ok(values.includes("token"));
      assert.doesNotMatch(sql, /FOR UPDATE/u);
    }]]);
    assert.equal(await queue.isClaimCurrent({ kind: "writing-feedback", id: "draft", leaseToken: "token", now: NOW }), true);
    assert.deepEqual(pool.events, []); assert.equal(pool.steps.length, 0);
  });

  it("treats absent, expired, cancelled or fenced claims as noncurrent", async () => {
    for (const kind of ["writing-feedback", "adaptive-conversation"]) {
      const { pool, queue } = fixture([[/JOIN writing_feedback_gate/u, rows([])]]);
      assert.equal(await queue.isClaimCurrent({ kind, id: "missing", leaseToken: "old", now: NOW }), false);
      assert.deepEqual(pool.events, []); assert.equal(pool.steps.length, 0);
    }
  });

  it("checks the same active conversation and its current selected evaluating turn before inference", async () => {
    const state = session().state; state.turns[0].status = "evaluating";
    const { pool, queue } = fixture([[/FROM conversation_inference_jobs j/u, rows([{ id: "recording", turnId: "turn", state: JSON.stringify(state) }]), (values, sql) => {
      assert.match(sql, /JOIN conversation_sessions s ON s\.id = j\.session_id AND s\.user_id = j\.user_id/u);
      assert.match(sql, /s\.status = 'active'/u); assert.match(sql, /s\.active_until > \?/u); assert.match(sql, /s\.expires_at > \?/u);
      assert.ok(values.includes(NOW)); assert.doesNotMatch(sql, /FOR UPDATE/u);
    }]]);
    assert.equal(await queue.isClaimCurrent({ kind: "adaptive-conversation", id: "recording", leaseToken: "token", now: NOW }), true);
    assert.deepEqual(pool.events, []); assert.equal(pool.steps.length, 0);
  });

  it("rejects replaced selections, advanced turns and non-evaluating turns even with a live job lease", async () => {
    for (const alter of [
      (state) => { state.turns[0].selectedRecordingId = "replacement"; },
      (state) => { state.currentTurnId = "next-turn"; },
      (state) => { state.turns[0].status = "accepted"; },
      (state) => { state.turns = []; },
    ]) {
      const state = session().state; state.turns[0].status = "evaluating"; alter(state);
      const { pool, queue } = fixture([[/FROM conversation_inference_jobs j/u, rows([{ id: "recording", turnId: "turn", state }])]]);
      assert.equal(await queue.isClaimCurrent({ kind: "adaptive-conversation", id: "recording", leaseToken: "token", now: NOW }), false);
      assert.deepEqual(pool.events, []); assert.equal(pool.steps.length, 0);
    }
  });

  it("holds one provider lease across both feature kinds", async () => {
    const { pool, queue } = fixture([locked({ jobKind: "adaptive-conversation", jobId: "conversation-job", leaseToken: "held", leaseUntil: LATER })]);
    assert.equal(await queue.claim({ workerId: "worker", leaseToken: "new", now: NOW, leaseUntil: LATER }), null);
    assert.equal(pool.steps.length, 0);
  });
  it("selects one global FIFO across Writing and conversation", async () => {
    const { pool, queue } = fixture([locked(), [/UNION ALL/su, rows([]), (values, sql) => {
      assert.match(sql, /writing_feedback_submissions/u); assert.match(sql, /conversation_inference_jobs/u);
      assert.match(sql, /ORDER BY created_at, id, kind LIMIT 1/u); assert.ok(values.includes(NOW));
    }]]);
    assert.equal(await queue.claim({ workerId: "worker", leaseToken: "new", now: NOW, leaseUntil: LATER }), null);
    assert.equal(pool.steps.length, 0);
  });
  it("cannot let a writing completion clear a conversation lease with the same id", async () => {
    const { pool, queue } = fixture([locked({ jobKind: "adaptive-conversation", jobId: "same-id", leaseToken: "token", leaseUntil: LATER })]);
    assert.equal(await queue.finish({ kind: "writing-feedback", id: "same-id", leaseToken: "token", now: NOW, status: "completed" }), false);
    assert.equal(pool.steps.length, 0);
  });
  it("clears a deleted conversation job lease without restoring private data", async () => {
    const { pool, queue } = fixture([
      locked({ jobKind: "adaptive-conversation", jobId: "deleted", leaseToken: "token", leaseUntil: LATER }),
      [/FROM conversation_inference_jobs WHERE id = \? LIMIT 1 FOR UPDATE/u, rows([])],
      [/UPDATE writing_feedback_gate SET job_id = NULL/u, changed],
    ]);
    let callbackCalls = 0;
    assert.equal(await queue.finish({ kind: "adaptive-conversation", id: "deleted", leaseToken: "token", now: NOW, status: "completed", applyConversationResult: () => { callbackCalls++; } }), false);
    assert.equal(callbackCalls, 0); assert.equal(pool.steps.length, 0);
  });

  it("claims the selected recording, pins its existing profile and advances only lifecycle state", async () => {
    const { pool, queue } = fixture([
      locked(), [/UNION ALL/su, rows([{ kind: "adaptive-conversation", id: "recording" }])], loadJob(job({ status: "queued", attemptCount: 0, leaseToken: null, leaseUntil: null })), loadSession(),
      [/UPDATE conversation_sessions SET state_json/u, changed, (values) => { const state = JSON.parse(values[0]); assert.equal(state.revision, 4); assert.equal(state.turns[0].status, "evaluating"); assert.equal(state.acceptedTurnCount, 0); }],
      [/UPDATE conversation_inference_jobs SET status = 'running'/u, changed, (values) => assert.ok(values.includes(JSON.stringify({ model: "pinned" })))],
      [/UPDATE writing_feedback_gate SET job_id/u, changed, (values) => assert.equal(values.at(-1), "adaptive-conversation")],
    ]);
    const claimed = await queue.claim({ workerId: "worker", leaseToken: "new", now: NOW, leaseUntil: LATER, evaluationProfiles: { "adaptive-conversation": { model: "changed" } } });
    assert.equal(claimed.attemptCount, 1); assert.equal(claimed.evaluationProfile.model, "pinned"); assert.equal(pool.steps.length, 0);
  });

  it("persists application-approved state and one result inside the lease transaction", async () => {
    const { pool, queue } = fixture([
      locked({ jobKind: "adaptive-conversation", jobId: "recording", leaseToken: "token", leaseUntil: LATER }), loadJob(), loadSession(),
      [/UPDATE conversation_inference_jobs SET status = \?/u, changed],
      [/UPDATE conversation_sessions SET state_json/u, changed, (values) => { const state = JSON.parse(values[0]); assert.equal(state.revision, 4); assert.equal(state.acceptedTurnCount, 1); }],
      [/UPDATE writing_feedback_gate SET job_id = NULL/u, changed],
    ]);
    assert.equal(await queue.finish({ kind: "adaptive-conversation", id: "recording", leaseToken: "token", now: NOW, status: "completed", result: { feedback: "Fixture" },
      applyConversationResult: (current, recording, outcome) => {
        assert.equal(recording.payload.transcript, "I drink water."); assert.equal(outcome.now, NOW);
        return { state: { ...current.state, acceptedTurnCount: 1 } };
      } }), true);
    assert.deepEqual(pool.events, ["begin", "commit", "release"]); assert.equal(pool.steps.length, 0);
  });

  it("discards rejected stale results without writing any session state", async () => {
    const { pool, queue } = fixture([
      locked({ jobKind: "adaptive-conversation", jobId: "recording", leaseToken: "token", leaseUntil: LATER }), loadJob(), loadSession(),
      [/UPDATE conversation_inference_jobs SET status = \?/u, changed, (values) => { assert.equal(values[0], "cancelled"); assert.equal(values[1], null); assert.equal(values[4], "CONVERSATION_STALE_RESULT"); }],
      [/UPDATE writing_feedback_gate SET job_id = NULL/u, changed],
    ]);
    assert.equal(await queue.finish({ kind: "adaptive-conversation", id: "recording", leaseToken: "token", now: NOW, status: "completed", result: { private: "discard me" }, applyConversationResult: () => null }), false);
    assert.equal(pool.steps.length, 0);
  });

  it("rejects asynchronous result handlers before changing job or session data", async () => {
    const { pool, queue } = fixture([locked({ jobKind: "adaptive-conversation", jobId: "recording", leaseToken: "token", leaseUntil: LATER }), loadJob(), loadSession()]);
    await assert.rejects(queue.finish({ kind: "adaptive-conversation", id: "recording", leaseToken: "token", now: NOW, status: "completed", applyConversationResult: async (current) => ({ state: current.state }) }), { code: "CONVERSATION_INVALID_TRANSFORM" });
    assert.deepEqual(pool.events, ["begin", "rollback", "release"]); assert.equal(pool.steps.length, 0);
  });
});
