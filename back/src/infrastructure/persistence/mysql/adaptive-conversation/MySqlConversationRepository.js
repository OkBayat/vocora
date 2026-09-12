import { ConversationRepository } from "../../../../application/adaptive-conversation/ports/ConversationRepository.js";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../../../../domain/errors.js";
import { LocalTextInferencePersistence, bounded, dateColumn, iso, json, sqlTime } from "../local-text-inference/LocalTextInferencePersistence.js";
import { boundedState, cancelConversationJobs, conversationColumns, conversationJobColumns, conversationMissing,
  mapConversation, mapConversationJob, ownedConversation, requirePrivateSession, saveCompletionEvidence,
  saveConversationState, synchronousTransform } from "./conversationPersistence.js";

const queueFull = () => new AppError(429, "CONVERSATION_QUEUE_FULL", "Local feedback is busy. Try again later.");
const sameTask = (a, b) => ["pathId", "lessonId", "exerciseId", "slideId", "exerciseStartedAt", "contentVersion", "pathContentVersion"].every((key) => String(a[key]) === String(b[key]));

export class MySqlConversationRepository extends ConversationRepository {
  constructor(pool) { super(); this.pool = pool; this.shared = new LocalTextInferencePersistence(pool); }

  async create(record, { now = new Date() } = {}) {
    return this.shared.transaction(async (connection) => {
      const [duplicates] = await connection.execute(`SELECT ${conversationColumns} FROM conversation_sessions WHERE user_id = ? AND idempotency_key = ? LIMIT 1`, [record.userId, record.idempotencyKey]);
      if (duplicates[0]) {
        const existing = mapConversation(duplicates[0]);
        requirePrivateSession(existing, now);
        if (existing.requestHash !== record.requestHash) throw new ConflictError("CONVERSATION_IDEMPOTENCY_CONFLICT", "This request key already belongs to another conversation.");
        return existing;
      }
      const [active] = await connection.execute(`SELECT ${conversationColumns} FROM conversation_sessions
        WHERE user_id = ? AND status = 'active' AND active_until > ? AND expires_at > ? LIMIT 1`, [record.userId, iso(now), sqlTime(now)]);
      if (active[0]) {
        const existing = mapConversation(active[0]);
        if (!sameTask(existing, record)) throw new ConflictError("CONVERSATION_ACTIVE_SESSION", "Finish or cancel the active conversation first.");
        return existing;
      }
      const [[count]] = await connection.execute("SELECT COUNT(*) AS activeCount FROM conversation_sessions WHERE status = 'active' AND active_until > ? AND expires_at > ?", [iso(now), sqlTime(now)]);
      if (Number(count.activeCount) >= 16) throw new AppError(429, "CONVERSATION_SESSION_LIMIT", "Conversation practice is busy. Try again later.");
      const day = iso(now).slice(0, 10);
      const [quota] = await connection.execute("SELECT session_count AS sessionCount FROM conversation_daily_quotas WHERE user_id = ? AND quota_day = ? FOR UPDATE", [record.userId, day]);
      if (Number(quota[0]?.sessionCount ?? 0) >= 5) throw new AppError(429, "CONVERSATION_DAILY_LIMIT", "The daily conversation limit has been reached.");
      const saved = { ...record, state: boundedState(record.state, 1) };
      await connection.execute("INSERT INTO conversation_daily_quotas (user_id, quota_day, session_count) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE session_count = session_count + 1", [record.userId, day]);
      await connection.execute(`INSERT INTO conversation_sessions
        (id, user_id, path_id, lesson_id, exercise_id, slide_id, exercise_started_at, content_version, path_content_version,
         config_json, evaluation_profile, idempotency_key, request_hash, state_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [saved.id, saved.userId, saved.pathId, saved.lessonId, saved.exerciseId, saved.slideId, sqlTime(saved.exerciseStartedAt), saved.contentVersion,
        saved.pathContentVersion, json(saved.config), json(saved.evaluationProfile), saved.idempotencyKey, saved.requestHash, json(saved.state), sqlTime(saved.createdAt), sqlTime(saved.expiresAt)]);
      return mapConversation(saved);
    });
  }

  async findOwned(userId, id) { return ownedConversation(this.pool, userId, id); }
  async listOwned(userId, { exerciseId, slideId, exerciseStartedAt }, limit = 5) {
    const [rows] = await this.pool.execute(`SELECT ${conversationColumns} FROM conversation_sessions
      WHERE user_id = ? AND exercise_id = ? AND slide_id = ? AND exercise_started_at = ? ORDER BY created_at DESC, id DESC LIMIT ${bounded(limit, 5, 5)}`,
    [userId, exerciseId, slideId, sqlTime(exerciseStartedAt)]);
    return rows.map(mapConversation);
  }

  async enqueueJob(connection, session, job, state, now) {
    const hasCapacity = await this.shared.hasCapacity(connection, session.userId, now);
    const turn = state.turns.find((candidate) => candidate.id === job.turnId);
    if (!job.id || job.sessionId !== session.id || String(job.userId) !== session.userId
      || !turn || turn.selectedRecordingId !== job.id || !job.payload || typeof job.payload !== "object"
      || Buffer.byteLength(json(job.payload), "utf8") > 2 * 1024 * 1024) {
      throw new ValidationError("CONVERSATION_INVALID_JOB", "The inference job does not match the selected conversation recording.");
    }
    if (!hasCapacity) { turn.status = "retryable_failure"; turn.errorCode = "CONVERSATION_QUEUE_FULL"; }
    await connection.execute(`INSERT INTO conversation_inference_jobs
      (id, session_id, turn_id, user_id, payload_json, evaluation_profile, status, attempt_count, error_code, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [job.id, session.id, job.turnId, session.userId, json(job.payload), json(session.evaluationProfile ?? job.evaluationProfile),
      hasCapacity ? "queued" : "unavailable", hasCapacity ? null : "CONVERSATION_QUEUE_FULL", sqlTime(job.createdAt ?? now), sqlTime(now), sqlTime(job.expiresAt ?? session.expiresAt)]);
  }

  async mutateOwned(userId, id, expectedRevision, transform, { now = new Date() } = {}) {
    return this.shared.transaction(async (connection) => {
      const current = await ownedConversation(connection, userId, id, true);
      requirePrivateSession(current, now);
      if (expectedRevision != null && expectedRevision !== current.state.revision) throw new ConflictError("CONVERSATION_REVISION_CONFLICT", "Conversation changed. Reload it before trying again.");
      const change = synchronousTransform(transform, structuredClone(current));
      if (!change || typeof change !== "object" || !change.state) throw new ValidationError("CONVERSATION_INVALID_TRANSFORM", "A conversation mutation must return state.");
      const state = boundedState(change.state, current.state.revision + 1);
      if (change.cancelJobIds) await cancelConversationJobs(connection, current, now, change.cancelJobIds);
      if (change.job) await this.enqueueJob(connection, current, change.job, state, now);
      await saveCompletionEvidence(connection, current, change.completion, state, now);
      return saveConversationState(connection, current, state);
    });
  }

  async retryJobOwned(userId, sessionId, turnId, { now = new Date() } = {}) {
    return this.shared.transaction(async (connection) => {
      const session = await ownedConversation(connection, userId, sessionId, true);
      requirePrivateSession(session, now);
      if (session.state.status !== "active" || Date.parse(session.state.activeUntil) <= Date.parse(iso(now))) throw new ConflictError("CONVERSATION_SESSION_NOT_ACTIVE", "This conversation is no longer active.");
      const state = structuredClone(session.state);
      const turn = state.turns.find((candidate) => candidate.id === turnId);
      if (!turn || !turn.selectedRecordingId) throw new NotFoundError("CONVERSATION_TURN_NOT_FOUND", "Conversation turn was not found.");
      const [rows] = await connection.execute(`SELECT ${conversationJobColumns} FROM conversation_inference_jobs WHERE user_id = ? AND session_id = ? AND turn_id = ? AND id = ? LIMIT 1 FOR UPDATE`, [userId, sessionId, turnId, turn.selectedRecordingId]);
      const job = mapConversationJob(rows[0]);
      if (!job || Date.parse(job.expiresAt) <= Date.parse(iso(now))) throw new NotFoundError("CONVERSATION_JOB_NOT_FOUND", "Conversation feedback was not found.");
      if (["queued", "running"].includes(job.status)) return session;
      if (job.attemptCount >= 3) throw new ConflictError("CONVERSATION_ATTEMPTS_EXHAUSTED", "This recording has reached its feedback attempt limit.");
      if (job.status !== "unavailable") throw new ConflictError("CONVERSATION_NOT_RETRYABLE", "This recording cannot be retried.");
      if (!await this.shared.hasCapacity(connection, userId, now)) throw queueFull();
      await connection.execute(`UPDATE conversation_inference_jobs SET status = 'queued', result_json = NULL, identity_json = NULL, metrics_json = NULL,
        error_code = NULL, worker_id = NULL, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE user_id = ? AND id = ? AND status = 'unavailable'`, [sqlTime(now), userId, job.id]);
      turn.status = "queued"; turn.errorCode = null;
      return saveConversationState(connection, session, state);
    });
  }

  async cancelOwned(userId, id, { now = new Date() } = {}) {
    return this.shared.transaction(async (connection) => {
      const session = await ownedConversation(connection, userId, id, true);
      requirePrivateSession(session, now);
      if (session.state.status !== "active") return session;
      await cancelConversationJobs(connection, session, now);
      return saveConversationState(connection, session, { ...session.state, status: "cancelled" });
    });
  }

  async deleteOwned(userId, id) {
    return this.shared.transaction(async (connection) => {
      const [result] = await connection.execute("DELETE FROM conversation_sessions WHERE user_id = ? AND id = ?", [userId, id]);
      return result.affectedRows === 1;
    });
  }

  async purgeExpired(now = new Date(), limit = 100) {
    return this.shared.transaction(async (connection) => {
      const batch = bounded(limit, 100, 100);
      const [expiredActive] = await connection.execute(`SELECT ${conversationColumns} FROM conversation_sessions WHERE status = 'active' AND active_until <= ? ORDER BY active_until LIMIT ${batch} FOR UPDATE`, [iso(now)]);
      for (const row of expiredActive) {
        const session = mapConversation(row);
        await cancelConversationJobs(connection, session, now);
        await saveConversationState(connection, session, { ...session.state, status: "expired" });
      }
      const [deleted] = await connection.execute(`DELETE FROM conversation_sessions WHERE expires_at <= ? ORDER BY expires_at LIMIT ${batch}`, [sqlTime(now)]);
      await connection.execute(`DELETE FROM conversation_inference_jobs WHERE expires_at <= ? ORDER BY expires_at LIMIT ${batch}`, [sqlTime(now)]);
      await connection.execute(`DELETE FROM conversation_daily_quotas WHERE quota_day < ? ORDER BY quota_day LIMIT ${batch}`, [iso(now).slice(0, 10)]);
      return deleted.affectedRows;
    });
  }

  async findCompletionEvidence(userId, ids) {
    if (!Array.isArray(ids)) throw new ValidationError("CONVERSATION_INVALID_EVIDENCE", "Conversation evidence identifiers are invalid.");
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    if (unique.some((id) => typeof id !== "string" || !id || id.length > 64)) throw new ValidationError("CONVERSATION_INVALID_EVIDENCE", "Conversation evidence identifiers are invalid.");
    const rows = [];
    for (let offset = 0; offset < unique.length; offset += 64) {
      const batch = unique.slice(offset, offset + 64);
      const [found] = await this.pool.execute(`SELECT id, user_id AS userId, path_id AS pathId, lesson_id AS lessonId, exercise_id AS exerciseId, slide_id AS slideId,
        ${dateColumn("exercise_started_at", "exerciseStartedAt")}, content_version AS contentVersion, accepted_turn_count AS acceptedTurnCount,
        minimum_turns AS minimumTurns, ${dateColumn("completed_at", "completedAt")}, status FROM conversation_completion_evidence
        WHERE user_id = ? AND id IN (${batch.map(() => "?").join(", ")})`, [userId, ...batch]);
      rows.push(...found);
    }
    return rows.map((row) => ({ ...row, userId: String(row.userId), acceptedTurnCount: Number(row.acceptedTurnCount), minimumTurns: Number(row.minimumTurns), exerciseStartedAt: iso(row.exerciseStartedAt), completedAt: iso(row.completedAt) }));
  }
}
