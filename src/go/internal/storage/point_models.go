package storage

import "time"

// PointTransaction is one append-only ledger row (devops#848 resolution): it is
// only ever INSERTed, never UPDATEd or DELETEd. There is deliberately no
// balance_after column — the balance truth lives in user_points, and a
// reconciliation script can be added later without a schema change.
type PointTransaction struct {
	ID string `gorm:"column:id;type:char(36);primaryKey;index:idx_user_points_order,priority:2,sort:desc"`
	// UserID + id DESC is the ledger page index: cursor pagination walks one
	// user's newest-first stream on a single secondary index.
	UserID    string    `gorm:"column:user_id;type:char(36);not null;index:idx_user_points_order,priority:1"`
	Type      string    `gorm:"column:type;type:varchar(16);not null"`
	Amount    int       `gorm:"column:amount;not null"` // positive earn, negative redeem
	Ref       string    `gorm:"column:ref;type:varchar(64);not null"`
	Remark    *string   `gorm:"column:remark;type:varchar(255)"`
	CreatedAt time.Time `gorm:"column:created_at;type:datetime(6);autoCreateTime:false"`
}

func (PointTransaction) TableName() string { return "point_transactions" }

// Transaction types. earn_checkin and redeem are produced by V1; expire and
// adjust are reserved enum slots — expire stays unused because points never
// expire (#847 resolution), adjust awaits an operations entry point.
const (
	PointTypeEarnCheckin = "earn_checkin"
	PointTypeRedeem      = "redeem"
	PointTypeExpire      = "expire" // reserved, V1 never produces it
	PointTypeAdjust      = "adjust" // reserved, V1 never produces it
)

// UserPoint is the materialized per-user balance. Updates go through the
// atomic upsert (INSERT ... ON DUPLICATE KEY UPDATE balance = balance + ?),
// so concurrent earns need no explicit lock (#848 resolution).
type UserPoint struct {
	UserID    string    `gorm:"column:user_id;type:char(36);primaryKey"`
	Balance   int       `gorm:"column:balance;not null;default:0"`
	UpdatedAt time.Time `gorm:"column:updated_at;type:datetime(6);autoUpdateTime:false"`
}

func (UserPoint) TableName() string { return "user_points" }
