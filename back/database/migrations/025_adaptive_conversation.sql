-- Retain the existing singleton lease so Writing and conversation cannot overlap.
ALTER TABLE writing_feedback_gate
  ADD COLUMN job_kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER job_id;
UPDATE writing_feedback_gate SET job_kind = 'writing-feedback' WHERE job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversation_sessions (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  path_id VARCHAR(160) NOT NULL,
  lesson_id VARCHAR(160) NOT NULL,
  exercise_id VARCHAR(160) NOT NULL,
  slide_id VARCHAR(160) NOT NULL,
  exercise_started_at DATETIME(3) NOT NULL,
  content_version VARCHAR(160) NOT NULL,
  path_content_version BIGINT UNSIGNED NOT NULL,
  config_json JSON NOT NULL,
  evaluation_profile JSON NULL,
  idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state_json JSON NOT NULL,
  status VARCHAR(16) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(state_json, '$.status'))) STORED,
  active_until VARCHAR(24) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(state_json, '$.activeUntil'))) STORED,
  created_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY conversation_owner_idempotency_unique (user_id, idempotency_key),
  KEY conversation_owner_run_index (user_id, exercise_id, slide_id, exercise_started_at, created_at),
  KEY conversation_active_index (status, active_until),
  KEY conversation_expiry_index (expires_at),
  CONSTRAINT conversation_session_owner_fk FOREIGN KEY (user_id) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_bin;

CREATE TABLE IF NOT EXISTS conversation_inference_jobs (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  session_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  turn_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  payload_json JSON NOT NULL,
  evaluation_profile JSON NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  attempt_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
  result_json JSON NULL,
  identity_json JSON NULL,
  metrics_json JSON NULL,
  error_code VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NULL,
  worker_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_token VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_until DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY conversation_job_session_index (session_id, turn_id),
  KEY conversation_job_queue_index (status, created_at, id),
  KEY conversation_job_owner_index (user_id, status),
  KEY conversation_job_expiry_index (expires_at),
  CONSTRAINT conversation_job_attempt_bound CHECK (attempt_count <= 3),
  CONSTRAINT conversation_job_status_valid CHECK (status IN ('queued', 'running', 'completed', 'unavailable', 'cancelled')),
  CONSTRAINT conversation_job_session_fk FOREIGN KEY (session_id) REFERENCES conversation_sessions (id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT conversation_job_owner_fk FOREIGN KEY (user_id) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_bin;

-- Text-free evidence survives private session deletion and expires only with its account.
CREATE TABLE IF NOT EXISTS conversation_completion_evidence (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  path_id VARCHAR(160) NOT NULL,
  lesson_id VARCHAR(160) NOT NULL,
  exercise_id VARCHAR(160) NOT NULL,
  slide_id VARCHAR(160) NOT NULL,
  exercise_started_at DATETIME(3) NOT NULL,
  content_version VARCHAR(160) NOT NULL,
  accepted_turn_count TINYINT UNSIGNED NOT NULL,
  minimum_turns TINYINT UNSIGNED NOT NULL,
  completed_at DATETIME(3) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'completed',
  PRIMARY KEY (id),
  KEY conversation_evidence_owner_index (user_id, exercise_id, exercise_started_at, slide_id),
  CONSTRAINT conversation_evidence_turn_bound CHECK (accepted_turn_count BETWEEN 2 AND 4 AND minimum_turns BETWEEN 2 AND 4 AND accepted_turn_count >= minimum_turns),
  CONSTRAINT conversation_evidence_completed CHECK (status = 'completed'),
  CONSTRAINT conversation_evidence_owner_fk FOREIGN KEY (user_id) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_bin;

CREATE TABLE IF NOT EXISTS conversation_daily_quotas (
  user_id BIGINT UNSIGNED NOT NULL,
  quota_day DATE NOT NULL,
  session_count SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (user_id, quota_day),
  KEY conversation_quota_day_index (quota_day),
  CONSTRAINT conversation_quota_owner_fk FOREIGN KEY (user_id) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_bin;
