package storage

import "time"

// Workout is the unified workout row (devops#586): one entity per planned /
// user-created / watch-pushed workout so「某天要练什么」is a single indexed
// query. Sources:
//
//   - weekly  — materialized from the applied weekly plan's sessions by
//     ApplyStructuredWeeklyPlan (lineage: plan_id + session_index). Rows are
//     immutable per #523: a same-week re-apply archives the old rows and
//     inserts fresh workout_ids.
//   - custom  — user-authored workouts via /api/users/me/custom-workouts
//     (lineage: save_token, idempotent upsert key).
//   - watch   — pulled watch-schedule sessions (devops#588): the coros sync's
//     schedule phase upserts them (lineage: provider + provider_entity_id,
//     window −7/+90 cleanup scoped to this source); the legacy watch_schedule
//     table is retired and no longer written.
//
// Identity: UNIQUE(user_id, identity_key) where identity_key is a MySQL
// generated column concatenated only for active rows (weekly:
// "weekly:<plan_id>:<date>:<session_index>", custom: "custom:<save_token>",
// watch: "watch:<provider>:<provider_entity_id>"). Archived rows carry a NULL
// identity and MySQL unique indexes do not collide on NULL — history stays
// queryable without blocking a new row with the same lineage. GORM
// AutoMigrate has no generated-column support, so AutoMigrateWorkout adds the
// column + unique key via DDL (see workout.go).
//
// Date is a Shanghai-local calendar day (ISO YYYY-MM-DD), never tz-converted.
type Workout struct {
	WorkoutID string `gorm:"column:workout_id;primaryKey;size:36"`
	UserID    string `gorm:"column:user_id;size:64;not null;index:idx_workout_user_date,priority:1"`
	// ISO YYYY-MM-DD string (same discipline as RaceGoal.RaceDate): a calendar
	// day has no instant, so it must never be tz-converted — and VARCHAR scans
	// back to the exact stored string (parseTime would turn DATE into time.Time).
	Date    string  `gorm:"column:date;size:10;not null;index:idx_workout_user_date,priority:2"`
	Source  string  `gorm:"column:source;size:16;not null;check:ck_workout_source,source IN ('weekly','custom','watch')"`
	Kind    string  `gorm:"column:kind;size:16;not null"`
	Name    string  `gorm:"column:name;size:255;not null"`
	Summary *string `gorm:"column:summary;size:1000"`
	// SpecJSON is the canonical normalized workout spec verbatim (discriminated
	// run-workout/v1 | strength-workout/v1, devops#584) — validated at the API
	// seam; the DB only enforces JSON validity.
	SpecJSON       *string  `gorm:"column:spec_json;type:longtext;check:ck_workout_spec_json,spec_json IS NULL OR JSON_VALID(spec_json)"`
	TotalDistanceM *float64 `gorm:"column:total_distance_m"`
	TotalDurationS *int64   `gorm:"column:total_duration_s"`
	// EstimatedDose is the #526 progressive dose: weekly rows carry the plan's
	// session estimate, custom rows the value saved at write time, watch rows
	// stay NULL until the P6 pipeline computes one.
	EstimatedDose *float64 `gorm:"column:estimated_dose"`
	SaveToken     *string  `gorm:"column:save_token;size:64;check:ck_workout_lineage_custom,source <> 'custom' OR save_token IS NOT NULL"`
	Status        string   `gorm:"column:status;size:16;not null;default:active;check:ck_workout_status,status IN ('active','archived')"`
	// Per-source lineage columns; exactly one triple is populated, enforced by
	// the ck_workout_lineage_* checks and mirrored into identity_key.
	PlanID           *string   `gorm:"column:plan_id;size:36;index:idx_workout_plan;check:ck_workout_lineage_weekly,source <> 'weekly' OR (plan_id IS NOT NULL AND session_index IS NOT NULL)"`
	SessionIndex     *int      `gorm:"column:session_index"`
	Provider         *string   `gorm:"column:provider;size:16;check:ck_workout_lineage_watch,source <> 'watch' OR (provider IS NOT NULL AND provider_entity_id IS NOT NULL)"`
	ProviderEntityID *string   `gorm:"column:provider_entity_id;size:64"`
	CreatedAt        time.Time `gorm:"column:created_at;type:datetime(3);not null;autoCreateTime:false"`
	UpdatedAt        time.Time `gorm:"column:updated_at;type:datetime(3);not null;autoUpdateTime:false"`
}

func (Workout) TableName() string { return "workout" }

// Workout source / status values.
const (
	WorkoutSourceWeekly = "weekly"
	WorkoutSourceCustom = "custom"
	WorkoutSourceWatch  = "watch"

	WorkoutStatusActive   = "active"
	WorkoutStatusArchived = "archived"
)
