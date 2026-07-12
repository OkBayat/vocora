import { ConflictError } from "../../../domain/errors.js";

function parseState(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) value = value.toString("utf8");
  return typeof value === "string" ? JSON.parse(value) : value;
}

export class MySqlLearningStateRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async findByUserId(userId) {
    const [rows] = await this.pool.execute(
      "SELECT state_json, revision FROM learning_states WHERE user_id = ? LIMIT 1",
      [userId]
    );
    return rows[0]
      ? { state: parseState(rows[0].state_json), revision: Number(rows[0].revision) }
      : { state: null, revision: 0 };
  }

  async save(userId, state, expectedRevision) {
    const serialized = JSON.stringify(state);
    const [updateResult] = await this.pool.execute(
      `UPDATE learning_states
       SET state_json = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND revision = ?`,
      [serialized, userId, expectedRevision]
    );

    if (updateResult.affectedRows === 1) return expectedRevision + 1;

    if (expectedRevision === 0) {
      try {
        await this.pool.execute(
          "INSERT INTO learning_states (user_id, state_json, revision) VALUES (?, ?, 1)",
          [userId, serialized]
        );
        return 1;
      } catch (error) {
        if (error?.code !== "ER_DUP_ENTRY") throw error;
      }
    }

    throw new ConflictError(
      "STATE_CONFLICT",
      "Learning state was updated by another session. Reload and try again."
    );
  }
}
