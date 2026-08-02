-- provider_credentials — the target table for the watch-credential migration.
--
-- This DDL is the byte-for-byte equivalent of the Go worker's GORM model
-- (src/go/internal/storage/watch_models.go :: ProviderCredential). In production
-- the table is normally created by the Go worker's AutoMigrateWatch; this file is
-- provided so a fresh Tencent DB can be seeded before the worker's first run, and
-- so the migration's `--ensure-schema` flag has something to execute.
--
-- Column contract (see README):
--   user_id           app-level UUID (JWT sub) — NOT the numeric COROS account id
--   provider          'coros' | 'garmin'
--   email/region      copied verbatim from the credential; NULL when empty
--   provider_user_id  provider account id (COROS user_id / Garmin userName); NULL when empty
--   secret            plaintext-v1 JSON blob:
--                       coros  -> {"pwd_hash":...,"access_token":...}
--                       garmin -> {"oauth1":...,"oauth2":...}
--   updated_at        UTC write time (datetime(6))

CREATE TABLE IF NOT EXISTS provider_credentials (
  user_id          CHAR(36)     NOT NULL,
  provider         VARCHAR(32)  NOT NULL,
  email            VARCHAR(255) NULL,
  region           VARCHAR(16)  NULL,
  provider_user_id VARCHAR(64)  NULL,
  secret           BLOB         NULL,
  updated_at       DATETIME(6)  NOT NULL,
  PRIMARY KEY (user_id, provider)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
