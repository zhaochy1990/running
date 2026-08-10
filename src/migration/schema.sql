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
-- watch_ready; completed_at records successful Go/Python onboarding completion.
-- onboarding_run_id associates an in-progress Go onboarding pipeline; it is NULL
-- when no run is claimed or after a watch disconnect.
--
-- Column contract:
--   watch_ready       a watch data source is connected (Python coros_ready)
--   profile_ready     the profile form has been saved
--   completed_at      onboarding completion instant (UTC), NULL if never completed
--   onboarding_run_id current Go onboarding pipeline run id, NULL when absent
--   created_at        first-write time; updated_at last-write time (UTC)

CREATE TABLE IF NOT EXISTS user_onboarding (
  user_id       VARCHAR(64) NOT NULL,
  watch_ready   TINYINT(1)  NOT NULL DEFAULT 0,
  profile_ready     TINYINT(1)  NOT NULL DEFAULT 0,
  completed_at      DATETIME(3) NULL,
  onboarding_run_id VARCHAR(64) NULL,
  created_at        DATETIME(3) NULL,
  updated_at        DATETIME(3) NULL,
  PRIMARY KEY (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Health-domain tables (targets for the health migration, src/migrate-health.js).
-- Each is the byte-for-byte equivalent of the Go worker GORM model in
-- src/go/internal/storage/watch_models.go, normally created in prod by
-- AutoMigrateWatch. `int` fields become BIGINT (GORM's default on 64-bit),
-- `float64` become DOUBLE, and time.Time become DATETIME(6).

-- daily_health — one daily training-status row per (user, Shanghai day).
--   date            Shanghai calendar day key, format YYYYMMDD (string; verbatim
--                   from the source so it stays comparable with the Go sync)
--   ati/cti         acute / chronic training impulse
--   sleep_* / body_battery_* / stress_avg / respiration_avg / spo2_avg
--                   Garmin-populated wellness extras (COROS leaves them NULL)
--   provider        'coros' | 'garmin'

CREATE TABLE IF NOT EXISTS daily_health (
  user_id             CHAR(36)     NOT NULL,
  date                VARCHAR(16)  NOT NULL,
  ati                 DOUBLE       NULL,
  cti                 DOUBLE       NULL,
  rhr                 BIGINT       NULL,
  distance_m          DOUBLE       NULL,
  duration_s          DOUBLE       NULL,
  training_load_ratio DOUBLE       NULL,
  training_load_state VARCHAR(32)  NULL,
  fatigue             DOUBLE       NULL,
  body_battery_high   BIGINT       NULL,
  body_battery_low    BIGINT       NULL,
  stress_avg          BIGINT       NULL,
  sleep_total_s       BIGINT       NULL,
  sleep_deep_s        BIGINT       NULL,
  sleep_light_s       BIGINT       NULL,
  sleep_rem_s         BIGINT       NULL,
  sleep_awake_s       BIGINT       NULL,
  sleep_score         BIGINT       NULL,
  respiration_avg     DOUBLE       NULL,
  spo2_avg            DOUBLE       NULL,
  provider            VARCHAR(32)  NOT NULL DEFAULT 'coros',
  PRIMARY KEY (user_id, date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- daily_hrv — per-day nightly HRV detail. date is ISO YYYY-MM-DD (verbatim from
-- the source). provider is part of the PK so a dual-watch user keeps both nights.

CREATE TABLE IF NOT EXISTS daily_hrv (
  user_id                 CHAR(36)     NOT NULL,
  date                    VARCHAR(16)  NOT NULL,
  provider                VARCHAR(32)  NOT NULL DEFAULT 'coros',
  weekly_avg              BIGINT       NULL,
  last_night_avg          BIGINT       NULL,
  last_night_5min_high    BIGINT       NULL,
  status                  VARCHAR(32)  NULL,
  baseline_low_upper      BIGINT       NULL,
  baseline_balanced_low   BIGINT       NULL,
  baseline_balanced_upper BIGINT       NULL,
  feedback_phrase         TEXT         NULL,
  PRIMARY KEY (user_id, date, provider)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- dashboard — per-user summary snapshot (SQLite pins a singleton id=1; here the
-- tenant key is the PK). updated_at is the migration run time (a wall-clock write
-- time, overwritten by the Go worker's next sync).

CREATE TABLE IF NOT EXISTS dashboard (
  user_id                   CHAR(36)     NOT NULL,
  running_level             DOUBLE       NULL,
  aerobic_score             DOUBLE       NULL,
  lactate_threshold_score   DOUBLE       NULL,
  anaerobic_endurance_score DOUBLE       NULL,
  anaerobic_capacity_score  DOUBLE       NULL,
  rhr                       BIGINT       NULL,
  threshold_hr              BIGINT       NULL,
  threshold_pace_s_km       DOUBLE       NULL,
  recovery_pct              DOUBLE       NULL,
  avg_sleep_hrv             DOUBLE       NULL,
  hrv_normal_low            DOUBLE       NULL,
  hrv_normal_high           DOUBLE       NULL,
  weekly_distance_m         DOUBLE       NULL,
  weekly_duration_s         DOUBLE       NULL,
  provider                  VARCHAR(32)  NOT NULL DEFAULT 'coros',
  updated_at                DATETIME(6)  NOT NULL,
  PRIMARY KEY (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- race_predictions — per-user, per-race-type time prediction. The SQLite surrogate
-- id is dropped; the tenant key + race_type is the PK.

CREATE TABLE IF NOT EXISTS race_predictions (
  user_id    CHAR(36)     NOT NULL,
  race_type  VARCHAR(32)  NOT NULL,
  duration_s DOUBLE       NULL,
  avg_pace   DOUBLE       NULL,
  updated_at DATETIME(6)  NOT NULL,
  PRIMARY KEY (user_id, race_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- race_goal — the athlete's target race + weekly-availability prefs (ADR 0021),
-- target for the training-goal migration (src/migrate-training-goals.js). This
-- is the greenfield Go/MySQL redesign of the Python training_goal.json blob:
-- race goals only (the old `type` enum is dropped), one active row per athlete.
--
-- Equivalent to the Go GORM model src/go/internal/storage/goal_models.go
-- (RaceGoal), created in prod by the cmd/api boot AutoMigrateGoals. The DDL below
-- is byte-for-byte SHOW CREATE TABLE of that AutoMigrate output: `int` →
-- BIGINT, `[]string serializer:json` → LONGTEXT (a JSON-array text, e.g. `[]`),
-- time.Time → DATETIME(3) (GORM default precision).
--
-- The ≤1-active invariant is a MySQL UNIQUE(user_id, active_flag): active_flag is
-- 1 on the active row and NULL on archived rows (MySQL unique indexes do not
-- collide on NULL), so an athlete may have many archived rows but only one
-- active. active_flag is app-managed in lockstep with status.
--
-- Column contract:
--   goal_id               UUID4 (legacy slug goal_ids are re-minted at migration)
--   user_id               app-level UUID (JWT sub) — same id space as user_profile
--   status                'active' | 'archived'
--   active_flag           1 on the active row, NULL on archived rows
--   race_date             ISO YYYY-MM-DD race day (calendar date, never tz-converted)
--   race_distance         e.g. 'FM' | 'HM' | '10K'
--   race_name             display name; NULL when absent
--   target_finish_time    'H:MM:SS'; NULL when absent
--   weekly_training_days  planned training days per week
--   available_time_slots  JSON array text of slot labels, e.g. '[]' or '["morning"]'
--   strength_willingness  NULL | 'low' | 'medium' | 'high'
--   race_location         downstream MasterPlanGoal location; NULL (not in Python blob)
--   race_timezone         race-local IANA zone; NULL (not in Python blob)
--   created_at            first-write time (carried from the blob); updated_at last write

CREATE TABLE IF NOT EXISTS race_goal (
  goal_id              VARCHAR(36)  NOT NULL,
  user_id              VARCHAR(64)  NOT NULL,
  status               VARCHAR(16)  NOT NULL,
  active_flag          TINYINT      NULL,
  race_date            VARCHAR(10)  NOT NULL,
  race_distance        VARCHAR(16)  NOT NULL,
  race_name            VARCHAR(255) NULL,
  target_finish_time   VARCHAR(16)  NULL,
  weekly_training_days BIGINT       NOT NULL,
  available_time_slots LONGTEXT     NULL,
  strength_willingness VARCHAR(16)  NULL,
  race_location        VARCHAR(255) NULL,
  race_timezone        VARCHAR(64)  NULL,
  created_at           DATETIME(3)  NULL,
  updated_at           DATETIME(3)  NULL,
  PRIMARY KEY (goal_id),
  UNIQUE KEY uidx_race_goal_active (user_id, active_flag)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- master_plan — the athlete's overall season training plan (赛季训练计划), target
-- for the master-plan migration (src/migrate-master-plans.js). One logical
-- artifact stored in two content formats discriminated by content_version
-- (ADR 0024): 1 = legacy markdown overview (content is the markdown text),
-- 2 = structured plan (content is the MasterPlan JSON blob, kept opaque here).
--
-- Equivalent to the Go GORM model src/go/internal/storage/master_plan_models.go
-- (MasterPlan), created in prod by the cmd/api boot AutoMigrateMasterPlan. The
-- DDL below is byte-for-byte SHOW CREATE TABLE of that AutoMigrate output:
-- `int8` -> TINYINT, `int64` -> BIGINT, `string type:longtext` -> LONGTEXT,
-- time.Time -> DATETIME(3) (GORM default precision).
--
-- active_flag is a STORAGE-INTEGRITY LEVER ONLY (never business logic, never in
-- the API): a nullable-unique UNIQUE(user_id, active_flag) enforces at most one
-- active plan per athlete across BOTH formats — 1 on the active row, NULL on
-- draft/archived (MySQL unique indexes do not collide on NULL). A markdown row is
-- modelled as active (status='active', active_flag=1).
--
-- Column contract:
--   plan_id          v2: MasterPlan.plan_id (uuid4); v1: minted uuid4
--   user_id          app-level UUID (JWT sub) — same id space as race_goal
--   content_version  1 = markdown, 2 = structured MasterPlan JSON
--   content          v1: markdown text; v2: MasterPlan JSON string (verbatim)
--   goal_id          soft reference to race_goal.goal_id (no FK); NOT NULL
--   status           draft | active | archived (markdown = active)
--   active_flag      1 on the active row, NULL otherwise (constraint lever only)
--   revision         structured plan revision (v2 only); NULL for markdown
--   created_at       first-write time carried from the source; updated_at last

CREATE TABLE IF NOT EXISTS master_plan (
  plan_id         VARCHAR(36)  NOT NULL,
  user_id         VARCHAR(64)  NOT NULL,
  content_version TINYINT      NOT NULL,
  content         LONGTEXT     NOT NULL,
  goal_id         VARCHAR(36)  NOT NULL,
  status          VARCHAR(16)  NOT NULL,
  active_flag     TINYINT      NULL,
  revision        BIGINT       NULL,
  created_at      DATETIME(3)  NULL,
  updated_at      DATETIME(3)  NULL,
  PRIMARY KEY (plan_id),
  UNIQUE KEY uidx_master_plan_active (user_id, active_flag),
  KEY idx_master_plan_goal (goal_id),
  CONSTRAINT ck_master_plan_content_version CHECK (content_version IN (1, 2)),
  CONSTRAINT ck_master_plan_revision CHECK (
    (content_version = 1 AND revision IS NULL) OR
    (content_version = 2 AND revision >= 1)
  ),
  CONSTRAINT ck_master_plan_current_marker CHECK (
    (status = 'active' AND active_flag = 1) OR
    (status <> 'active' AND active_flag IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- weekly_plan — one content-versioned row per athlete/week/lifecycle slot
-- (ADR 0025), target for src/migrate-weekly-plans.js. content_version=1 stores
-- non-empty legacy Markdown; content_version=2 stores validated structured JSON.
-- status_slot is an integrity lever: MySQL's nullable unique key permits many
-- archived rows while enforcing at most one active and one draft per week.

CREATE TABLE IF NOT EXISTS weekly_plan (
  plan_id         VARCHAR(36) NOT NULL,
  user_id         VARCHAR(64) NOT NULL,
  master_plan_id  VARCHAR(36) NULL,
  week_start      DATE        NOT NULL,
  content_version TINYINT     NOT NULL,
  content         LONGTEXT    NOT NULL,
  status          VARCHAR(16) NOT NULL,
  status_slot     VARCHAR(8)  NULL,
  revision        BIGINT      NOT NULL,
  created_at      DATETIME(3) NOT NULL,
  updated_at      DATETIME(3) NOT NULL,
  PRIMARY KEY (plan_id),
  UNIQUE KEY uidx_weekly_plan_status_slot (user_id, week_start, status_slot),
  KEY idx_weekly_plan_master_plan (master_plan_id),
  CONSTRAINT ck_weekly_plan_content_version CHECK (content_version IN (1, 2)),
  CONSTRAINT ck_weekly_plan_json CHECK (content_version = 1 OR JSON_VALID(content)),
  CONSTRAINT ck_weekly_plan_status CHECK (status IN ('draft', 'active', 'archived')),
  CONSTRAINT ck_weekly_plan_status_slot_v2 CHECK (
    (status IN ('active', 'draft') AND status_slot IS NOT NULL AND status_slot = status) OR
    (status = 'archived' AND status_slot IS NULL)
  ),
  CONSTRAINT ck_weekly_plan_revision CHECK (revision >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
