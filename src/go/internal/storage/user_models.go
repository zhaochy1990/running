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
	UserID          string    `gorm:"column:user_id;primaryKey;size:64"`
	DisplayName     string    `gorm:"column:display_name;size:255"`
	DOB             string    `gorm:"column:dob;size:10"`
	Sex             string    `gorm:"column:sex;size:16"`
	HeightCm        float64   `gorm:"column:height_cm"`
	WeightKg        float64   `gorm:"column:weight_kg"`
	RunningAgeRange string    `gorm:"column:running_age_range;type:varchar(16);not null;default:unknown"`
	CreatedAt       time.Time `gorm:"column:created_at"`
	UpdatedAt       time.Time `gorm:"column:updated_at"`
}

// UserProfilePatch is a selective update to an existing core profile. A nil
// field is omitted; API adapters reject explicit JSON null before constructing
// this value, so each non-nil pointer always carries a valid replacement.
type UserProfilePatch struct {
	DisplayName     *string
	DOB             *string
	Sex             *string
	HeightCm        *float64
	WeightKg        *float64
	RunningAgeRange *string
}

const (
	RunningAgeUnknown = "unknown"
	RunningAgeLT6M    = "lt_6m"
	RunningAge6M1Y    = "6m_1y"
	RunningAge1Y3Y    = "1y_3y"
	RunningAge3YPlus  = "3y_plus"
)

func ValidRunningAgeRange(value string) bool {
	switch value {
	case RunningAgeUnknown, RunningAgeLT6M, RunningAge6M1Y, RunningAge1Y3Y, RunningAge3YPlus:
		return true
	default:
		return false
	}
}

// TableName pins the table name (GORM would otherwise pluralize).
func (UserProfile) TableName() string { return "user_profile" }

// UserOnboarding tracks the onboarding gate flags for a user (ADR 0013).
//
// WatchReady is the provider-agnostic "a watch data source is connected" flag —
// the rename of Python's misnamed coros_ready (Garmin login sets it too). The
// OnboardingRunID associates the user with the currently relevant onboarding
// pipeline run. Nil is the canonical no-claim value, matching the nullable
// MySQL column. While a run is being created, UpdatedAt is the durable claim
// timestamp; once present, the pipeline record remains the source of truth for
// progress.
type UserOnboarding struct {
	UserID          string     `gorm:"column:user_id;primaryKey;size:64"`
	WatchReady      bool       `gorm:"column:watch_ready;not null;default:false"`
	ProfileReady    bool       `gorm:"column:profile_ready;not null;default:false"`
	CompletedAt     *time.Time `gorm:"column:completed_at"`
	OnboardingRunID *string    `gorm:"column:onboarding_run_id;size:64"`
	CreatedAt       time.Time  `gorm:"column:created_at"`
	UpdatedAt       time.Time  `gorm:"column:updated_at"`
}

// TableName pins the table name.
func (UserOnboarding) TableName() string { return "user_onboarding" }
