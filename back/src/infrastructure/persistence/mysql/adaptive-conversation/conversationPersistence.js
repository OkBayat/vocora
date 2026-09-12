import { ConflictError, NotFoundError, ValidationError } from "../../../../domain/errors.js";
import { dateColumn, iso, json, parseJson, sqlTime } from "../local-text-inference/LocalTextInferencePersistence.js";

export const conversationColumns = `id, user_id AS userId, path_id AS pathId, lesson_id AS lessonId,
  exercise_id AS exerciseId, slide_id AS slideId, ${dateColumn("exercise_started_at", "exerciseStartedAt")},
  content_version AS contentVersion, path_content_version AS pathContentVersion, config_json AS config,
  evaluation_profile AS evaluationProfile, idempotency_key AS idempotencyKey, request_hash AS requestHash,
  state_json AS state, ${dateColumn("created_at", "createdAt")}, ${dateColumn("expires_at", "expiresAt")}`;
export const conversationJobColumns = `id, session_id AS sessionId, turn_id AS turnId, user_id AS userId,
  payload_json AS payload, evaluation_profile AS evaluationProfile, status, attempt_count AS attemptCount,
  result_json AS result, identity_json AS identity, metrics_json AS metrics, error_code AS errorCode,
  worker_id AS workerId, lease_token AS leaseToken, ${dateColumn("lease_until", "leaseUntil")},
  ${dateColumn("created_at", "createdAt")}, ${dateColumn("updated_at", "updatedAt")}, ${dateColumn("expires_at", "expiresAt")}`;
export const conversationMissing = () => new NotFoundError("CONVERSATION_NOT_FOUND", "Conversation was not found.");

export function mapConversation(row) {
  if (!row) return null;
  return { ...row, userId: String(row.userId), pathContentVersion: Number(row.pathContentVersion),
    config: parseJson(row.config), evaluationProfile: parseJson(row.evaluationProfile), state: parseJson(row.state),
    exerciseStartedAt: iso(row.exerciseStartedAt), createdAt: iso(row.createdAt), expiresAt: iso(row.expiresAt) };
}
export function mapConversationJob(row) {
  if (!row) return null;
  return { ...row, kind: "adaptive-conversation", userId: String(row.userId), attemptCount: Number(row.attemptCount),
    payload: parseJson(row.payload), evaluationProfile: parseJson(row.evaluationProfile), result: parseJson(row.result),
    identity: parseJson(row.identity), metrics: parseJson(row.metrics), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
    expiresAt: iso(row.expiresAt), leaseUntil: row.leaseUntil == null ? null : iso(row.leaseUntil) };
}
export async function ownedConversation(connection, userId, id, lock = false) {
  const [rows] = await connection.execute(`SELECT ${conversationColumns} FROM conversation_sessions WHERE user_id = ? AND id = ? LIMIT 1${lock ? " FOR UPDATE" : ""}`, [userId, id]);
  return mapConversation(rows[0]);
}
export function requirePrivateSession(session, now) {
  if (!session || Date.parse(session.expiresAt) <= Date.parse(iso(now))) throw conversationMissing();
}
export function synchronousTransform(callback, ...args) {
  const result = callback(...args);
  if (result?.then && typeof result.then === "function") {
    Promise.resolve(result).catch(() => {});
    throw new ValidationError("CONVERSATION_INVALID_TRANSFORM", "Conversation mutations must be synchronous.");
  }
  return result;
}
export function boundedState(state, revision) {
  if (!state || typeof state !== "object" || Array.isArray(state)
    || !["active", "completed", "cancelled", "expired"].includes(state.status)
    || !Number.isSafeInteger(revision) || revision < 1 || iso(state.activeUntil) !== state.activeUntil) {
    throw new ValidationError("CONVERSATION_INVALID_STATE", "Conversation state is invalid.");
  }
  const value = { ...state, revision };
  if (Buffer.byteLength(json(value), "utf8") > 2 * 1024 * 1024) throw new ValidationError("CONVERSATION_STATE_LIMIT", "Conversation state exceeds its storage limit.");
  return value;
}
export async function saveConversationState(connection, session, state) {
  const next = boundedState(state, session.state.revision + 1);
  await connection.execute("UPDATE conversation_sessions SET state_json = ? WHERE user_id = ? AND id = ?", [json(next), session.userId, session.id]);
  return { ...session, state: next };
}
export async function cancelConversationJobs(connection, session, now, ids = null) {
  if (ids?.length === 0) return;
  if (ids && (ids.length > 12 || ids.some((id) => typeof id !== "string" || !id || id.length > 64))) {
    throw new ValidationError("CONVERSATION_INVALID_JOB", "Conversation cancellation ids are invalid.");
  }
  const filter = ids ? ` AND id IN (${ids.map(() => "?").join(", ")})` : "";
  await connection.execute(`UPDATE conversation_inference_jobs SET status = 'cancelled', error_code = 'CONVERSATION_CANCELLED',
    worker_id = NULL, lease_token = NULL, lease_until = NULL, updated_at = ?
    WHERE user_id = ? AND session_id = ? AND status IN ('queued', 'running')${filter}`, [sqlTime(now), session.userId, session.id, ...(ids ?? [])]);
}

export async function saveCompletionEvidence(connection, session, completion, state, now) {
  if (!completion) return;
  const sameScope = ["userId", "pathId", "lessonId", "exerciseId", "slideId", "exerciseStartedAt", "contentVersion"]
    .every((key) => String(completion[key]) === String(session[key]));
  if (!sameScope || state.status !== "completed" || state.completionEvidenceId !== completion.id
    || completion.status !== "completed" || completion.acceptedTurnCount !== state.acceptedTurnCount
    || completion.minimumTurns !== session.config.minimumTurns || !Number.isSafeInteger(completion.acceptedTurnCount)
    || completion.acceptedTurnCount < completion.minimumTurns || completion.acceptedTurnCount > 4
    || completion.minimumTurns < 2 || Date.parse(iso(completion.completedAt)) > Date.parse(iso(now))) {
    throw new ConflictError("CONVERSATION_INVALID_COMPLETION", "Conversation completion does not match the saved session.");
  }
  await connection.execute(`INSERT INTO conversation_completion_evidence
    (id, user_id, path_id, lesson_id, exercise_id, slide_id, exercise_started_at, content_version,
     accepted_turn_count, minimum_turns, completed_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed')`,
  [completion.id, session.userId, session.pathId, session.lessonId, session.exerciseId, session.slideId,
    sqlTime(session.exerciseStartedAt), session.contentVersion, completion.acceptedTurnCount, completion.minimumTurns, sqlTime(completion.completedAt)]);
}
