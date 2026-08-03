-- Target tables for the migration project.
--
-- Table 1, provider_credentials, is the target for the watch-credential migration
-- (src/index.js). Tables 2-3, user_profile / user_onboarding, are the target for
-- the profile+onboarding migration (src/migrate-profiles.js).
--
-- Each DDL is the byte-for-byte equivalent of the corresponding Go worker GORM
-- model. In production the tables are normally created by the Go worker's
-- AutoMigrate* helpers; this file is provided so a fresh Tencent DB can be seeded
-- before the worker's first run, and so each migration's `--ensure-schema` flag
-- has something to execute.
--
-- provider_credentials — src/go/internal/storage/watch_models.go (ProviderCredential),
-- created in prod by AutoMigrateWatch.
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

-- user_profile — athlete onboarding identity + body metrics (ADR 0013).
--
-- Equivalent to the Go GORM model src/go/internal/storage/user_models.go
-- (UserProfile), normally created by the Go worker's AutoMigrateUsers. Time
-- columns are datetime(3) to match GORM's default time.Time precision (the model
-- adds no explicit type tag). Only the five onboarding core columns live here;
-- race/training-plan goals belong to a separate future table.
--
-- Column contract (see README):
--   user_id       app-level UUID (JWT sub) — same id space as provider_credentials
--   display_name  athlete display name
--   dob           ISO YYYY-MM-DD Shanghai-local calendar date (never tz-converted)
--   sex           male | female | other (may be empty for legacy profiles)
--   height_cm     body height (double)
--   weight_kg     body weight (double)
--   created_at    first-write time; updated_at last-write time (UTC)

CREATE TABLE IF NOT EXISTS user_profile (
  user_id      VARCHAR(64)  NOT NULL,
  display_name VARCHAR(255) NULL,
  dob          VARCHAR(10)  NULL,
  sex          VARCHAR(16)  NULL,
  height_cm    DOUBLE       NULL,
  weight_kg    DOUBLE       NULL,
  created_at   DATETIME(3)  NULL,
  updated_at   DATETIME(3)  NULL,
  PRIMARY KEY (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- user_onboarding — onboarding gate flags (ADR 0013). Equivalent to the Go GORM
-- model UserOnboarding. Python's coros_ready maps to the provider-agnostic
-- watch_ready; completed_at is nullable (Go leaves it null until the
-- sync-endpoint port lands, but migrated rows carry the legacy Python value).
--
-- Column contract:
--   watch_ready    a watch data source is connected (Python coros_ready)
--   profile_ready  the profile form has been saved
--   completed_at   onboarding completion instant (UTC), NULL if never completed
--   created_at     first-write time; updated_at last-write time (UTC)

CREATE TABLE IF NOT EXISTS user_onboarding (
  user_id       VARCHAR(64) NOT NULL,
  watch_ready   TINYINT(1)  NOT NULL DEFAULT 0,
  profile_ready TINYINT(1)  NOT NULL DEFAULT 0,
  completed_at  DATETIME(3) NULL,
  created_at    DATETIME(3) NULL,
  updated_at    DATETIME(3) NULL,
  PRIMARY KEY (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
