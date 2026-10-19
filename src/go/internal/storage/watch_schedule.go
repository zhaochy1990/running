// watch_schedule.go keeps the legacy watch-schedule model. The table is
// RETIRED since devops#588: pulls land in the unified workout table
// (source=watch, see workout.go) and nothing writes watch_schedule anymore.
// The model stays so AutoMigrate keeps the existing table (and its data)
// intact; no reader or writer remains.
package storage

import "time"

// WatchSchedule is one pulled watch-schedule session (table "watch_schedule").
//
// Retired (devops#588): the workout table (source=watch) is the storage
// location for pulled watch sessions now. The model is kept only so the
// existing table survives AutoMigrate untouched; do not add new readers or
// writers.
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
