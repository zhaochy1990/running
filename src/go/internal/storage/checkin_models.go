package storage

import "time"

// CheckInRecord is one natural-day check-in row — at most one per (user,
// Shanghai calendar day), enforced by uk_user_date (the idempotency anchor,
// devops#883). streak_days/cycle_position/points_earned are the at-earning-time
// snapshots (audit/replay); the authoritative streak and cycle positions are
// always derived from the date sequence (or chained from the previous day's
// snapshot) and are never rewritten back onto old rows.
type CheckInRecord struct {
	ID            string    `gorm:"column:id;type:char(36);primaryKey"`
	UserID        string    `gorm:"column:user_id;type:char(36);not null;uniqueIndex:uk_user_date,priority:1"`
	CheckInDate   time.Time `gorm:"column:check_in_date;type:date;not null;uniqueIndex:uk_user_date,priority:2"`
	StreakDays    int       `gorm:"column:streak_days;not null"`
	CyclePosition int       `gorm:"column:cycle_position;not null"`
	PointsEarned  int       `gorm:"column:points_earned;not null"`
	// Source is daily for every V1 write; make_up is reserved for a future
	// make-up check-in product decision (the extension must not change the
	// table shape, devops#848 resolution).
	Source    string    `gorm:"column:source;type:varchar(16);not null;default:daily"`
	CreatedAt time.Time `gorm:"column:created_at;type:datetime(6);autoCreateTime:false"`
}

func (CheckInRecord) TableName() string { return "check_in_records" }

const (
	CheckInSourceDaily  = "daily"
	CheckInSourceMakeUp = "make_up" // reserved, V1 never writes it
)
