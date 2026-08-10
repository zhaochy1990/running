package storage

import "time"

// InjuryRecord is a user-owned injury/recovery record. Timestamps are UTC
// instants; the authenticated user UUID is the tenant boundary for every read
// and mutation.
type InjuryRecord struct {
	ID                 string    `gorm:"column:id;type:char(36);primaryKey"`
	UserID             string    `gorm:"column:user_id;type:char(36);not null;index:idx_user_injuries_order,priority:1"`
	Description        string    `gorm:"column:description;type:varchar(1000);not null"`
	RecoveryStatus     string    `gorm:"column:recovery_status;type:varchar(16);not null;index:idx_user_injuries_order,priority:2"`
	RunningRestriction string    `gorm:"column:running_restriction;type:varchar(16);not null"`
	CreatedAt          time.Time `gorm:"column:created_at;type:datetime(6);autoCreateTime:false"`
	UpdatedAt          time.Time `gorm:"column:updated_at;type:datetime(6);autoUpdateTime:false;index:idx_user_injuries_order,priority:3"`
}

func (InjuryRecord) TableName() string { return "user_injury" }

const (
	InjuryRecoveryActive    = "active"
	InjuryRecoveryRecovered = "recovered"

	RunningRestrictionNone      = "none"
	RunningRestrictionEasyOnly  = "easy_only"
	RunningRestrictionNoRunning = "no_running"
)
