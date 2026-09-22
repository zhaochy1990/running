// watch_schedule.go adds the watch-schedule pull domain to Store: the
// watch_schedule table (ADR 0038) plus an idempotent upsert keyed on the
// provider source ids (provider + entity_id) that ADR 0036 fixed on every
// session.
package storage

import (
	"context"
	"fmt"
	"time"

	"gorm.io/gorm/clause"
)

// WatchSchedule is one pulled watch-schedule session (table "watch_schedule").
// It is the watch domain's calendar mirror — distinct from ScheduledWorkout,
// which records the push-side execution state of coach-authored plan sessions.
//
// The unique (user_id, provider, entity_id) index is the idempotency key: a
// re-pull of the same watch session updates the row rather than duplicating it.
// SpecJSON carries the full run-workout/v1 document (run content only; strength
// is skipped by the puller and counted in sync metadata).
type WatchSchedule struct {
	ID         uint64    `gorm:"column:id;primaryKey;autoIncrement"`
	UserID     string    `gorm:"column:user_id;type:char(36);not null;uniqueIndex:uq_watch_schedule_source,priority:1"`
	Provider   string    `gorm:"column:provider;type:varchar(32);not null;uniqueIndex:uq_watch_schedule_source,priority:2"`
	EntityID   string    `gorm:"column:entity_id;type:varchar(191);not null;uniqueIndex:uq_watch_schedule_source,priority:3"`
	Date       string    `gorm:"column:date;type:varchar(10);not null;index:idx_watch_schedule_date"`
	Kind       string    `gorm:"column:kind;type:varchar(16);not null"`
	Name       string    `gorm:"column:name;type:varchar(255);not null"`
	SpecJSON   string    `gorm:"column:spec_json;type:longtext;not null"`
	FetchedAt  time.Time `gorm:"column:fetched_at;type:datetime(6);not null"`
	WindowFrom string    `gorm:"column:window_from;type:varchar(10)"`
	WindowTo   string    `gorm:"column:window_to;type:varchar(10)"`
	CreatedAt  time.Time `gorm:"column:created_at;type:datetime(6);not null"`
	UpdatedAt  time.Time `gorm:"column:updated_at;type:datetime(6);not null"`
}

func (WatchSchedule) TableName() string { return "watch_schedule" }

// UpsertWatchSchedules writes pulled watch-schedule sessions idempotently, keyed
// on (user_id, provider, entity_id). A re-pull updates date/kind/name/spec and
// the fetch metadata without creating duplicate rows. The caller's user id is
// canonicalised and stamped onto every row so the tenant key cannot drift.
func (s *Store) UpsertWatchSchedules(ctx context.Context, userID string, rows []WatchSchedule) error {
	if len(rows) == 0 {
		return nil
	}
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	for i := range rows {
		rows[i].UserID = uid
		if rows[i].CreatedAt.IsZero() {
			rows[i].CreatedAt = now
		}
		rows[i].UpdatedAt = now
	}
	err = s.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "user_id"}, {Name: "provider"}, {Name: "entity_id"}},
		DoUpdates: clause.AssignmentColumns([]string{"date", "kind", "name", "spec_json", "fetched_at", "window_from", "window_to", "updated_at"}),
	}).Create(&rows).Error
	if err != nil {
		return fmt.Errorf("storage: upsert watch schedule: %w", err)
	}
	return nil
}
