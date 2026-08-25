// scheduled_workout.go adds the device execution-state layer to Store: the
// MySQL scheduled_workout table (Go port of the Python SQLite schema, with a
// user_id column for tenant isolation) plus the two methods the push API needs
// — read the latest row for one canonical plan session, and atomically record a
// successful push while superseding its prior row.
package storage

import (
	"context"
	"fmt"
	"time"

	"gorm.io/gorm"
)

// ScheduledWorkoutStatus values (lifecycle mirrors Python: draft → pushed →
// completed | skipped; re-push supersedes the prior pushed row).
const (
	ScheduledWorkoutStatusDraft      = "draft"
	ScheduledWorkoutStatusPushed     = "pushed"
	ScheduledWorkoutStatusCompleted  = "completed"
	ScheduledWorkoutStatusSkipped    = "skipped"
	ScheduledWorkoutStatusSuperseded = "superseded"
)

// ScheduledWorkout is one provider-agnostic workout scheduled on the watch.
// SpecJSON carries the normalized workout (run-workout/v1 or
// strength-workout/v1) — the same payload the push pipeline consumed.
// WeekFolder/PlannedDate/SessionIndex form the canonical plan identity so a
// re-push of the same session supersedes (not duplicates) the prior row.
type ScheduledWorkout struct {
	ID                int64      `gorm:"column:id;primaryKey;autoIncrement"`
	UserID            string     `gorm:"column:user_id;size:64;not null;index:idx_scheduled_workout_user"`
	Date              string     `gorm:"column:date;size:10;not null;index:idx_scheduled_workout_date"`
	Kind              string     `gorm:"column:kind;size:16;not null"`
	Name              string     `gorm:"column:name;size:255;not null"`
	SpecJSON          string     `gorm:"column:spec_json;type:longtext;not null"`
	Status            string     `gorm:"column:status;size:16;not null;default:draft"`
	Provider          *string    `gorm:"column:provider;size:16"`
	ProviderWorkoutID *string    `gorm:"column:provider_workout_id;size:64"`
	PushedAt          *time.Time `gorm:"column:pushed_at;type:datetime(3)"`
	CompletedLabelID  *string    `gorm:"column:completed_label_id;size:64"`
	Note              *string    `gorm:"column:note;size:1000"`
	// Canonical plan identity (week_start of the plan's Shanghai week).
	WeekFolder   *string   `gorm:"column:week_folder;size:16;index:idx_scheduled_workout_plan_session,priority:1"`
	PlannedDate  *string   `gorm:"column:planned_date;size:10;index:idx_scheduled_workout_plan_session,priority:2"`
	SessionIndex *int      `gorm:"column:session_index;index:idx_scheduled_workout_plan_session,priority:3"`
	CreatedAt    time.Time `gorm:"column:created_at;type:datetime(3);not null"`
	UpdatedAt    time.Time `gorm:"column:updated_at;type:datetime(3);not null"`
}

func (ScheduledWorkout) TableName() string { return "scheduled_workout" }

// AutoMigrateScheduledWorkout creates/updates the scheduled_workout table.
func (s *Store) AutoMigrateScheduledWorkout(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(&ScheduledWorkout{}); err != nil {
		return fmt.Errorf("storage: automigrate scheduled_workout: %w", err)
	}
	return nil
}

// GetLatestScheduledWorkoutForPlanSession returns the most recent execution
// row for one canonical plan session (any status), or nil when none exists.
func (s *Store) GetLatestScheduledWorkoutForPlanSession(
	ctx context.Context, userID, weekFolder, plannedDate string, sessionIndex int,
) (*ScheduledWorkout, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var row ScheduledWorkout
	err = s.db.WithContext(ctx).
		Where("user_id = ? AND week_folder = ? AND planned_date = ? AND session_index = ?",
			uid, weekFolder, plannedDate, sessionIndex).
		Order("id DESC").
		First(&row).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("storage: get latest scheduled workout: %w", err)
	}
	return &row, nil
}

// RecordPushedWorkoutInput carries the fields for a successful push record.
type RecordPushedWorkoutInput struct {
	WeekFolder        string // plan week_start of the session's week
	PlannedDate       string // canonical session date
	SessionIndex      int    // canonical session index
	PushDate          string // date the workout landed on the watch
	Kind              string // run | strength
	Name              string // workout name (carries [STRIDE] prefix)
	SpecJSON          string // normalized workout JSON
	Provider          string // provider name (coros | garmin)
	ProviderWorkoutID string // watch-side id
	PriorID           *int64 // prior pushed row to supersede, if any
}

// RecordPushedScheduledWorkout atomically inserts a status='pushed' row for a
// successful watch push and supersedes the prior pushed row for the same
// canonical session (when PriorID is set). Returns the new row id.
func (s *Store) RecordPushedScheduledWorkout(
	ctx context.Context, userID string, in RecordPushedWorkoutInput,
) (int64, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return 0, err
	}
	now := time.Now().UTC()
	row := ScheduledWorkout{
		UserID:            uid,
		Date:              in.PushDate,
		Kind:              in.Kind,
		Name:              in.Name,
		SpecJSON:          in.SpecJSON,
		Status:            ScheduledWorkoutStatusPushed,
		Provider:          stringPtr2(in.Provider),
		ProviderWorkoutID: stringPtr2(in.ProviderWorkoutID),
		PushedAt:          &now,
		WeekFolder:        stringPtr2(in.WeekFolder),
		PlannedDate:       stringPtr2(in.PlannedDate),
		SessionIndex:      intPtr2(in.SessionIndex),
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&row).Error; err != nil {
			return fmt.Errorf("storage: insert scheduled workout: %w", err)
		}
		if in.PriorID != nil {
			if err := tx.Model(&ScheduledWorkout{}).
				Where("id = ? AND status = ?", *in.PriorID, ScheduledWorkoutStatusPushed).
				Update("status", ScheduledWorkoutStatusSuperseded).
				Error; err != nil {
				return fmt.Errorf("storage: supersede prior scheduled workout: %w", err)
			}
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return row.ID, nil
}

func stringPtr2(s string) *string { return &s }

func intPtr2(i int) *int { return &i }
