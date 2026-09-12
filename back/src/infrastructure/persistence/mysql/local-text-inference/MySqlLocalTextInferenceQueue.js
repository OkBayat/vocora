import { ValidationError } from "../../../../domain/errors.js";
import { MySqlWritingFeedbackRepository, mapWritingFeedbackRow, writingFeedbackColumns } from "../writing-feedback/MySqlWritingFeedbackRepository.js";
import { MySqlConversationRepository } from "../adaptive-conversation/MySqlConversationRepository.js";
import { conversationJobColumns, mapConversationJob, ownedConversation, saveCompletionEvidence,
  saveConversationState, synchronousTransform } from "../adaptive-conversation/conversationPersistence.js";
import { LocalTextInferencePersistence, iso, json, parseJson, sqlTime } from "./LocalTextInferencePersistence.js";

const KINDS = Object.freeze({
  "writing-feedback": { table: "writing_feedback_submissions", columns: writingFeedbackColumns, map: mapWritingFeedbackRow, interrupted: "WRITING_FEEDBACK_INTERRUPTED" },
  "adaptive-conversation": { table: "conversation_inference_jobs", columns: conversationJobColumns, map: mapConversationJob, interrupted: "CONVERSATION_INTERRUPTED" },
});
function definition(kind) {
  if (!Object.hasOwn(KINDS, kind)) throw new ValidationError("LOCAL_TEXT_INFERENCE_INVALID_KIND", "Inference job kind is unsupported.");
  return KINDS[kind];
}

export class MySqlLocalTextInferenceQueue extends LocalTextInferencePersistence {
  async isClaimCurrent({ kind, id, leaseToken, now }) {
    const spec = definition(kind);
    const conversation = kind === "adaptive-conversation";
    // Read the gate, job and selected turn in one snapshot. The worker reserves
    // its abort controller before this read so later cancellation also fences
    // the gap between this check and starting the provider.
    const [rows] = await this.pool.execute(`SELECT j.id${conversation ? ", j.turn_id AS turnId, s.state_json AS state" : ""}
      FROM ${spec.table} j
      JOIN writing_feedback_gate g ON g.id = 1 AND g.job_id = j.id AND g.lease_token = j.lease_token
        AND COALESCE(g.job_kind, 'writing-feedback') = ?
      ${conversation ? "JOIN conversation_sessions s ON s.id = j.session_id AND s.user_id = j.user_id" : ""}
      WHERE j.id = ? AND j.status = 'running' AND j.lease_token = ?
        AND j.lease_until > ? AND j.expires_at > ? AND g.lease_until > ?
        ${conversation ? "AND s.status = 'active' AND s.active_until > ? AND s.expires_at > ?" : ""}
      LIMIT 1`, [kind, id, leaseToken, sqlTime(now), sqlTime(now), sqlTime(now),
      ...(conversation ? [iso(now), sqlTime(now)] : [])]);
    const row = rows[0];
    if (!row) return false;
    if (!conversation) return true;
    const state = parseJson(row.state);
    const turn = state?.turns?.find((item) => item.id === row.turnId);
    return state?.currentTurnId === row.turnId && turn?.selectedRecordingId === row.id && turn.status === "evaluating";
  }

  async purgeExpired(now = new Date(), limit = 100) {
    const writing = await new MySqlWritingFeedbackRepository(this.pool).purgeExpired(now, limit);
    const conversation = await new MySqlConversationRepository(this.pool).purgeExpired(now, limit);
    return writing + conversation;
  }

  async loadJob(connection, kind, id) {
    const spec = definition(kind);
    const [rows] = await connection.execute(`SELECT ${spec.columns} FROM ${spec.table} WHERE id = ? LIMIT 1 FOR UPDATE`, [id]);
    const row = spec.map(rows[0]);
    return row ? { ...row, kind } : null;
  }

  async reconcileLease(connection, gate, now) {
    if (!gate.leaseToken) return;
    const kind = gate.jobKind ?? "writing-feedback";
    const spec = definition(kind);
    const job = kind === "adaptive-conversation" ? await this.loadJob(connection, kind, gate.jobId) : null;
    await connection.execute(`UPDATE ${spec.table} SET status = 'unavailable', error_code = ?, worker_id = NULL,
      lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND lease_token = ?`,
    [spec.interrupted, sqlTime(now), gate.jobId, gate.leaseToken]);
    if (job?.status === "running" && job.leaseToken === gate.leaseToken) {
      const session = await ownedConversation(connection, job.userId, job.sessionId, true);
      const turn = session?.state.turns.find((item) => item.id === job.turnId);
      if (session?.state.status === "active" && turn?.selectedRecordingId === job.id && ["queued", "evaluating"].includes(turn.status)) {
        turn.status = "retryable_failure"; turn.errorCode = spec.interrupted; turn.attemptCount = job.attemptCount;
        await saveConversationState(connection, session, session.state);
      }
    }
    await this.clearGate(connection);
  }

  async claim({ workerId, leaseToken, now, leaseUntil, evaluationProfiles = {} }) {
    if (Date.parse(iso(leaseUntil)) <= Date.parse(iso(now))) throw new ValidationError("LOCAL_TEXT_INFERENCE_INVALID_LEASE", "The inference lease must expire in the future.");
    return this.transaction(async (connection, gate) => {
      if (gate.leaseToken && gate.leaseUntil && Date.parse(gate.leaseUntil) > Date.parse(iso(now))) return null;
      await this.reconcileLease(connection, gate, now);
      const [candidates] = await connection.execute(`SELECT kind, id, created_at FROM (
        SELECT 'writing-feedback' AS kind, id, created_at FROM writing_feedback_submissions
          WHERE status = 'queued' AND expires_at > ? AND attempt_count < 3
        UNION ALL
        SELECT 'adaptive-conversation' AS kind, j.id, j.created_at FROM conversation_inference_jobs j
          JOIN conversation_sessions s ON s.id = j.session_id AND s.user_id = j.user_id
          WHERE j.status = 'queued' AND j.expires_at > ? AND j.attempt_count < 3
            AND s.status = 'active' AND s.active_until > ? AND s.expires_at > ?
        ) AS queued_jobs ORDER BY created_at, id, kind LIMIT 1`, [sqlTime(now), sqlTime(now), iso(now), sqlTime(now)]);
      if (!candidates[0]) return null;
      const { kind, id } = candidates[0];
      const spec = definition(kind);
      const job = await this.loadJob(connection, kind, id);
      if (!job || job.status !== "queued" || job.attemptCount >= 3) return null;
      let session;
      if (kind === "adaptive-conversation") {
        session = await ownedConversation(connection, job.userId, job.sessionId, true);
        const turn = session?.state.turns.find((item) => item.id === job.turnId);
        if (!session || session.state.status !== "active" || Date.parse(session.state.activeUntil) <= Date.parse(iso(now))
          || turn?.selectedRecordingId !== job.id || !["queued", "evaluating"].includes(turn.status)) {
          await connection.execute("UPDATE conversation_inference_jobs SET status = 'cancelled', error_code = 'CONVERSATION_STALE_JOB', updated_at = ? WHERE id = ? AND status = 'queued'", [sqlTime(now), id]);
          return null;
        }
        turn.status = "evaluating"; turn.attemptCount = job.attemptCount + 1;
        await saveConversationState(connection, session, session.state);
      }
      const evaluationProfile = job.evaluationProfile ?? evaluationProfiles[kind] ?? null;
      await connection.execute(`UPDATE ${spec.table} SET status = 'running', attempt_count = attempt_count + 1,
        worker_id = ?, lease_token = ?, lease_until = ?, updated_at = ?,
        evaluation_profile = COALESCE(evaluation_profile, ?) WHERE id = ? AND status = 'queued'`,
      [workerId, leaseToken, sqlTime(leaseUntil), sqlTime(now), json(evaluationProfile), id]);
      await connection.execute("UPDATE writing_feedback_gate SET job_id = ?, worker_id = ?, lease_token = ?, lease_until = ?, job_kind = ? WHERE id = 1", [id, workerId, leaseToken, sqlTime(leaseUntil), kind]);
      return { ...job, kind, status: "running", evaluationProfile, attemptCount: job.attemptCount + 1, workerId, leaseToken, leaseUntil: iso(leaseUntil), updatedAt: iso(now) };
    });
  }

  async finish({ kind, id, leaseToken, now, status, result = null, identity = null, metrics = null, errorCode = null, applyConversationResult }) {
    const spec = definition(kind);
    if (!["completed", "unavailable"].includes(status)) throw new ValidationError("LOCAL_TEXT_INFERENCE_INVALID_STATUS", "An inference must complete or record unavailability.");
    return this.transaction(async (connection, gate) => {
      if ((gate.jobKind ?? "writing-feedback") !== kind || gate.jobId !== id || gate.leaseToken !== leaseToken
        || !gate.leaseUntil || Date.parse(gate.leaseUntil) <= Date.parse(iso(now))) return false;
      const job = await this.loadJob(connection, kind, id);
      if (!job || job.status !== "running" || job.leaseToken !== leaseToken
        || Date.parse(job.leaseUntil) <= Date.parse(iso(now)) || Date.parse(job.expiresAt) <= Date.parse(iso(now))) {
        await this.clearGate(connection);
        return false;
      }
      let change;
      let session;
      let accepted = true;
      if (kind === "adaptive-conversation") {
        session = await ownedConversation(connection, job.userId, job.sessionId, true);
        if (!session || Date.parse(session.expiresAt) <= Date.parse(iso(now))) {
          accepted = false;
        } else {
          if (typeof applyConversationResult !== "function") throw new ValidationError("CONVERSATION_INVALID_TRANSFORM", "Conversation inference requires an application result handler.");
          change = synchronousTransform(applyConversationResult, structuredClone(session), structuredClone(job), { status, result, identity, metrics, errorCode, now: iso(now) });
          if (change === null) accepted = false;
          else if (!change || typeof change !== "object" || !change.state) throw new ValidationError("CONVERSATION_INVALID_TRANSFORM", "Conversation inference must return state or ignore a stale result.");
        }
      }
      const [updated] = await connection.execute(`UPDATE ${spec.table} SET status = ?, result_json = ?, identity_json = ?, metrics_json = ?,
        error_code = ?, worker_id = NULL, lease_token = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_token = ? AND lease_until > ? AND expires_at > ?`,
      [accepted ? status : "cancelled", accepted ? json(result) : null, accepted ? json(identity) : null, accepted ? json(metrics) : null,
        accepted ? errorCode : "CONVERSATION_STALE_RESULT", sqlTime(now), id, leaseToken, sqlTime(now), sqlTime(now)]);
      if (updated.affectedRows === 1 && accepted && change) {
        await saveCompletionEvidence(connection, session, change.completion, change.state, now);
        await saveConversationState(connection, session, change.state);
      }
      await this.clearGate(connection);
      return updated.affectedRows === 1 && accepted;
    });
  }
}
