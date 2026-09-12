import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { loadConfig } from "../../src/config/loadConfig.js";
import { createPool } from "../../src/infrastructure/persistence/mysql/createPool.js";
import { MySqlConversationRepository } from "../../src/infrastructure/persistence/mysql/adaptive-conversation/MySqlConversationRepository.js";
import { MySqlWritingFeedbackRepository } from "../../src/infrastructure/persistence/mysql/writing-feedback/MySqlWritingFeedbackRepository.js";
import { MySqlLocalTextInferenceQueue } from "../../src/infrastructure/persistence/mysql/local-text-inference/MySqlLocalTextInferenceQueue.js";

const NOW = "2026-09-12T12:00:00.000Z";
const NEXT = "2026-09-12T12:00:01.000Z";
const LATER = "2026-09-12T12:30:00.000Z";
const END = "2026-09-12T12:31:00.000Z";
const RETENTION = "2026-10-12T12:00:00.000Z";
const PROFILE = { model: "fixture", policyVersion: "v1" };

test("Adaptive conversation persistence and shared scheduler execute against isolated MySQL", {
  skip: process.env.LEARNING_PATH_MYSQL_INTEGRATION !== "1",
}, async (t) => {
  assert.match(process.env.DB_NAME || "", /_ci$/u, "Never run conversation fixtures against a production database.");
  const pool = createPool(loadConfig(process.env).database);
  const sessions = new MySqlConversationRepository(pool);
  const writing = new MySqlWritingFeedbackRepository(pool);
  const queue = new MySqlLocalTextInferenceQueue(pool);
  const otherWorker = new MySqlLocalTextInferenceQueue(pool);
  const userIds = [];
  const workerId = `conversation-ci-${randomUUID()}`;
  t.after(async () => {
    try {
      await pool.execute("UPDATE writing_feedback_gate SET job_id = NULL, job_kind = NULL, worker_id = NULL, lease_token = NULL, lease_until = NULL WHERE worker_id = ?", [workerId]);
      for (const userId of userIds) await pool.execute("DELETE FROM users WHERE id = ?", [userId]);
    } finally { await pool.end(); }
  });
  async function owner() {
    const [inserted] = await pool.execute("INSERT INTO users (email, password_hash) VALUES (?, 'integration-only')", [`conversation-${randomUUID()}@example.test`]);
    const id = String(inserted.insertId); userIds.push(id); return id;
  }
  function record(userId, changes = {}) {
    const turnId = randomUUID();
    return { id: randomUUID(), userId, pathId: "conversation-path", lessonId: "conversation-lesson", exerciseId: "conversation-exercise", slideId: "conversation-slide",
      exerciseStartedAt: NOW, contentVersion: "content-v1", pathContentVersion: 1, config: { minimumTurns: 2, maximumTurns: 4, openingPrompt: "What do you drink?" },
      evaluationProfile: PROFILE, idempotencyKey: randomUUID(), requestHash: "a".repeat(64), createdAt: NOW, expiresAt: RETENTION,
      state: { status: "active", revision: 1, activeUntil: LATER, currentTurnId: turnId, acceptedTurnCount: 0, completionEvidenceId: null,
        turns: [{ id: turnId, index: 1, question: "What do you drink?", status: "ready", recordings: [], selectedRecordingId: null, transcript: null, feedback: null, attemptCount: 0, errorCode: null }] }, ...changes };
  }
  async function writingDraft(userId, changes = {}) {
    return writing.enqueue({ id: randomUUID(), userId, requestHash: "a".repeat(64), idempotencyKey: randomUUID(), parentSubmissionId: null,
      pathId: "writing-path", lessonId: "writing-lesson", exerciseId: "writing-exercise", slideId: "writing-slide", exerciseStartedAt: NOW,
      draftText: "I drink water.", notes: "", taskContext: { prompt: "Describe breakfast." }, evaluationProfile: PROFILE, contentVersion: "writing-v1",
      status: "queued", createdAt: NOW, updatedAt: NOW, expiresAt: RETENTION, ...changes }, { now: NOW });
  }
  async function enqueueTurn(session, createdAt = NOW) {
    const recordingId = randomUUID();
    return sessions.mutateOwned(session.userId, session.id, session.state.revision, (current) => {
      const state = current.state; const turn = state.turns.find((item) => item.id === state.currentTurnId);
      turn.selectedRecordingId = recordingId; turn.transcript = { status: "transcribed", text: "I drink water." };
      turn.recordings.push({ id: recordingId, transcript: turn.transcript }); turn.status = "queued";
      return { state, job: { id: recordingId, userId: session.userId, sessionId: session.id, turnId: turn.id,
        payload: { sessionVersion: session.id, turnVersion: turn.id, contentVersion: session.contentVersion, transcript: turn.transcript },
        evaluationProfile: null, createdAt, expiresAt: LATER } };
    }, { now: NOW });
  }
  async function claim(now = NOW, leaseUntil = LATER, target = queue) {
    return target.claim({ workerId, leaseToken: randomUUID(), now, leaseUntil,
      evaluationProfiles: { "writing-feedback": PROFILE, "adaptive-conversation": PROFILE } });
  }
  const failureState = (session, job, outcome) => {
    const state = session.state; const turn = state.turns.find((item) => item.id === job.turnId);
    turn.status = "retryable_failure"; turn.errorCode = outcome.errorCode; turn.attemptCount = job.attemptCount;
    return { state };
  };
  async function finish(job, options = {}) {
    return queue.finish({ kind: job.kind, id: job.id, leaseToken: job.leaseToken, now: NOW, status: "unavailable", result: null,
      errorCode: "CONVERSATION_PROVIDER_UNAVAILABLE", applyConversationResult: failureState, ...options });
  }

  await t.test("migration 025 preserves one gate and deduplicates concurrent session creation", async () => {
    const [[migration]] = await pool.execute("SELECT version FROM schema_migrations WHERE version = '025_adaptive_conversation.sql'");
    assert.equal(migration.version, "025_adaptive_conversation.sql");
    const userId = await owner(); const source = record(userId);
    const [first, duplicate] = await Promise.all([sessions.create(source, { now: NOW }), sessions.create({ ...source, id: randomUUID() }, { now: NOW })]);
    assert.equal(first.id, duplicate.id);
    const resumed = await sessions.create(record(userId), { now: NOW });
    assert.equal(resumed.id, first.id);
    const [[stored]] = await pool.execute("SELECT status, active_until, state_json FROM conversation_sessions WHERE id = ?", [first.id]);
    assert.equal(stored.status, "active"); assert.equal(stored.active_until, LATER);
    const [[quota]] = await pool.execute("SELECT session_count FROM conversation_daily_quotas WHERE user_id = ?", [userId]);
    assert.equal(Number(quota.session_count), 1);
    await assert.rejects(sessions.create({ ...source, requestHash: "b".repeat(64) }, { now: NOW }), { code: "CONVERSATION_IDEMPOTENCY_CONFLICT" });
    await sessions.deleteOwned(userId, first.id);
  });

  await t.test("global active-session admission is atomic and daily quota survives deletion", async () => {
    const owners = await Promise.all(Array.from({ length: 17 }, () => owner()));
    const attempts = await Promise.allSettled(owners.map((id) => sessions.create(record(id), { now: NOW })));
    assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 16);
    assert.equal(attempts.find((item) => item.status === "rejected").reason.code, "CONVERSATION_SESSION_LIMIT");
    for (const item of attempts) if (item.status === "fulfilled") await sessions.deleteOwned(item.value.userId, item.value.id);
    const userId = await owner();
    for (let index = 0; index < 5; index++) { const current = await sessions.create(record(userId), { now: NOW }); await sessions.deleteOwned(userId, current.id); }
    await assert.rejects(sessions.create(record(userId), { now: NOW }), { code: "CONVERSATION_DAILY_LIMIT" });
  });

  await t.test("both families share eight pending slots and full queues preserve transcripts", async () => {
    const writingUsers = await Promise.all(Array.from({ length: 3 }, () => owner()));
    const drafts = await Promise.all(writingUsers.flatMap((id) => [writingDraft(id), writingDraft(id)]));
    const conversationUsers = await Promise.all(Array.from({ length: 3 }, () => owner()));
    const created = await Promise.all(conversationUsers.map((id) => sessions.create(record(id), { now: NOW })));
    const conversations = await Promise.all(created.map((current) => enqueueTurn(current)));
    assert.equal(conversations.filter((item) => item.state.turns[0].status === "queued").length, 2);
    const refused = conversations.find((item) => item.state.turns[0].errorCode === "CONVERSATION_QUEUE_FULL");
    assert.equal(refused.state.turns[0].transcript.text, "I drink water.");
    const lastWriting = await writingDraft(await owner());
    assert.equal(lastWriting.errorCode, "WRITING_FEEDBACK_QUEUE_FULL");
    const [[total]] = await pool.execute("SELECT (SELECT COUNT(*) FROM writing_feedback_submissions WHERE status IN ('queued','running')) + (SELECT COUNT(*) FROM conversation_inference_jobs WHERE status IN ('queued','running')) AS total");
    assert.equal(Number(total.total), 8);
    for (const draft of drafts) await writing.cancelOwned(draft.userId, draft.id, NOW);
    for (const current of conversations) await sessions.deleteOwned(current.userId, current.id);
  });

  await t.test("owner capacity spans Writing and conversation, then FIFO and cross-worker lease serialize evaluation", async () => {
    const userId = await owner();
    const a = await writingDraft(userId); const b = await writingDraft(userId);
    let current = await enqueueTurn(await sessions.create(record(userId), { now: NOW }), NEXT);
    assert.equal(current.state.turns[0].errorCode, "CONVERSATION_QUEUE_FULL");
    await writing.cancelOwned(userId, b.id, NOW);
    current = await sessions.retryJobOwned(userId, current.id, current.state.currentTurnId, { now: NOW });
    const claims = await Promise.all([claim(), claim(NOW, LATER, otherWorker)]);
    assert.equal(claims.filter(Boolean).length, 1);
    const active = claims.find(Boolean); assert.equal(active.id, a.id); assert.equal(active.kind, "writing-feedback");
    assert.equal(await queue.isClaimCurrent({ ...active, now: NOW }), true);
    assert.equal(await queue.isClaimCurrent({ ...active, leaseToken: "stale-token", now: NOW }), false);
    assert.equal(await queue.isClaimCurrent({ ...active, kind: "adaptive-conversation", now: NOW }), false);
    assert.equal(await queue.isClaimCurrent({ ...active, now: LATER }), false);
    await finish(active, { status: "completed", result: { comment: "Fixture feedback." }, errorCode: null });
    assert.equal(await queue.isClaimCurrent({ ...active, now: NOW }), false);
    const conversation = await claim(); assert.equal(conversation.kind, "adaptive-conversation");
    assert.equal(conversation.id, current.state.turns[0].selectedRecordingId);
    assert.deepEqual(conversation.evaluationProfile, PROFILE);
    assert.equal((await sessions.findOwned(userId, current.id)).state.turns[0].status, "evaluating");
    assert.equal(await queue.isClaimCurrent({ ...conversation, now: NOW }), true);
    await sessions.mutateOwned(userId, current.id, null, (row) => {
      row.state.turns[0].selectedRecordingId = randomUUID(); return { state: row.state };
    }, { now: NOW });
    assert.equal(await queue.isClaimCurrent({ ...conversation, now: NOW }), false);
    await sessions.mutateOwned(userId, current.id, null, (row) => {
      row.state.turns[0].selectedRecordingId = conversation.id; return { state: row.state };
    }, { now: NOW });
    assert.equal(await queue.isClaimCurrent({ ...conversation, now: NOW }), true);
    await sessions.cancelOwned(userId, current.id, { now: NOW });
    assert.equal(await queue.isClaimCurrent({ ...conversation, now: NOW }), false);
    assert.equal(await claim(), null);
    assert.equal(await finish(conversation), false);
    await sessions.deleteOwned(userId, current.id);
  });

  await t.test("lease expiry fences the old kind, preserves payload and caps retries at three", async () => {
    const userId = await owner();
    let current = await enqueueTurn(await sessions.create(record(userId), { now: NOW }));
    const first = await claim(NOW, NEXT);
    const other = await writingDraft(await owner(), { createdAt: NEXT });
    const replacement = await claim(NEXT, LATER);
    assert.equal(replacement.id, other.id);
    assert.equal(await queue.isClaimCurrent({ ...first, now: NEXT }), false);
    assert.equal(await queue.isClaimCurrent({ ...replacement, now: NEXT }), true);
    let staleCallbacks = 0;
    assert.equal(await finish(first, { now: NEXT, applyConversationResult: () => { staleCallbacks++; } }), false);
    assert.equal(staleCallbacks, 0);
    await finish(replacement, { now: NEXT });
    current = await sessions.findOwned(userId, current.id);
    assert.equal(current.state.turns[0].errorCode, "CONVERSATION_INTERRUPTED");
    for (const attempt of [2, 3]) {
      await sessions.retryJobOwned(userId, current.id, current.state.currentTurnId, { now: NEXT });
      const retried = await claim(NEXT, LATER); assert.equal(retried.attemptCount, attempt); assert.deepEqual(retried.payload, first.payload);
      await finish(retried, { now: NEXT });
    }
    await assert.rejects(sessions.retryJobOwned(userId, current.id, current.state.currentTurnId, { now: NEXT }), { code: "CONVERSATION_ATTEMPTS_EXHAUSTED" });
    await sessions.deleteOwned(userId, current.id);
  });

  await t.test("revision CAS, synchronous callbacks and owner predicates protect private session state", async () => {
    const userId = await owner(); const stranger = await owner();
    const current = await sessions.create(record(userId), { now: NOW });
    assert.equal(await sessions.findOwned(stranger, current.id), null);
    assert.deepEqual(await sessions.listOwned(stranger, current), []);
    await assert.rejects(sessions.mutateOwned(stranger, current.id, null, () => { throw new Error("must not run"); }, { now: NOW }), { code: "CONVERSATION_NOT_FOUND" });
    assert.equal(await sessions.deleteOwned(stranger, current.id), false);
    const mutations = await Promise.allSettled([1, 2].map(() => sessions.mutateOwned(userId, current.id, 1, (row) => ({ state: row.state }), { now: NOW })));
    assert.equal(mutations.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(mutations.find((item) => item.status === "rejected").reason.code, "CONVERSATION_REVISION_CONFLICT");
    await assert.rejects(sessions.mutateOwned(userId, current.id, null, async (row) => ({ state: row.state }), { now: NOW }), { code: "CONVERSATION_INVALID_TRANSFORM" });
    assert.equal((await sessions.findOwned(userId, current.id)).state.revision, 2);
    await sessions.deleteOwned(userId, current.id);
  });

  await t.test("minimal completed evidence survives private deletion and remains owner-scoped", async () => {
    const userId = await owner(); const stranger = await owner();
    const current = await sessions.create(record(userId), { now: NOW }); const evidenceId = randomUUID();
    const completed = await sessions.mutateOwned(userId, current.id, 1, (row) => ({
      state: { ...row.state, status: "completed", acceptedTurnCount: 2, completionEvidenceId: evidenceId },
      completion: { id: evidenceId, userId, pathId: row.pathId, lessonId: row.lessonId, exerciseId: row.exerciseId, slideId: row.slideId,
        exerciseStartedAt: row.exerciseStartedAt, contentVersion: row.contentVersion, acceptedTurnCount: 2, minimumTurns: 2, completedAt: NOW, status: "completed" },
    }), { now: NOW });
    assert.equal(completed.state.status, "completed");
    await sessions.deleteOwned(userId, current.id);
    const [receipt] = await sessions.findCompletionEvidence(userId, [evidenceId]);
    assert.equal(receipt.acceptedTurnCount, 2); assert.equal(receipt.status, "completed");
    assert.equal(receipt.transcript, undefined); assert.equal(receipt.state, undefined); assert.equal(receipt.config, undefined);
    assert.deepEqual(await sessions.findCompletionEvidence(stranger, [evidenceId]), []);
  });

  await t.test("retention deletion cannot release an active provider lease early", async () => {
    const userId = await owner();
    const current = await enqueueTurn(await sessions.create(record(userId, { expiresAt: LATER }), { now: NOW }));
    const active = await claim(NOW, END);
    assert.equal(await queue.isClaimCurrent({ ...active, now: NOW }), true);
    await queue.purgeExpired(LATER, 100);
    assert.equal(await sessions.findOwned(userId, current.id), null);
    assert.equal(await queue.isClaimCurrent({ ...active, now: LATER }), false);
    assert.equal(await claim(LATER, END), null);
    assert.equal(await finish(active, { now: LATER }), false);
    assert.equal(await claim(LATER, END), null);
  });
});
