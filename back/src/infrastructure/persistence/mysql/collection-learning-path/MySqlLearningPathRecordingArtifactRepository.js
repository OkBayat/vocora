import { LearningPathRecordingArtifactRepository } from "../../../../application/collection-learning-path/ports/LearningPathRecordingArtifactRepository.js";

function timestampParameter(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("Learning Path recording artifact timestamp must be a valid date.");
  }
  return date;
}

export class MySqlLearningPathRecordingArtifactRepository extends LearningPathRecordingArtifactRepository {
  constructor(pool) {
    super();
    this.pool = pool;
  }

  async save(artifact) {
    const [result] = await this.pool.execute(
      `INSERT INTO learning_path_recording_artifacts
         (public_id, user_id, exercise_id, exercise_started_at, slide_public_id,
          mime_type, byte_size, sha256, audio_data, created_at)
       SELECT ?, ?, e.id, ?, ?, ?, ?, ?, ?, ?
       FROM learning_path_exercises e
       WHERE e.public_id = ?`,
      [
        artifact.publicId,
        artifact.userId,
        timestampParameter(artifact.exerciseStartedAt),
        artifact.slideId,
        artifact.mimeType,
        artifact.byteSize,
        artifact.sha256,
        artifact.bytes,
        timestampParameter(artifact.createdAt),
        artifact.exerciseId,
      ],
    );
    if (result.affectedRows !== 1) throw new Error("Speaking recording artifact could not be persisted.");
  }

  async findByPublicIds(userId, publicIds) {
    const ids = [...new Set(publicIds.map((value) => String(value ?? "").trim()).filter(Boolean))];
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const [rows] = await this.pool.execute(
      `SELECT a.public_id AS publicId, a.user_id AS userId, e.public_id AS exerciseId,
              a.exercise_started_at AS exerciseStartedAt,
              a.slide_public_id AS slideId, a.mime_type AS mimeType, a.byte_size AS byteSize,
              a.sha256, a.created_at AS createdAt
       FROM learning_path_recording_artifacts a
       JOIN learning_path_exercises e ON e.id = a.exercise_id
       WHERE a.user_id = ? AND a.public_id IN (${placeholders})`,
      [userId, ...ids],
    );
    return rows.map((row) => ({ ...row, byteSize: Number(row.byteSize) }));
  }
}
