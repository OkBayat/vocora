import { ConflictError, NotFoundError, ValidationError } from "../../domain/errors.js";
import { parseConversationQuestion } from "../../domain/adaptive-conversation/ConversationDefinition.js";

export const CONVERSATION_ACTIVE_MS = 30 * 60 * 1000;
export const conversationError = (code, message) => new ConflictError(`CONVERSATION_${code}`, message);
export function conversationTurn(id, index, question) {
  return { id, index, question, status: "ready", recordings: [], selectedRecordingId: null, transcript: null, feedback: null, attemptCount: 0, errorCode: null };
}
export function createConversationState(config, turnId, now) {
  return { status: "active", revision: 1, activeUntil: new Date(Date.parse(now) + CONVERSATION_ACTIVE_MS).toISOString(), currentTurnId: turnId, acceptedTurnCount: 0, turns: [conversationTurn(turnId, 1, config.openingPrompt)], completionEvidenceId: null };
}
export function requireConversationActive(session, now) {
  if (session.state.status !== "active" || Date.parse(session.state.activeUntil) <= Date.parse(now)) throw conversationError("SESSION_NOT_ACTIVE", "This conversation is no longer active.");
}
export function requireConversationTurn(session, turnId = session.state.currentTurnId) {
  const turn = session.state.turns.find((candidate) => candidate.id === turnId);
  if (!turn) throw new NotFoundError("CONVERSATION_TURN_NOT_FOUND", "Conversation turn was not found.");
  return turn;
}
export function conversationCanFinish(session, now) {
  const current = requireConversationTurn(session);
  return session.state.status === "active" && Date.parse(session.state.activeUntil) > Date.parse(now)
    && session.state.acceptedTurnCount >= session.config.minimumTurns
    && !["recording", "queued", "evaluating"].includes(current.status);
}
export function conversationReceipt(session, id, now) {
  return { id, userId: session.userId, pathId: session.pathId, lessonId: session.lessonId, exerciseId: session.exerciseId, slideId: session.slideId, exerciseStartedAt: session.exerciseStartedAt, contentVersion: session.contentVersion, acceptedTurnCount: session.state.acceptedTurnCount, minimumTurns: session.config.minimumTurns, completedAt: now, status: "completed" };
}
export function conversationDto(session, now) {
  return {
    id: session.id,
    status: session.state.status === "active" && Date.parse(session.state.activeUntil) <= Date.parse(now) ? "expired" : session.state.status,
    revision: session.state.revision,
    contentVersion: session.contentVersion,
    pathContentVersion: session.pathContentVersion,
    currentTurnId: session.state.currentTurnId,
    minimumTurns: session.config.minimumTurns,
    maximumTurns: session.config.maximumTurns,
    responseSeconds: session.config.responseSeconds,
    acceptedTurnCount: session.state.acceptedTurnCount,
    canFinish: conversationCanFinish(session, now),
    turns: session.state.turns.map((turn) => ({ id: turn.id, index: turn.index, question: turn.question, status: turn.status, recordingId: turn.selectedRecordingId, transcript: turn.transcript, feedback: turn.feedback, attemptCount: turn.attemptCount, errorCode: turn.errorCode })),
    expiresAt: session.state.status === "active" ? session.state.activeUntil : session.expiresAt,
    completionEvidenceId: session.state.completionEvidenceId,
  };
}
export function acceptConversationInference(session, job, outcome, idFactory) {
  const current = requireConversationTurn(session, job.turnId);
  if (session.state.status !== "active" || Date.parse(session.state.activeUntil) <= Date.parse(outcome.now)
    || current.selectedRecordingId !== job.id || current.feedback?.assessmentStatus === "feedback_available"
    || !["queued", "evaluating"].includes(current.status)) return null;
  const state = structuredClone(session.state);
  const turn = state.turns.find((item) => item.id === job.turnId);
  turn.attemptCount = job.attemptCount;
  const recording = turn.recordings.find((item) => item.id === job.id);
  if (outcome.status !== "completed") {
    turn.status = "retryable_failure"; turn.errorCode = outcome.errorCode;
    return { state };
  }
  turn.feedback = outcome.result;
  if (recording) {
    recording.feedback = outcome.result;
    recording.evaluationIdentity = outcome.identity;
    recording.evaluationMetrics = outcome.metrics;
  }
  turn.errorCode = null;
  if (outcome.result.assessmentStatus !== "feedback_available") {
    turn.status = "retryable_failure";
    return { state };
  }
  turn.status = "feedback_available";
  state.acceptedTurnCount++;
  const shouldEnd = state.acceptedTurnCount >= session.config.maximumTurns
    || (state.acceptedTurnCount >= session.config.minimumTurns && outcome.result.endConversation === true);
  if (!shouldEnd) {
    const question = parseConversationQuestion(outcome.result.nextQuestion, session.config.questionConstraints);
    const next = conversationTurn(idFactory(), state.turns.length + 1, question);
    state.turns.push(next); state.currentTurnId = next.id;
  }
  return { state };
}
export function conversationInput(value, allowed, required = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => value[key] === undefined)) {
    throw new ValidationError("CONVERSATION_INVALID_REQUEST", "The conversation request contains unsupported or missing fields.");
  }
  for (const key of ["expectedPathContentVersion", "expectedSessionRevision"]) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 1)) throw new ValidationError("CONVERSATION_INVALID_REQUEST", "Conversation versions must be positive integers.");
  }
  if (value.idempotencyKey !== undefined && (typeof value.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,100}$/u.test(value.idempotencyKey))) throw new ValidationError("CONVERSATION_INVALID_REQUEST", "A stable idempotency key is required.");
  return value;
}
