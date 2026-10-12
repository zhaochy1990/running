// provider_event.go backs the watch-provider event-push receiver (devops#287):
// provider_events is the authoritative record of every push the receiver
// accepted — the raw body verbatim plus the resolved identity — and the point
// the queued fetch job reads its payload from. It deliberately carries no
// consumption state: the queue job row owns processing status, the event row
// owns what was pushed (audit + replay source).
package storage

import (
	"context"
	"fmt"
	"time"
)

// ProviderEvent is one pushed provider activity summary (table
// "provider_events"). Identity is (provider, provider_activity_id) — COROS
// (labelId) — enforced by a unique index so a provider's duplicate push can
// never create a second row. Nullable columns are pointers so a missing value
// stays NULL, never 0/"".
type ProviderEvent struct {
	// ID is the surrogate primary key the provider_activity_fetch job's input
	// references ({"event_id": ID}).
	ID uint64 `gorm:"column:id;type:bigint unsigned;primaryKey;autoIncrement"`

	Provider           string `gorm:"column:provider;type:varchar(32);not null;uniqueIndex:uq_provider_events_activity,priority:1"`
	ProviderUserID     string `gorm:"column:provider_user_id;type:varchar(128);not null"`
	ProviderActivityID string `gorm:"column:provider_activity_id;type:varchar(128);not null;uniqueIndex:uq_provider_events_activity,priority:2"`
	// EventType is activity.create (COROS 5.3 has no event-type field).
	EventType string `gorm:"column:event_type;type:varchar(64);not null"`
	// PlanWorkoutID is the COROS planWorkoutId we pushed via 6.1; NULL when
	// the activity is not from a pushed plan workout.
	PlanWorkoutID *string `gorm:"column:plan_workout_id;type:varchar(128)"`
	// FitURL is the top-level .fit download URL; NULL for multisport pushes,
	// whose FIT urls live on the triathlonItemList children inside RawPayload.
	FitURL *string `gorm:"column:fit_url;type:varchar(1024)"`
	// OccurTime is the activity end time (COROS endTime), UTC. The 15-minute
	// timezone integers stay in RawPayload unconverted.
	OccurTime time.Time `gorm:"column:occur_time;type:datetime(3);not null"`
	// ReceivedAt is when STRIDE accepted the push, UTC.
	ReceivedAt time.Time `gorm:"column:received_at;type:datetime(3);not null"`
	// UserID is the STRIDE user resolved from the provider account at receive
	// time; NULL when unbound (or resolution not yet wired) — such events are
	// recorded for audit but never enqueue a fetch.
	UserID *string `gorm:"column:user_id;type:char(36)"`
	// RawPayload is the entire push request body, byte-for-byte. mediumblob
	// (16 MiB), not blob: the route admits bodies up to 1 MiB and a batch push
	// of a hundred workouts already overruns blob's 64 KiB cap.
	RawPayload []byte `gorm:"column:raw_payload;type:mediumblob;not null"`
}

// TableName pins the MySQL table name.
func (ProviderEvent) TableName() string { return "provider_events" }

// AutoMigrateProviderEvents creates/updates the provider_events table. Called
// by cmd/api (the only writer); the fetch handler's migration lands with it.
func (s *Store) AutoMigrateProviderEvents(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(&ProviderEvent{}); err != nil {
		return fmt.Errorf("storage: automigrate provider_events: %w", err)
	}
	return nil
}

// CreateProviderEvent inserts one push event and reports whether a new row
// was created. A push whose (provider, provider_activity_id) is already
// recorded reports created=false — the unique index IS the idempotency rule
// (devops#287), not an application-level read-then-write — and back-fills
// ev.ID with the existing row's id, so the caller can still reference the
// event when it retries the enqueue a duplicate push must heal.
func (s *Store) CreateProviderEvent(ctx context.Context, ev *ProviderEvent) (bool, error) {
	err := s.db.WithContext(ctx).Create(ev).Error
	if isDuplicateKey(err) {
		var existingID uint64
		if err := s.db.WithContext(ctx).
			Model(&ProviderEvent{}).
			Where("provider = ? AND provider_activity_id = ?", ev.Provider, ev.ProviderActivityID).
			Select("id").Scan(&existingID).Error; err != nil {
			return false, err
		}
		ev.ID = existingID
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}
