package storage

import "time"

// UserProfile is the athlete's onboarding identity + body metrics (ADR 0013).
// It holds ONLY the five onboarding core fields; race/training-plan goals live
// in a separate future table owned by the training-plan setup work. This is
// app-level state (not watch-synced), so it lives in its own MySQL table rather
// than the watch DB (Storage-scope rule).
//
// DOB is stored as an ISO YYYY-MM-DD string, not a time.Time: it is a plain
// Shanghai-local calendar date with no instant, so it must never undergo a
// timezone conversion.
type UserProfile struct {
	UserID      string    `gorm:"column:user_id;primaryKey;size:64"`
	DisplayName string    `gorm:"column:display_name;size:255"`
	DOB         string    `gorm:"column:dob;size:10"`
	Sex         string    `gorm:"column:sex;size:16"`
	HeightCm    float64   `gorm:"column:height_cm"`
	WeightKg    float64   `gorm:"column:weight_kg"`
	CreatedAt   time.Time `gorm:"column:created_at"`
	UpdatedAt   time.Time `gorm:"column:updated_at"`
}

// TableName pins the table name (GORM would otherwise pluralize).
func (UserProfile) TableName() string { return "user_profile" }

// UserOnboarding tracks the onboarding gate flags for a user (ADR 0013).
//
// WatchReady is the provider-agnostic "a watch data source is connected" flag —
// the rename of Python's misnamed coros_ready (Garmin login sets it too). The
// sync/pipeline-progress columns are deferred to the sync-endpoint port, so
// CompletedAt stays null in the Go flow until that lands.
type UserOnboarding struct {
	UserID       string     `gorm:"column:user_id;primaryKey;size:64"`
	WatchReady   bool       `gorm:"column:watch_ready;not null;default:false"`
	ProfileReady bool       `gorm:"column:profile_ready;not null;default:false"`
	CompletedAt  *time.Time `gorm:"column:completed_at"`
	CreatedAt    time.Time  `gorm:"column:created_at"`
	UpdatedAt    time.Time  `gorm:"column:updated_at"`
}

// TableName pins the table name.
func (UserOnboarding) TableName() string { return "user_onboarding" }
