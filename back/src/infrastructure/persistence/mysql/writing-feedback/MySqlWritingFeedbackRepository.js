import { WritingFeedbackRepository } from "../../../../application/writing-feedback/ports/WritingFeedbackRepository.js";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../../../../domain/errors.js";
import { LocalTextInferencePersistence } from "../local-text-inference/LocalTextInferencePersistence.js";

const dateColumn = (column, alias) => `DATE_FORMAT(${column}, '%Y-%m-%dT%H:%i:%s.%fZ') AS ${alias}`;
export const writingFeedbackColumns = `id, user_id AS userId, request_hash AS requestHash, idempotency_key AS idempotencyKey,
  parent_submission_id AS parentSubmissionId, path_id AS pathId, lesson_id AS lessonId,
  exercise_id AS exerciseId, slide_id AS slideId, ${dateColumn("exercise_started_at", "exerciseStartedAt")},
  draft_text AS draftText, notes, task_context AS taskContext, evaluation_profile AS evaluationProfile, content_version AS contentVersion,
  status, attempt_count AS attemptCount, result_json AS result, identity_json AS identity,
  metrics_json AS metrics, error_code AS errorCode, worker_id AS workerId, lease_token AS leaseToken,
  ${dateColumn("lease_until", "leaseUntil")}, ${dateColumn("created_at", "createdAt")},
  ${dateColumn("updated_at", "updatedAt")}, ${dateColumn("expires_at", "expiresAt")}`;
const columns = writingFeedbackColumns;

function iso(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new ValidationError("WRITING_FEEDBACK_INVALID_TIME", "A valid feedback timestamp is required.");
  return date.toISOString();
}
const sqlTime = (value) => iso(value).replace("T", " ").replace("Z", "");
const json = (value) => value == null ? null : JSON.stringify(value);
const parseJson = (value) => typeof value === "string" ? JSON.parse(value) : value ?? null;
const bounded = (value, fallback, maximum) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
export function mapWritingFeedbackRow(row) {
  if (!row) return null;
  const result = { ...row, userId: String(row.userId), attemptCount: Number(row.attemptCount), notes: row.notes ?? "" };
  for (const field of ["taskContext", "evaluationProfile", "result", "identity", "metrics"]) result[field] = parseJson(row[field]);
  for (const field of ["exerciseStartedAt", "createdAt", "updatedAt", "expiresAt", "leaseUntil"]) result[field] = row[field] == null ? null : iso(row[field]);
  return result;
}
const mapRow = mapWritingFeedbackRow;
const missing = () => new NotFoundError("WRITING_FEEDBACK_NOT_FOUND", "Writing feedback was not found.");
const queueFull = () => new AppError(429, "WRITING_FEEDBACK_QUEUE_FULL", "Writing feedback is busy. Try again later.");

export class MySqlWritingFeedbackRepository extends WritingFeedbackRepository {
  constructor(pool) { super(); this.pool = pool; this.shared = new LocalTextInferencePersistence(pool); }

  async transaction(operation) {
    return this.shared.transaction(operation);
  }

  async owned(connection, userId, id, lock = false) {
    const [rows] = await connection.execute(
      `SELECT ${columns} FROM writing_feedback_submissions WHERE user_id = ? AND id = ? LIMIT 1${lock ? " FOR UPDATE" : ""}`,
      [userId, id],
    );
    return mapRow(rows[0]);
  }

  async hasCapacity(connection, userId, now, maxQueued = 8, maxPerOwner = 2) {
    return this.shared.hasCapacity(connection, userId, now, maxQueued, maxPerOwner);
  }

  async enqueue(record, { maxQueued = 8, maxPerOwner = 2, maxPerOwnerDay = 20, now = new Date() } = {}) {
    if (!["queued", "unavailable"].includes(record.status)) throw new ValidationError("WRITING_FEEDBACK_INVALID_STATUS", "A new draft must be queued or unavailable.");
    return this.transaction(async (connection) => {
      const [duplicates] = await connection.execute(
        `SELECT ${columns} FROM writing_feedback_submissions WHERE user_id = ? AND idempotency_key = ? LIMIT 1`,
        [record.userId, record.idempotencyKey],
      );
      if (duplicates[0]) {
        if (new Date(duplicates[0].expiresAt) <= new Date(iso(now))) throw missing();
        if (duplicates[0].requestHash !== record.requestHash) throw new ConflictError("WRITING_FEEDBACK_IDEMPOTENCY_CONFLICT", "This request key already belongs to another draft.");
        return mapRow(duplicates[0]);
      }
      if (record.parentSubmissionId) {
        const [parents] = await connection.execute(
          `SELECT id FROM writing_feedback_submissions
           WHERE user_id = ? AND id = ? AND exercise_id = ? AND exercise_started_at = ? AND expires_at > ? LIMIT 1`,
          [record.userId, record.parentSubmissionId, record.exerciseId, sqlTime(record.exerciseStartedAt), sqlTime(now)],
        );
        if (!parents[0]) throw new NotFoundError("WRITING_FEEDBACK_PARENT_NOT_FOUND", "The original draft was not found in this exercise run.");
      }
      const day = iso(now).slice(0, 10);
      const [quotas] = await connection.execute(
        `SELECT submission_count AS submissionCount FROM writing_feedback_daily_quotas WHERE user_id = ? AND quota_day = ? FOR UPDATE`,
        [record.userId, day],
      );
      if (Number(quotas[0]?.submissionCount ?? 0) >= bounded(maxPerOwnerDay, 20, 20)) {
        throw new AppError(429, "WRITING_FEEDBACK_DAILY_LIMIT", "The daily writing feedback submission limit has been reached.");
      }
      const [revisions] = await connection.execute(
        `SELECT COUNT(*) AS revisionCount FROM writing_feedback_submissions
         WHERE user_id = ? AND exercise_id = ? AND slide_id = ? AND exercise_started_at = ?`,
        [record.userId, record.exerciseId, record.slideId, sqlTime(record.exerciseStartedAt)],
      );
      if (Number(revisions[0].revisionCount) >= 10) {
        throw new AppError(429, "WRITING_FEEDBACK_REVISION_LIMIT", "This writing task has reached its saved draft limit.");
      }
      const saved = { ...record, notes: record.notes ?? "", attemptCount: 0, result: null, identity: null, metrics: null, errorCode: record.errorCode ?? null, workerId: null, leaseToken: null, leaseUntil: null };
      if (saved.status === "queued" && !await this.hasCapacity(connection, saved.userId, now, maxQueued, maxPerOwner)) {
        saved.status = "unavailable";
        saved.errorCode = "WRITING_FEEDBACK_QUEUE_FULL";
      }
      await connection.execute(
        `INSERT INTO writing_feedback_daily_quotas (user_id, quota_day, submission_count) VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE submission_count = submission_count + 1`, [saved.userId, day],
      );
      await connection.execute(
        `INSERT INTO writing_feedback_submissions
         (id, user_id, request_hash, idempotency_key, parent_submission_id, path_id, lesson_id,
          exercise_id, slide_id, exercise_started_at, draft_text, notes, task_context, evaluation_profile, content_version,
          status, attempt_count, error_code, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        [saved.id, saved.userId, saved.requestHash, saved.idempotencyKey, saved.parentSubmissionId ?? null,
          saved.pathId, saved.lessonId, saved.exerciseId, saved.slideId, sqlTime(saved.exerciseStartedAt),
          saved.draftText, saved.notes, json(saved.taskContext), json(saved.evaluationProfile), saved.contentVersion, saved.status,
          saved.errorCode, sqlTime(saved.createdAt), sqlTime(saved.updatedAt), sqlTime(saved.expiresAt)],
      );
      return mapRow(saved);
    });
  }

  async findOwned(userId, id) { return this.owned(this.pool, userId, id); }

  async listOwned(userId, { exerciseId, slideId, exerciseStartedAt }, limit = 10) {
    const [rows] = await this.pool.execute(
      `SELECT ${columns} FROM writing_feedback_submissions
       WHERE user_id = ? AND exercise_id = ? AND slide_id = ? AND exercise_started_at = ?
       ORDER BY created_at DESC, id DESC LIMIT ${bounded(limit, 10, 10)}`,
      [userId, exerciseId, slideId, sqlTime(exerciseStartedAt)],
    );
    return rows.map(mapRow);
  }

  async clearGate(connection) {
    return this.shared.clearGate(connection);
  }

  async claim({ workerId, leaseToken, now, leaseUntil, maxAttempts = 3, evaluationProfile = null }) {
    if (new Date(iso(leaseUntil)) <= new Date(iso(now))) throw new ValidationError("WRITING_FEEDBACK_INVALID_LEASE", "The worker lease must expire in the future.");
    return this.transaction(async (connection, gate) => {
      if (gate.jobKind === "adaptive-conversation") return null;
      if (gate.leaseToken && gate.leaseUntil && new Date(gate.leaseUntil) > new Date(now)) return null;
      if (gate.leaseToken) {
        await connection.execute(
          `UPDATE writing_feedback_submissions SET status = 'unavailable', error_code = 'WRITING_FEEDBACK_INTERRUPTED',
           worker_id = NULL, lease_token = NULL, lease_until = NULL, updated_at = ?
           WHERE id = ? AND status = 'running' AND lease_token = ?`,
          [sqlTime(now), gate.jobId, gate.leaseToken],
        );
        await this.clearGate(connection);
      }
      const [rows] = await connection.execute(
        `SELECT ${columns} FROM writing_feedback_submissions WHERE status = 'queued' AND expires_at > ? AND attempt_count < ?
         ORDER BY created_at, id LIMIT 1 FOR UPDATE`, [sqlTime(now), bounded(maxAttempts, 3, 3)],
      );
      if (!rows[0]) return null;
      const job = mapRow(rows[0]);
      await connection.execute(
        `UPDATE writing_feedback_submissions SET status = 'running', attempt_count = attempt_count + 1,
         worker_id = ?, lease_token = ?, lease_until = ?, updated_at = ?,
         evaluation_profile = COALESCE(evaluation_profile, ?) WHERE id = ? AND status = 'queued'`,
        [workerId, leaseToken, sqlTime(leaseUntil), sqlTime(now), json(evaluationProfile), job.id],
      );
      await connection.execute(
        `UPDATE writing_feedback_gate SET job_id = ?, worker_id = ?, lease_token = ?, lease_until = ?, job_kind = 'writing-feedback' WHERE id = 1`,
        [job.id, workerId, leaseToken, sqlTime(leaseUntil)],
      );
      return { ...job, evaluationProfile: job.evaluationProfile ?? evaluationProfile, status: "running", attemptCount: job.attemptCount + 1, workerId, leaseToken, leaseUntil: iso(leaseUntil), updatedAt: iso(now) };
    });
  }

  async finish({ id, leaseToken, now, status, result = null, identity = null, metrics = null, errorCode = null }) {
    if (!["completed", "unavailable"].includes(status)) throw new ValidationError("WRITING_FEEDBACK_INVALID_STATUS", "A worker must complete feedback or record unavailability.");
    return this.transaction(async (connection, gate) => {
      if (gate.jobKind === "adaptive-conversation") return false;
      if (gate.jobId !== id || gate.leaseToken !== leaseToken || !gate.leaseUntil || new Date(gate.leaseUntil) <= new Date(iso(now))) return false;
      const [updated] = await connection.execute(
        `UPDATE writing_feedback_submissions SET status = ?, result_json = ?, identity_json = ?, metrics_json = ?,
         error_code = ?, worker_id = NULL, lease_token = NULL, lease_until = NULL, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_token = ? AND lease_until > ? AND expires_at > ?`,
        [status, json(result), json(identity), json(metrics), errorCode, sqlTime(now), id, leaseToken, sqlTime(now), sqlTime(now)],
      );
      await this.clearGate(connection);
      return updated.affectedRows === 1;
    });
  }

  async retryOwned(userId, id, { now = new Date(), maxAttempts = 3, maxQueued = 8, maxPerOwner = 2 } = {}) {
    return this.transaction(async (connection) => {
      const job = await this.owned(connection, userId, id, true);
      if (!job || new Date(job.expiresAt) <= new Date(now)) throw missing();
      if (job.status === "queued" || job.status === "running") return job;
      if (job.attemptCount >= bounded(maxAttempts, 3, 3)) throw new ConflictError("WRITING_FEEDBACK_ATTEMPTS_EXHAUSTED", "This draft has reached its feedback attempt limit.");
      if (job.status !== "unavailable") throw new ConflictError("WRITING_FEEDBACK_NOT_RETRYABLE", "This draft cannot be retried.");
      if (!await this.hasCapacity(connection, userId, now, maxQueued, maxPerOwner)) throw queueFull();
      await connection.execute(
        `UPDATE writing_feedback_submissions SET status = 'queued', error_code = NULL, result_json = NULL,
         identity_json = NULL, metrics_json = NULL, worker_id = NULL, lease_token = NULL, lease_until = NULL, updated_at = ?
         WHERE user_id = ? AND id = ? AND status = 'unavailable'`, [sqlTime(now), userId, id],
      );
      return { ...job, status: "queued", errorCode: null, result: null, identity: null, metrics: null, workerId: null, leaseToken: null, leaseUntil: null, updatedAt: iso(now) };
    });
  }

  async cancelOwned(userId, id, now = new Date()) {
    return this.transaction(async (connection) => {
      const job = await this.owned(connection, userId, id, true);
      if (!job || new Date(job.expiresAt) <= new Date(now)) throw missing();
      if (!["queued", "running"].includes(job.status)) return job;
      await connection.execute(
        `UPDATE writing_feedback_submissions SET status = 'cancelled', error_code = NULL,
         worker_id = NULL, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE user_id = ? AND id = ?`,
        [sqlTime(now), userId, id],
      );
      return { ...job, status: "cancelled", errorCode: null, workerId: null, leaseToken: null, leaseUntil: null, updatedAt: iso(now) };
    });
  }

  async deleteOwned(userId, id) {
    return this.transaction(async (connection) => {
      const [result] = await connection.execute("DELETE FROM writing_feedback_submissions WHERE user_id = ? AND id = ?", [userId, id]);
      return result.affectedRows === 1;
    });
  }

  async purgeExpired(now = new Date(), limit = 100) {
    return this.transaction(async (connection) => {
      const batch = bounded(limit, 100, 100);
      const [result] = await connection.execute(`DELETE FROM writing_feedback_submissions WHERE expires_at <= ? ORDER BY expires_at LIMIT ${batch}`, [sqlTime(now)]);
      await connection.execute(`DELETE FROM writing_feedback_daily_quotas WHERE quota_day < ? ORDER BY quota_day LIMIT ${batch}`, [iso(now).slice(0, 10)]);
      return result.affectedRows;
    });
  }
}
