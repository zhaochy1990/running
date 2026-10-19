// workout.go — the unified workout store (devops#586): DDL with the generated
// identity_key column, the weekly-plan materialization helper shared by the
// apply transaction, and the custom-workout CRUD the /me endpoints need.
package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// AutoMigrateWorkout creates/updates the workout table. GORM AutoMigrate has no
// generated-column support, so identity_key + UNIQUE(user_id, identity_key) are
// added via DDL guarded by information_schema checks (idempotent).
func (s *Store) AutoMigrateWorkout(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(&Workout{}); err != nil {
		return fmt.Errorf("storage: automigrate workout: %w", err)
	}
	db := s.db.WithContext(ctx)
	var n int64
	if err := db.Raw(`SELECT COUNT(*) FROM information_schema.COLUMNS
		WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workout' AND COLUMN_NAME = 'identity_key'`).
		Scan(&n).Error; err != nil {
		return fmt.Errorf("storage: check workout.identity_key: %w", err)
	}
	if n == 0 {
		// Generated only for active rows, so archived rows never block a new
		// row with the same lineage (NULLs are distinct in MySQL unique indexes).
		if err := db.Exec(`ALTER TABLE workout ADD COLUMN identity_key VARCHAR(191)
			GENERATED ALWAYS AS (
				CASE WHEN status = 'active' THEN
					CASE source
						WHEN 'weekly' THEN CONCAT('weekly:', plan_id, ':', date, ':', session_index)
						WHEN 'custom' THEN CONCAT('custom:', save_token)
						WHEN 'watch' THEN CONCAT('watch:', provider, ':', provider_entity_id)
					END
				END
			) STORED`).Error; err != nil {
			return fmt.Errorf("storage: add workout.identity_key: %w", err)
		}
	}
	n = 0
	if err := db.Raw(`SELECT COUNT(DISTINCT INDEX_NAME) FROM information_schema.STATISTICS
		WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workout' AND INDEX_NAME = 'uidx_workout_identity'`).
		Scan(&n).Error; err != nil {
		return fmt.Errorf("storage: check workout identity index: %w", err)
	}
	if n == 0 {
		if err := db.Exec(`ALTER TABLE workout ADD UNIQUE KEY uidx_workout_identity (user_id, identity_key)`).Error; err != nil {
			return fmt.Errorf("storage: add workout identity unique key: %w", err)
		}
	}
	return nil
}

// weeklyPlanWorkoutContent is the minimal projection of the applied weekly-plan
// JSON the materializer needs (sessions only; the rest stays opaque).
type weeklyPlanWorkoutContent struct {
	Sessions []struct {
		Date           string          `json:"date"`
		SessionIndex   int             `json:"session_index"`
		Kind           string          `json:"kind"`
		Summary        string          `json:"summary"`
		Spec           json.RawMessage `json:"spec"`
		TotalDistanceM *float64        `json:"total_distance_m"`
		TotalDurationS *int64          `json:"total_duration_s"`
		EstimatedDose  *float64        `json:"estimated_dose"`
	} `json:"sessions"`
}

// materializeWeeklyWorkouts archives the user's active weekly workout rows in
// the week window and inserts one workout row per plan session (#523: rows are
// immutable, a re-apply archives + inserts fresh workout_ids; master-plan
// generation changes never cascade here). planID is the applied weekly plan's
// id — the row being created in the same transaction. Must run inside that
// transaction so plan and workouts commit atomically.
func materializeWeeklyWorkouts(tx *gorm.DB, uid, planID, weekStart, content string) error {
	var parsed weeklyPlanWorkoutContent
	if err := json.Unmarshal([]byte(content), &parsed); err != nil {
		return fmt.Errorf("storage: parse weekly plan content for materialization: %w", err)
	}
	start, err := time.Parse("2006-01-02", weekStart)
	if err != nil {
		return fmt.Errorf("storage: materialize invalid week_start: %w", err)
	}
	weekEnd := start.AddDate(0, 0, 6).Format("2006-01-02")
	if err := tx.Model(&Workout{}).
		Where("user_id = ? AND source = ? AND status = ? AND date BETWEEN ? AND ?",
			uid, WorkoutSourceWeekly, WorkoutStatusActive, weekStart, weekEnd).
		Update("status", WorkoutStatusArchived).Error; err != nil {
		return fmt.Errorf("storage: archive prior weekly workouts: %w", err)
	}
	if len(parsed.Sessions) == 0 {
		return nil
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	rows := make([]Workout, 0, len(parsed.Sessions))
	for i := range parsed.Sessions {
		session := &parsed.Sessions[i]
		if _, err := time.Parse("2006-01-02", session.Date); err != nil {
			return fmt.Errorf("storage: materialize session date %q: %w", session.Date, err)
		}
		spec := string(session.Spec)
		if session.Spec == nil || spec == "null" {
			spec = ""
		}
		// Session name: the spec's own name when present, else the summary.
		name := session.Summary
		if spec != "" {
			var named struct {
				Name string `json:"name"`
			}
			if err := json.Unmarshal(session.Spec, &named); err != nil {
				return fmt.Errorf("storage: parse session spec for materialization: %w", err)
			}
			if named.Name != "" {
				name = named.Name
			}
		}
		var summaryPtr, specPtr *string
		if session.Summary != "" {
			summary := session.Summary
			summaryPtr = &summary
		}
		if spec != "" {
			specPtr = &spec
		}
		sessionIndex := session.SessionIndex
		rows = append(rows, Workout{
			WorkoutID: uuid.NewString(), UserID: uid, Date: session.Date,
			Source: WorkoutSourceWeekly, Kind: session.Kind, Name: name,
			Summary: summaryPtr, SpecJSON: specPtr,
			TotalDistanceM: session.TotalDistanceM, TotalDurationS: session.TotalDurationS,
			EstimatedDose: session.EstimatedDose,
			Status:        WorkoutStatusActive,
			PlanID:        stringPtr2(planID), SessionIndex: &sessionIndex,
			CreatedAt: now, UpdatedAt: now,
		})
	}
	if err := tx.Create(&rows).Error; err != nil {
		return fmt.Errorf("storage: insert weekly workouts: %w", err)
	}
	return nil
}

// workoutReadOrder is the stable projection order: weekly → custom → watch
// (devops#525), same-source by session index then creation time.
const workoutReadOrder = `date ASC,
	FIELD(source, 'weekly', 'custom', 'watch') ASC,
	COALESCE(session_index, 0) ASC,
	created_at ASC`

// ListPlanSessions is the unified「某天要练什么」projection: every active
// workout row (weekly + custom + watch) in the inclusive Shanghai date window,
// past days included — a pure projection, no lifecycle filtering.
func (s *Store) ListPlanSessions(ctx context.Context, userID, dateFrom, dateTo string) ([]Workout, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	if _, err := time.Parse("2006-01-02", dateFrom); err != nil {
		return nil, fmt.Errorf("storage: invalid date_from: %w", err)
	}
	if _, err := time.Parse("2006-01-02", dateTo); err != nil {
		return nil, fmt.Errorf("storage: invalid date_to: %w", err)
	}
	var rows []Workout
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND status = ? AND date BETWEEN ? AND ?", uid, WorkoutStatusActive, dateFrom, dateTo).
		Order(workoutReadOrder).
		Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("storage: list plan sessions: %w", err)
	}
	return rows, nil
}

// UpsertCustomWorkoutInput carries one user-authored workout. SaveToken is the
// idempotency key: replaying it updates the existing active row in place
// (same workout_id); a fresh token inserts a fresh row.
type UpsertCustomWorkoutInput struct {
	Date           string
	Kind           string
	Name           string
	Summary        *string
	SpecJSON       *string
	TotalDistanceM *float64
	TotalDurationS *int64
	EstimatedDose  *float64
	SaveToken      string
}

// UpsertCustomWorkout inserts the custom workout, or — when the user already
// has an active row with the same save_token (uidx_workout_identity) — updates
// that row in place and returns it.
func (s *Store) UpsertCustomWorkout(ctx context.Context, userID string, in UpsertCustomWorkoutInput) (*Workout, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	if _, err := time.Parse("2006-01-02", in.Date); err != nil {
		return nil, fmt.Errorf("storage: invalid date: %w", err)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	row := &Workout{
		WorkoutID: uuid.NewString(), UserID: uid, Date: in.Date,
		Source: WorkoutSourceCustom, Kind: in.Kind, Name: in.Name,
		Summary: in.Summary, SpecJSON: in.SpecJSON,
		TotalDistanceM: in.TotalDistanceM, TotalDurationS: in.TotalDurationS,
		EstimatedDose: in.EstimatedDose,
		Status:        WorkoutStatusActive,
		SaveToken:     stringPtr2(in.SaveToken),
		CreatedAt:     now, UpdatedAt: now,
	}
	if err := s.db.WithContext(ctx).
		Clauses(clause.OnConflict{DoUpdates: clause.AssignmentColumns([]string{
			"date", "kind", "name", "summary", "spec_json",
			"total_distance_m", "total_duration_s", "estimated_dose", "updated_at",
		})}).
		Create(row).Error; err != nil {
		return nil, fmt.Errorf("storage: upsert custom workout: %w", err)
	}
	// ON DUPLICATE KEY UPDATE keeps the stored row (and its workout_id); reload
	// it so the caller sees the durable state rather than the insert attempt.
	// Fresh dest: First would otherwise reuse row's set primary key as a WHERE.
	var stored Workout
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND source = ? AND status = ? AND save_token = ?",
			uid, WorkoutSourceCustom, WorkoutStatusActive, in.SaveToken).
		First(&stored).Error; err != nil {
		return nil, fmt.Errorf("storage: reload custom workout: %w", err)
	}
	return &stored, nil
}

// WatchWorkoutInput carries one pulled watch-schedule session (devops#588).
// (Provider, EntityID) is the idempotency key (identity_key "watch:provider:entity").
type WatchWorkoutInput struct {
	Provider string
	EntityID string
	Date     string // ISO YYYY-MM-DD Shanghai-local calendar day
	Kind     string // watch-schedule/v1 models run only
	Name     string
	SpecJSON string // canonical run-workout/v1 document
}

// UpsertWatchWorkouts persists pulled watch sessions into the unified workout
// table (source=watch) and archives out-of-window watch rows, in one
// transaction. Each row is upserted idempotently on uidx_workout_identity
// ("watch:provider:entity"): a re-pull updates date/kind/name/spec in place
// (same workout_id); a row archived earlier re-inserts fresh (identity_key is
// NULL while archived, so MySQL's unique index never blocks the reuse).
// The window cleanup archives active watch rows whose date left the pull
// window [windowFrom, windowTo] — scoped by source=watch so weekly / custom
// rows are never touched (devops#588).
func (s *Store) UpsertWatchWorkouts(ctx context.Context, userID string, rows []WatchWorkoutInput, windowFrom, windowTo string) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	if _, err := time.Parse("2006-01-02", windowFrom); err != nil {
		return fmt.Errorf("storage: invalid window_from: %w", err)
	}
	if _, err := time.Parse("2006-01-02", windowTo); err != nil {
		return fmt.Errorf("storage: invalid window_to: %w", err)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for i := range rows {
			in := &rows[i]
			if in.Provider == "" || in.EntityID == "" {
				return fmt.Errorf("storage: watch workout %d missing provider/entity id", i)
			}
			if _, err := time.Parse("2006-01-02", in.Date); err != nil {
				return fmt.Errorf("storage: invalid watch workout date %q: %w", in.Date, err)
			}
			spec := in.SpecJSON
			row := &Workout{
				WorkoutID: uuid.NewString(), UserID: uid, Date: in.Date,
				Source: WorkoutSourceWatch, Kind: in.Kind, Name: in.Name,
				SpecJSON: &spec,
				Status:   WorkoutStatusActive,
				Provider: stringPtr2(in.Provider), ProviderEntityID: stringPtr2(in.EntityID),
				CreatedAt: now, UpdatedAt: now,
			}
			// ON DUPLICATE KEY UPDATE fires on uidx_workout_identity (the fresh
			// workout_id PK can never collide). Totals/dose stay NULL: watch rows
			// carry no totals until a pipeline computes one (devops#526/588).
			if err := tx.Clauses(clause.OnConflict{
				DoUpdates: clause.AssignmentColumns([]string{"date", "kind", "name", "spec_json", "updated_at"}),
			}).Create(row).Error; err != nil {
				return fmt.Errorf("storage: upsert watch workout: %w", err)
			}
		}
		if err := tx.Model(&Workout{}).
			Where("user_id = ? AND source = ? AND status = ? AND (date < ? OR date > ?)",
				uid, WorkoutSourceWatch, WorkoutStatusActive, windowFrom, windowTo).
			Update("status", WorkoutStatusArchived).Error; err != nil {
			return fmt.Errorf("storage: archive out-of-window watch workouts: %w", err)
		}
		return nil
	})
}

// ListCustomWorkouts returns the user's active custom workouts in the window,
// same ordering discipline as the unified read.
func (s *Store) ListCustomWorkouts(ctx context.Context, userID, dateFrom, dateTo string) ([]Workout, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	if _, err := time.Parse("2006-01-02", dateFrom); err != nil {
		return nil, fmt.Errorf("storage: invalid date_from: %w", err)
	}
	if _, err := time.Parse("2006-01-02", dateTo); err != nil {
		return nil, fmt.Errorf("storage: invalid date_to: %w", err)
	}
	var rows []Workout
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND source = ? AND status = ? AND date BETWEEN ? AND ?",
			uid, WorkoutSourceCustom, WorkoutStatusActive, dateFrom, dateTo).
		Order(workoutReadOrder).
		Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("storage: list custom workouts: %w", err)
	}
	return rows, nil
}

// ArchiveCustomWorkout soft-deletes the user's active custom workout (the only
// delete semantics the workout table has). Returns false when the id does not
// exist, is not the caller's, or is already archived.
func (s *Store) ArchiveCustomWorkout(ctx context.Context, userID, workoutID string) (bool, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return false, err
	}
	result := s.db.WithContext(ctx).Model(&Workout{}).
		Where("workout_id = ? AND user_id = ? AND source = ? AND status = ?",
			workoutID, uid, WorkoutSourceCustom, WorkoutStatusActive).
		Update("status", WorkoutStatusArchived)
	if result.Error != nil {
		return false, fmt.Errorf("storage: archive custom workout: %w", result.Error)
	}
	return result.RowsAffected > 0, nil
}
