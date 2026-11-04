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

// PointProduct is one redeemable physical-good item (devops#850 resolution).
// It is global content (same standing as roadmap_features): never hard-deleted,
// delisting = status inactive. The shop only ever shows active rows.
type PointProduct struct {
	ID          uint64  `gorm:"column:id;primaryKey;autoIncrement"`
	Name        string  `gorm:"column:name;type:varchar(128);not null"`
	Description *string `gorm:"column:description;type:varchar(1024)"`
	// ImageURL is a COS direct link; the upload pipeline belongs to a later ticket.
	ImageURL     *string   `gorm:"column:image_url;type:varchar(512)"`
	PointsPrice  int       `gorm:"column:points_price;not null"`
	Stock        int       `gorm:"column:stock;not null;default:0"`          // redeem-success deducts, admin restocks; only decrements in V1 (#849)
	PerUserLimit int       `gorm:"column:per_user_limit;not null;default:0"` // 0 = unlimited (#849 revision)
	Status       string    `gorm:"column:status;type:varchar(16);not null;default:active"`
	SortOrder    int       `gorm:"column:sort_order;not null;default:0"`
	CreatedAt    time.Time `gorm:"column:created_at;type:datetime(6);autoCreateTime:false"`
	UpdatedAt    time.Time `gorm:"column:updated_at;type:datetime(6);autoUpdateTime:false"`
}

func (PointProduct) TableName() string { return "point_products" }

// Product lifecycle. Delisting keeps the row (orders snapshot the name/price,
// but the product row itself is retained history too — #850 resolution).
const (
	PointProductStatusActive   = "active"
	PointProductStatusInactive = "inactive"
)

// IsPointProductStatus reports whether s is a storable product status.
func IsPointProductStatus(s string) bool {
	return s == PointProductStatusActive || s == PointProductStatusInactive
}

// PointRedemption is one redemption order (devops#850 resolution). The row is
// a historical fact: product_name/points_cost and the six receiver columns are
// snapshots taken at redeem time, immune to later product edits and address
// book changes. Two states only — pending_shipment → shipped (terminal); no
// cancel/refund/reversal exists in V1 (#849 resolution).
type PointRedemption struct {
	// ID is the public order number (the miniprogram renders it with an
	// "R-" prefix); id DESC under a user walks their newest-first order list.
	ID     string `gorm:"column:id;type:char(36);primaryKey;index:idx_point_redemptions_user,priority:2,sort:desc"`
	UserID string `gorm:"column:user_id;type:char(36);not null;index:idx_point_redemptions_user,priority:1;uniqueIndex:uk_point_redemptions_user_idem,priority:1"`
	// ProductID + the name/price snapshots. ProductID feeds the per-user
	// limit COUNT; the snapshot columns feed every render, forever.
	ProductID   uint64 `gorm:"column:product_id;not null"`
	ProductName string `gorm:"column:product_name;type:varchar(128);not null"`
	PointsCost  int    `gorm:"column:points_cost;not null"`
	// IdempotencyKey is client-supplied; UNIQUE(user_id, idempotency_key)
	// makes one key exactly one order (#850 resolution).
	IdempotencyKey string `gorm:"column:idempotency_key;type:varchar(64);not null;uniqueIndex:uk_point_redemptions_user_idem,priority:2"`

	// Receiver snapshot, redundant from the address book (six columns per the
	// #850 resolution): editing or deleting the address never rewrites history.
	ReceiverName  string `gorm:"column:receiver_name;type:varchar(64);not null"`
	ReceiverPhone string `gorm:"column:receiver_phone;type:varchar(32);not null"`
	Province      string `gorm:"column:province;type:varchar(32);not null"`
	City          string `gorm:"column:city;type:varchar(32);not null"`
	District      string `gorm:"column:district;type:varchar(32);not null"`
	AddressDetail string `gorm:"column:address_detail;type:varchar(255);not null"`

	Status string `gorm:"column:status;type:varchar(16);not null;default:pending_shipment;index:idx_point_redemptions_status,priority:1"`
	// TrackingNo + ShippedAt arrive together at the terminal ship transition.
	TrackingNo *string    `gorm:"column:tracking_no;type:varchar(64)"`
	ShippedAt  *time.Time `gorm:"column:shipped_at;type:datetime(6)"`

	CreatedAt time.Time `gorm:"column:created_at;type:datetime(6);autoCreateTime:false;index:idx_point_redemptions_status,priority:2"`
}

func (PointRedemption) TableName() string { return "point_redemptions" }

// Fulfillment states. shipped is terminal — the row never leaves it (#849).
const (
	RedemptionStatusPendingShipment = "pending_shipment"
	RedemptionStatusShipped         = "shipped"
)

// IsRedemptionStatus reports whether s is a storable redemption status.
func IsRedemptionStatus(s string) bool {
	return s == RedemptionStatusPendingShipment || s == RedemptionStatusShipped
}
