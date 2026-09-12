-- Additive formative-feedback storage. Learner progress remains independently authoritative.
CREATE TABLE IF NOT EXISTS writing_feedback_submissions (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  parent_submission_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  path_id VARCHAR(160) NOT NULL,
  lesson_id VARCHAR(160) NOT NULL,
  exercise_id VARCHAR(160) NOT NULL,
  slide_id VARCHAR(160) NOT NULL,
  exercise_started_at DATETIME(3) NOT NULL,
  draft_text MEDIUMTEXT NOT NULL,
  notes TEXT NOT NULL,
  task_context JSON NOT NULL,
  evaluation_profile JSON NULL,
  content_version VARCHAR(160) NOT NULL,
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
  UNIQUE KEY writing_feedback_owner_idempotency_unique (user_id, idempotency_key),
  KEY writing_feedback_owner_run_index (user_id, exercise_id, slide_id, exercise_started_at, created_at),
  KEY writing_feedback_queue_index (status, created_at, id),
  KEY writing_feedback_expiry_index (expires_at),
  CONSTRAINT writing_feedback_attempt_bound CHECK (attempt_count <= 3),
  CONSTRAINT writing_feedback_status_valid CHECK (status IN ('queued', 'running', 'completed', 'unavailable', 'cancelled')),
  CONSTRAINT writing_feedback_owner_fk FOREIGN KEY (user_id) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_bin;

-- This lease survives cancellation/deletion of its job until the provider call ends or expires.
-- Keeping it independent prevents a cancelled request from freeing provider concurrency early.
CREATE TABLE IF NOT EXISTS writing_feedback_gate (
  id TINYINT UNSIGNED NOT NULL,
  job_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  worker_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_token VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_until DATETIME(3) NULL,
  PRIMARY KEY (id),
  CONSTRAINT writing_feedback_gate_singleton CHECK (id = 1)
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_bin;

INSERT IGNORE INTO writing_feedback_gate (id) VALUES (1);

-- Daily admission accounting survives individual draft deletion; days are UTC.
CREATE TABLE IF NOT EXISTS writing_feedback_daily_quotas (
  user_id BIGINT UNSIGNED NOT NULL,
  quota_day DATE NOT NULL,
  submission_count SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (user_id, quota_day),
  KEY writing_feedback_quota_day_index (quota_day),
  CONSTRAINT writing_feedback_quota_owner_fk FOREIGN KEY (user_id) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_bin;
