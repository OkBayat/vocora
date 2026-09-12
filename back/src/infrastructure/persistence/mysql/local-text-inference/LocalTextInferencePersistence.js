import { AppError, ValidationError } from "../../../../domain/errors.js";

export const dateColumn = (column, alias) => `DATE_FORMAT(${column}, '%Y-%m-%dT%H:%i:%s.%fZ') AS ${alias}`;
export function iso(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new ValidationError("LOCAL_TEXT_INFERENCE_INVALID_TIME", "A valid inference timestamp is required.");
  return date.toISOString();
}
export const sqlTime = (value) => iso(value).replace("T", " ").replace("Z", "");
export const json = (value) => value == null ? null : JSON.stringify(value);
export const parseJson = (value) => typeof value === "string" ? JSON.parse(value) : value ?? null;
export const bounded = (value, fallback, maximum) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;

export class LocalTextInferencePersistence {
  constructor(pool) { this.pool = pool; }

  async transaction(operation) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT id, job_id AS jobId, job_kind AS jobKind, lease_token AS leaseToken, ${dateColumn("lease_until", "leaseUntil")}
         FROM writing_feedback_gate WHERE id = 1 FOR UPDATE`,
      );
      if (!rows[0]) throw new AppError(503, "LOCAL_TEXT_INFERENCE_STORAGE_UNAVAILABLE", "Local feedback storage is unavailable.");
      const result = await operation(connection, rows[0]);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }

  async hasCapacity(connection, userId, now, maxQueued = 8, maxPerOwner = 2) {
    const [rows] = await connection.execute(
      `SELECT COUNT(*) AS activeCount, COALESCE(SUM(user_id = ?), 0) AS ownerCount FROM (
         SELECT user_id FROM writing_feedback_submissions WHERE status IN ('queued', 'running') AND expires_at > ?
         UNION ALL
         SELECT user_id FROM conversation_inference_jobs WHERE status IN ('queued', 'running') AND expires_at > ?
       ) AS active_jobs`, [userId, sqlTime(now), sqlTime(now)],
    );
    return Number(rows[0].activeCount) < bounded(maxQueued, 8, 8)
      && Number(rows[0].ownerCount) < bounded(maxPerOwner, 2, 2);
  }

  async clearGate(connection) {
    await connection.execute("UPDATE writing_feedback_gate SET job_id = NULL, worker_id = NULL, lease_token = NULL, lease_until = NULL, job_kind = NULL WHERE id = 1");
  }
}
