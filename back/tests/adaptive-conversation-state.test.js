import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acceptConversationInference, conversationCanFinish, createConversationState } from "../src/application/adaptive-conversation/conversationState.js";

const NOW = "2026-09-12T12:00:00.000Z";
const config = { minimumTurns: 2, maximumTurns: 3, openingPrompt: "What do you eat?", questionConstraints: { maximumWords: 14, oneQuestionOnly: true, avoidAnswerDisclosure: true } };
function fixture() {
  const session = { id: "session-1", userId: "1", pathId: "p", lessonId: "l", exerciseId: "e", slideId: "s", exerciseStartedAt: NOW, contentVersion: "v", config, state: createConversationState(config, "turn-1", NOW) };
  const turn = session.state.turns[0];
  turn.status = "evaluating"; turn.selectedRecordingId = "recording-1"; turn.recordings = [{ id: "recording-1" }];
  turn.transcript = { schemaVersion: 1, status: "transcribed", text: "Rice.", confidence: null };
  return { session, job: { id: "recording-1", turnId: "turn-1", attemptCount: 1 } };
}
const result = { schemaVersion: 1, assessmentStatus: "feedback_available", taskResponse: "off_topic", formativeTaskScore: 0, feedback: "Try to answer the question.", nextQuestion: "What do you drink?", endConversation: false, notAssessed: ["ielts_band", "pronunciation", "fluency"] };

describe("Conversation practice state", () => {
  it("accepts practice evidence without treating model correctness as a completion grade", () => {
    const { session, job } = fixture();
    const outcome = acceptConversationInference(session, job, { status: "completed", result, identity: { templateSha256: "pinned-template" }, metrics: { eval_count: 42 }, now: NOW }, () => "turn-2");
    assert.equal(outcome.state.acceptedTurnCount, 1);
    assert.deepEqual(outcome.state.turns[0].recordings[0].evaluationIdentity, { templateSha256: "pinned-template" });
    assert.deepEqual(outcome.state.turns[0].recordings[0].evaluationMetrics, { eval_count: 42 });
    assert.equal(outcome.state.turns[0].feedback.formativeTaskScore, 0);
    assert.equal(outcome.state.currentTurnId, "turn-2");
    assert.equal(conversationCanFinish({ ...session, state: outcome.state }, NOW), false);
    assert.equal(session.state.acceptedTurnCount, 0);
  });
  it("does not increment for model abstention or provider failure and preserves the transcript", () => {
    for (const outcome of [{ status: "unavailable", errorCode: "CONVERSATION_TIMEOUT" }, { status: "completed", result: { ...result, assessmentStatus: "insufficient_evidence", taskResponse: "not_assessed", formativeTaskScore: null } }]) {
      const { session, job } = fixture();
      const next = acceptConversationInference(session, job, { ...outcome, now: NOW }, () => "unused");
      assert.equal(next.state.acceptedTurnCount, 0);
      assert.equal(next.state.turns[0].status, "retryable_failure");
      assert.equal(next.state.turns[0].transcript.text, "Rice.");
    }
  });
  it("fences cancelled/replaced turns and already accepted results", () => {
    const { session, job } = fixture();
    for (const mutate of [(s) => { s.state.status = "cancelled"; }, (s) => { s.state.turns[0].selectedRecordingId = "new-recording"; }, (s) => { s.state.turns[0].status = "feedback_available"; s.state.turns[0].feedback = result; }]) {
      const current = structuredClone(session); mutate(current);
      assert.equal(acceptConversationInference(current, job, { status: "completed", result, now: NOW }, () => "unused"), null);
    }
  });
  it("cannot end before the minimum, ends at the maximum, and allows explicit finish after the minimum", () => {
    const { session, job } = fixture();
    const first = acceptConversationInference(session, job, { status: "completed", result: { ...result, endConversation: true }, now: NOW }, () => "turn-2");
    assert.equal(first.state.currentTurnId, "turn-2");
    session.state = first.state;
    session.state.acceptedTurnCount = 2;
    const current = session.state.turns[1]; current.status = "evaluating"; current.selectedRecordingId = "recording-2";
    const last = acceptConversationInference(session, { id: "recording-2", turnId: "turn-2", attemptCount: 1 }, { status: "completed", result, now: NOW }, () => "must-not-exist");
    assert.equal(last.state.acceptedTurnCount, 3);
    assert.equal(last.state.turns.length, 2);
    assert.equal(conversationCanFinish({ ...session, state: last.state }, NOW), true);
  });
});
